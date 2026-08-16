/**
 * dsh-bio-genie — Python 环境运行时（合并版引导器）
 *
 * 策略：零依赖自举。不假设系统有任何 Python/uv，需要时直接下载到插件私有
 * 目录（$DSH_HOME/dsh-bio-genie/），与系统环境完全隔离：
 *
 *   $DSH_HOME/dsh-bio-genie/
 *     bin/uv.exe                下载的 uv（网络自动适配：官方 GitHub 失败自动切清华 PyPI）
 *     python/                   uv 托管的CPython（--install-dir，失败自动切 npmmirror 镜像）
 *     venv/                     venv（biopython + numpy，PyPI 失败自动切清华镜像）
 *     state.json                引导状态
 *
 * 若 config.pythonEnvDir 显式指定，则改用该目录（兼容 workbuddy 的配置语义）。
 * 引导幂等 + 进程内锁防并发；失败会在下次调用时重试。
 *
 * @module dsh-bio-genie/runtime
 */
import { spawn, spawnSync } from 'node:child_process'
import { constants as fsConstants, existsSync, mkdirSync, accessSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import os from 'node:os'

/** Absolute path to the installed plugin root (parent of this src/ dir). */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Directory holding the bundled Python payload (bridge.py, bio_ops.py). */
export const PYTHON_DIR = join(PLUGIN_ROOT, 'python')

const UV_VERSION_TAG = '0.7.5'

/**
 * 国内镜像默认值（网络自动适配）：
 *  - uv 二进制：官方 GitHub 失败后从清华 PyPI 的 uv wheel 提取（实测 18MB/1.8s）
 *  - CPython：uv 官方变量 UV_PYTHON_INSTALL_MIRROR → npmmirror 的 python-build-standalone
 *  - PyPI 包：UV_DEFAULT_INDEX → 清华 PyPI
 * 用户可用环境变量覆盖：DSH_BIO_UV_BASE / DSH_BIO_PYTHON_MIRROR / DSH_BIO_PYPI_INDEX
 * （同时尊重 uv 官方变量 UV_PYTHON_INSTALL_MIRROR / UV_DEFAULT_INDEX / UV_INDEX_URL）。
 */
const MIRROR_PYPI = 'https://pypi.tuna.tsinghua.edu.cn/simple'
const MIRROR_PYTHON = 'https://registry.npmmirror.com/-/binary/python-build-standalone'
const DOWNLOAD_TIMEOUT_MS = 60_000
const WHEEL_TIMEOUT_MS = 120_000

/** dsh-bio-genie 私有根目录（默认 $DSH_HOME/dsh-bio-genie）。 */
export function bioRoot() {
  const dshHome = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
  return join(dshHome, 'dsh-bio-genie')
}

/** uv 二进制下载 URL（支持 DSH_BIO_UV_BASE 镜像前缀替换）。 */
export function uvDownloadUrl() {
  const base = process.env.DSH_BIO_UV_BASE ?? `https://github.com/astral-sh/uv/releases/download/${UV_VERSION_TAG}`
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  switch (process.platform) {
    case 'win32': return `${base}/uv-${arch}-pc-windows-msvc.zip`
    case 'darwin': return `${base}/uv-${arch}-apple-darwin.tar.gz`
    case 'linux': return `${base}/uv-${arch}-unknown-linux-gnu.tar.gz`
    default: throw new Error(`unsupported platform: ${process.platform}`)
  }
}

/** 用户显式指定的 uv 镜像时返回 true（此时只用用户源，不做自动 fallback）。 */
function uvUserMirrorSet() {
  return Boolean(process.env.DSH_BIO_UV_BASE)
}

/** CPython 下载镜像 env（用户显式设置则返回，否则 undefined = 走官方+自动 fallback）。 */
function pythonMirrorEnv() {
  const v = process.env.DSH_BIO_PYTHON_MIRROR ?? process.env.UV_PYTHON_INSTALL_MIRROR
  return v ? { UV_PYTHON_INSTALL_MIRROR: v } : undefined
}

/** PyPI 索引 env（用户显式设置则返回，否则 undefined = 走官方+自动 fallback）。 */
function pypiMirrorEnv() {
  const v = process.env.DSH_BIO_PYPI_INDEX ?? process.env.UV_DEFAULT_INDEX ?? process.env.UV_INDEX_URL
  return v ? { UV_DEFAULT_INDEX: v } : undefined
}

async function fetchText(url, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url}`)
  return res.text()
}

async function download(url, dest, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`)
  if (!res.body) throw new Error(`no body: ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

/** PyPI uv wheel 的平台 tag（uv 发布 all-platform wheels）。 */
function uvWheelTag() {
  switch (process.platform) {
    case 'win32': return process.arch === 'arm64' ? 'win_arm64' : 'win_amd64'
    case 'darwin': return process.arch === 'arm64' ? 'macosx_11_0_arm64' : 'macosx_10_12_x86_64'
    case 'linux': return process.arch === 'arm64' ? 'manylinux_2_17_aarch64' : 'manylinux_2_17_x86_64'
    default: return process.arch === 'arm64' ? 'win_arm64' : 'win_amd64'
  }
}

/**
 * 从清华 PyPI 下载 uv wheel 并提取 uv 可执行文件到 dest。
 * wheel 是 zip/tar 容器，内部布局 <pkg>-<ver>.data/scripts/uv[.exe]，无需 Python。
 */
async function downloadUvViaPypiMirror(dest) {
  const page = await fetchText('https://pypi.tuna.tsinghua.edu.cn/simple/uv/', 30_000)
  const re = new RegExp(`href="([^"]*uv-${UV_VERSION_TAG}-py3-none-${uvWheelTag()}\\.whl[^"]*)"`)
  const m = page.match(re)
  if (!m) throw new Error(`uv ${UV_VERSION_TAG} wheel (${uvWheelTag()}) not found on tsinghua mirror`)
  const url = 'https://pypi.tuna.tsinghua.edu.cn/' + m[1].split('#')[0].replace(/^\.\.\/\.\.\//, '')
  await download(url, dest, WHEEL_TIMEOUT_MS)
}

/** 下载 uv 二进制（官方 GitHub → 失败自动切清华 PyPI；DSH_BIO_UV_BASE 显式设置时只用用户源）。 */
async function downloadUvBinary(root, logs) {
  const uv = uvBinary()
  if (existsSync(uv)) return
  const extractDir = join(root, 'bin', 'uv-extract')
  const url = uvDownloadUrl()
  const officialTmp = join(root, 'bin', url.endsWith('.zip') ? 'uv-download.zip' : 'uv-download.tar.gz')
  if (uvUserMirrorSet()) {
    await download(url, officialTmp)
    logs.push(`[bootstrap] uv: 用户镜像 ${url}`)
    extractArchive(officialTmp, extractDir)
  } else {
    try {
      await download(url, officialTmp)
      logs.push('[bootstrap] uv: 官方 GitHub 下载成功')
      extractArchive(officialTmp, extractDir)
    } catch (err) {
      logs.push(`[bootstrap] uv: GitHub 直连失败（${err.message}），自动切换清华 PyPI 镜像`)
      const whlTmp = join(root, 'bin', 'uv-download.whl')
      await downloadUvViaPypiMirror(whlTmp)
      extractArchive(whlTmp, extractDir)
      rmSync(whlTmp, { force: true })
    }
  }
  const candidates = [
    join(extractDir, process.platform === 'win32' ? 'uv.exe' : 'uv'),
    join(extractDir, `uv-${process.platform}`, process.platform === 'win32' ? 'uv.exe' : 'uv'),
    join(extractDir, `uv-${UV_VERSION_TAG}.data`, 'scripts', 'uv.exe'),
  ]
  const found = candidates.find((c) => existsSync(c))
  if (!found) throw new Error('uv binary not found after extraction')
  renameSync(found, uv)
  rmSync(officialTmp, { force: true })
  rmSync(extractDir, { recursive: true, force: true })
}

function statePath() {
  return join(bioRoot(), 'state.json')
}

function uvBinary() {
  const root = bioRoot()
  return process.platform === 'win32' ? join(root, 'bin', 'uv.exe') : join(root, 'bin', 'uv')
}

/** venv python 路径。 */
export function venvPython(envDir = join(bioRoot(), 'venv')) {
  return process.platform === 'win32'
    ? join(envDir, 'Scripts', 'python.exe')
    : join(envDir, 'bin', 'python')
}

function isWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 解析环境目录（优先级）：
 *   1. config.pythonEnvDir（用户显式指定）
 *   2. $DSH_HOME/dsh-bio-genie/python-env（默认：插件私有目录，与插件本体分离，
 *      升级/重装插件不会丢失环境）
 * 刻意不用 <插件目录>/python-env —— npm 升级会覆盖 node_modules 里的环境。
 */
export function resolveEnvDir(configured) {
  if (configured) return resolve(configured)
  const dshHome = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
  return join(dshHome, 'dsh-bio-genie', 'python-env')
}

function run(cmd, args, { cwd, timeoutMs = 300_000, env } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', cwd, timeout: timeoutMs, windowsHide: true,
    env: env ? { ...process.env, ...env } : undefined,
  })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function extractArchive(archive, destDir) {
  if (archive.endsWith('.zip') || archive.endsWith('.whl')) {
    // zip 容器（含 PyPI wheel）：Windows 用 .NET ZipFile（不挑扩展名），POSIX 用 unzip
    if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `if (Test-Path '${destDir}') { Remove-Item '${destDir}' -Recurse -Force }`,
        `[System.IO.Compression.ZipFile]::ExtractToDirectory('${archive}', '${destDir}')`,
      ].join('; ')
      const r = run('powershell', ['-NoProfile', '-Command', ps], { timeoutMs: 120_000 })
      if (r.code !== 0) throw new Error(`unzip failed: ${r.stderr}`)
    } else {
      const r = run('unzip', ['-q', '-o', archive, '-d', destDir], { timeoutMs: 120_000 })
      if (r.code !== 0) throw new Error(`unzip failed: ${r.stderr}`)
    }
  } else {
    const r = run('tar', ['-xzf', archive, '-C', destDir], { timeoutMs: 120_000 })
    if (r.code !== 0) throw new Error(`untar failed: ${r.stderr}`)
  }
}

/** 在 uv 托管目录下查找 python 可执行文件（深度限制避开内部副本）。 */
function findManagedPython(pyDir) {
  const walk = (dir, depth) => {
    let entries
    try { entries = readdirSync(dir) } catch { return null }
    for (const entry of entries) {
      const full = join(dir, entry)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (depth >= 3) continue
        const found = walk(full, depth + 1)
        if (found) return found
      } else {
        const base = entry.toLowerCase()
        if (base === 'python.exe' || base === 'python3' || base === 'python3.12' || base === 'python') {
          return full
        }
      }
    }
    return null
  }
  return walk(pyDir, 1)
}

/** 查询解释器元数据（python 版本 / biopython / numpy）。 */
async function inspect(exe) {
  const probe = [
    'import json, sys',
    'try:\n    import Bio\n    bv = Bio.__version__\n' + 'except Exception:\n    bv = None',
    'try:\n    import numpy\n    nv = numpy.__version__\n' + 'except Exception:\n    nv = None',
    'print(json.dumps({"pythonVersion": sys.version.split()[0], "biopython": bv, "numpy": nv}))',
  ].join('\n')
  const { code, stdout } = await run(exe, ['-I', '-c', probe])
  if (code !== 0) return { pythonVersion: null, biopython: null, numpy: null }
  try {
    return JSON.parse(stdout.trim().split('\n').pop())
  } catch {
    return { pythonVersion: null, biopython: null, numpy: null }
  }
}

/** 完整自举：下载 uv → uv python install → uv venv → uv pip install。 */
async function selfBootstrap(envDir) {
  const root = bioRoot()
  const req = join(PYTHON_DIR, 'requirements.txt')
  const logs = []
  mkdirSync(join(root, 'bin'), { recursive: true })

  // 1. uv 二进制（官方 GitHub → 失败自动切清华 PyPI 镜像）
  await downloadUvBinary(root, logs)
  const uv = uvBinary()

  // 2. uv python install（托管到私有目录；官方源失败自动切 npmmirror 镜像）
  const pyDir = join(root, 'python')
  const pyMirror = pythonMirrorEnv()
  let r = run(uv, ['python', 'install', '3.12', '--install-dir', pyDir], pyMirror ? { env: pyMirror } : {})
  if (r.code !== 0 && !pyMirror) {
    logs.push(`[bootstrap] python: 官方源失败（${r.stderr.slice(0, 200)}），自动切换 npmmirror 镜像`)
    r = run(uv, ['python', 'install', '3.12', '--install-dir', pyDir], { env: { UV_PYTHON_INSTALL_MIRROR: MIRROR_PYTHON } })
  }
  if (r.code !== 0) throw new Error(`uv python install failed: ${r.stderr.slice(0, 500)}`)
  const managedPython = findManagedPython(pyDir)
  if (!managedPython) throw new Error('managed python not found after uv install')

  // 3. uv venv（指定完整解释器路径，确保用私有目录里的）
  r = run(uv, ['venv', envDir, '--python', managedPython])
  if (r.code !== 0) throw new Error(`uv venv failed: ${r.stderr.slice(0, 500)}`)

  // 4. uv pip install biopython numpy（官方 PyPI 失败自动切清华镜像）
  const exe = venvPython(envDir)
  const pipMirror = pypiMirrorEnv()
  r = run(uv, ['pip', 'install', '--python', exe, '-r', req], pipMirror ? { env: pipMirror } : {})
  if (r.code !== 0 && !pipMirror) {
    logs.push(`[bootstrap] pip: 官方 PyPI 失败（${r.stderr.slice(0, 200)}），自动切换清华镜像`)
    r = run(uv, ['pip', 'install', '--python', exe, '-r', req], { env: { UV_DEFAULT_INDEX: MIRROR_PYPI } })
  }
  if (r.code !== 0) throw new Error(`pip install failed: ${r.stderr.slice(0, 500)}`)

  return logs.join('\n')
}

/** 兜底：系统 python 的 venv + pip（仅当自举失败且系统恰有 python 时）。 */
async function systemPythonBootstrap(envDir) {
  const req = join(PYTHON_DIR, 'requirements.txt')
  const logs = []
  for (const cand of ['python3', 'python']) {
    const { code } = await run(cand, ['--version'])
    if (code === 0) {
      let r = await run(cand, ['-m', 'venv', envDir])
      if (r.code !== 0) continue
      const exe = venvPython(envDir)
      r = await run(exe, ['-m', 'pip', 'install', '--upgrade', 'pip'])
      const pipMirror = pypiMirrorEnv()
      const pipIndexArgs = pipMirror ? ['--index-url', pipMirror.UV_DEFAULT_INDEX] : []
      r = await run(exe, ['-m', 'pip', 'install', ...pipIndexArgs, '-r', req])
      if (r.code !== 0 && !pipMirror) {
        logs.push(`[bootstrap] pip: 官方 PyPI 失败（${r.stderr.slice(0, 200)}），自动切换清华镜像`)
        r = await run(exe, ['-m', 'pip', 'install', '--index-url', MIRROR_PYPI, '-r', req])
      }
      if (r.code !== 0) throw new Error(`pip install failed: ${r.stderr.slice(0, 500)}`)
      logs.push(`[bootstrap] used system ${cand}`)
      return logs.join('\n')
    }
  }
  throw new Error('No Python or uv available for bootstrap. Install Python 3.9+ or uv, or set pythonEnvDir.')
}

// 进程内锁：同一时刻只跑一个引导流程
let bootstrapLock = Promise.resolve()

/**
 * 确保环境就绪（幂等）。首次调用执行完整自举，可能耗时数分钟。
 * @param {object} config - 插件配置
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<object>} {ready, python, pythonVersion, biopython, numpy, envDir, bootstrapped, error?, logs?}
 */
export async function ensureEnvironment(config, { force = false } = {}) {
  const envDir = resolveEnvDir(config.pythonEnvDir)
  const exe = venvPython(envDir)

  const attempt = async () => {
    if (!force && existsSync(exe)) {
      const meta = await inspect(exe)
      if (meta.biopython) {
        return { ready: true, python: exe, envDir, ...meta, bootstrapped: false }
      }
    }
    let logs = ''
    let ok = false
    try {
      logs = await selfBootstrap(envDir)
      ok = true
    } catch (err) {
      logs += `\n[selfBootstrap failed: ${err.message}]\n`
      try {
        logs += await systemPythonBootstrap(envDir)
        ok = true
      } catch (err2) {
        logs += `\n[systemPythonBootstrap failed: ${err2.message}]`
      }
    }
    if (!ok) {
      return { ready: false, python: exe, envDir, bootstrapped: false, error: logs.slice(-1000) }
    }
    const meta = await inspect(exe)
    if (!meta.biopython) {
      return { ready: false, python: exe, envDir, bootstrapped: true, error: `bootstrap completed but biopython missing:\n${logs}` }
    }
    return { ready: true, python: exe, envDir, ...meta, bootstrapped: true, logs }
  }

  bootstrapLock = bootstrapLock.then(attempt, attempt)
  return bootstrapLock
}

/** 同步探测 venv python 是否存在。 */
export function bioEnvExists(config) {
  return existsSync(venvPython(resolveEnvDir(config.pythonEnvDir)))
}
