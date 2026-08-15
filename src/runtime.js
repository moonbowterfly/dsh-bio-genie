/**
 * dsh-bio-genie — Python 环境运行时（合并版引导器）
 *
 * 策略：零依赖自举。不假设系统有任何 Python/uv，需要时直接下载到插件私有
 * 目录（$DSH_HOME/dsh-bio-genie/），与系统环境完全隔离：
 *
 *   $DSH_HOME/dsh-bio-genie/
 *     bin/uv.exe                下载的 uv（按平台，可用 DSH_BIO_UV_BASE 镜像加速）
 *     python/                   uv 托管的 CPython（--install-dir）
 *     venv/                     venv（biopython + numpy）
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

/** dsh-bio-genie 私有根目录（默认 $DSH_HOME/dsh-bio-genie）。 */
export function bioRoot() {
  const dshHome = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
  return join(dshHome, 'dsh-bio-genie')
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
 * 解析环境目录：config.pythonEnvDir → 插件内 python-env → $DSH_HOME/dsh-bio-genie/python-env。
 */
export function resolveEnvDir(configured) {
  if (configured) return resolve(configured)
  const bundled = join(PLUGIN_ROOT, 'python-env')
  if (isWritable(bundled)) return bundled
  return join(bioRoot(), 'python-env')
}

/** uv 下载 URL（支持 DSH_BIO_UV_BASE 镜像前缀替换）。 */
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

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`)
  if (!res.body) throw new Error(`no body: ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

function run(cmd, args, { cwd, timeoutMs = 300_000 } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', cwd, timeout: timeoutMs, windowsHide: true,
  })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function extractArchive(archive, destDir) {
  if (archive.endsWith('.zip')) {
    const ps = `Expand-Archive -Path '${archive}' -DestinationPath '${destDir}' -Force`
    const r = run('powershell', ['-NoProfile', '-Command', ps], { timeoutMs: 120_000 })
    if (r.code !== 0) throw new Error(`unzip failed: ${r.stderr}`)
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

  // 1. uv 二进制
  const uv = uvBinary()
  if (!existsSync(uv)) {
    const url = uvDownloadUrl()
    const tmp = join(root, 'bin', `uv-download${url.endsWith('.zip') ? '.zip' : '.tar.gz'}`)
    logs.push(`[bootstrap] downloading uv from ${url}`)
    await download(url, tmp)
    const extractDir = join(root, 'bin', 'uv-extract')
    extractArchive(tmp, extractDir)
    const candidates = [
      join(extractDir, process.platform === 'win32' ? 'uv.exe' : 'uv'),
      join(extractDir, `uv-${process.platform}`, process.platform === 'win32' ? 'uv.exe' : 'uv'),
    ]
    const found = candidates.find((c) => existsSync(c))
    if (!found) throw new Error('uv binary not found after extraction')
    renameSync(found, uv)
    rmSync(tmp, { force: true })
    rmSync(extractDir, { recursive: true, force: true })
  }

  // 2. uv python install（托管到私有目录）
  const pyDir = join(root, 'python')
  let r = run(uv, ['python', 'install', '3.12', '--install-dir', pyDir])
  if (r.code !== 0) throw new Error(`uv python install failed: ${r.stderr.slice(0, 500)}`)
  const managedPython = findManagedPython(pyDir)
  if (!managedPython) throw new Error('managed python not found after uv install')

  // 3. uv venv（指定完整解释器路径，确保用私有目录里的）
  r = run(uv, ['venv', envDir, '--python', managedPython])
  if (r.code !== 0) throw new Error(`uv venv failed: ${r.stderr.slice(0, 500)}`)

  // 4. uv pip install biopython numpy
  const exe = venvPython(envDir)
  r = run(uv, ['pip', 'install', '--python', exe, '-r', req])
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
      r = await run(exe, ['-m', 'pip', 'install', '-r', req])
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
