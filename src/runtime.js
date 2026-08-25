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
import { createHash } from 'node:crypto'
import { constants as fsConstants, existsSync, mkdirSync, accessSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs'
import { createReadStream, createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import os from 'node:os'
import { EXTRA_DEPS, EXTRA_IMPORT_NAMES, EXTRA_NO_DEPS, ADDON_MODULES } from './extra-deps.js'

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
/**
 * GitHub 官方通道单请求超时（仅自动 fallback 模式）：中国网络下 GitHub 直连
 * 多为「挂起」而非快速失败，10s 即切镜像，避免首次引导白等 60s。
 * 用户显式设置 DSH_BIO_UV_BASE 时不受此限（用户镜像不自动 fallback，沿用 60s）。
 */
const GITHUB_OFFICIAL_TIMEOUT_MS = 10_000

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

/** 流式计算文件 SHA256（不把文件读进内存，兼容 GB 级场景）。 */
export async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** 校验文件 SHA256 与期望值一致，不一致抛错（拒绝执行未校验二进制）。 */
export async function verifySha256(file, expectedHex) {
  const expected = String(expectedHex).trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`invalid sha256 value for ${file}: ${expectedHex}`)
  }
  const actual = await sha256File(file)
  if (actual !== expected) {
    throw new Error(`SHA256 mismatch for ${file}: expected ${expected}, got ${actual}`)
  }
}

/**
 * 从 sha256sums 文本中查找指定文件名的哈希。
 * 兼容 `hash  file`（GNU 双空格）、`hash *file`（binary 标记星号，uv 官方
 * per-asset .sha256 文件即此格式）与纯哈希单行（部分 per-asset 文件只含哈希）。
 */
function findChecksum(sumsText, filename) {
  for (const line of sumsText.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && (parts[1] === filename || parts[1] === `*${filename}`)) return parts[0]
    if (parts.length === 1 && /^[0-9a-f]{64}$/i.test(parts[0])) return parts[0]
  }
  throw new Error(`checksum entry not found for ${filename}`)
}

/**
 * 按下载 URL 获取校验值并校验已下载文件。两条来源按序尝试：
 *   1. `<url>.sha256` —— uv 官方 per-asset 格式（GitHub release 无 sha256sums.txt）
 *   2. `<base>/sha256sums.txt` —— 自定义镜像常用的 GNU 汇总格式
 * 校验文件缺失/获取失败一律拒绝执行——uv 是信任根，宁可不引导也不跑未校验二进制。
 */
async function verifyFromReleaseChecksums(url, file) {
  const base = url.slice(0, url.lastIndexOf('/'))
  const filename = url.slice(url.lastIndexOf('/') + 1)
  const sources = [
    { name: `${filename}.sha256`, fetchUrl: `${url}.sha256` },
    { name: 'sha256sums.txt', fetchUrl: `${base}/sha256sums.txt` },
  ]
  let lastErr
  for (const src of sources) {
    let sumsText
    try {
      // 二进制下载已成功（GitHub 响应正常），校验文件 15s 足够；挂起则快速放弃
      sumsText = await fetchText(src.fetchUrl, 15_000)
    } catch (err) {
      lastErr = err
      continue
    }
    try {
      const expected = findChecksum(sumsText, filename)
      await verifySha256(file, expected)
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `checksum file unavailable (${url}.sha256 / ${base}/sha256sums.txt): ${lastErr?.message ?? 'unknown'}. ` +
    'Refusing to run unverified uv binary; provide a checksum on your mirror or use the official source.')
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
 * PEP 503 simple index 的 href 带 #sha256= 碎片，下载后必须校验，缺失则拒绝。
 */
async function downloadUvViaPypiMirror(dest) {
  const page = await fetchText('https://pypi.tuna.tsinghua.edu.cn/simple/uv/', 30_000)
  const re = new RegExp(`href="([^"]*uv-${UV_VERSION_TAG}-py3-none-${uvWheelTag()}\\.whl[^"]*)"`)
  const m = page.match(re)
  if (!m) throw new Error(`uv ${UV_VERSION_TAG} wheel (${uvWheelTag()}) not found on tsinghua mirror`)
  const [hrefPath, hashPart] = m[1].split('#')
  const sha = hashPart && hashPart.startsWith('sha256=') ? hashPart.slice('sha256='.length) : null
  if (!sha) {
    throw new Error('tsinghua mirror wheel link missing sha256 fragment (PEP 503) — refusing unverified download')
  }
  const url = 'https://pypi.tuna.tsinghua.edu.cn/' + hrefPath.replace(/^\.\.\/\.\.\//, '')
  await download(url, dest, WHEEL_TIMEOUT_MS)
  await verifySha256(dest, sha)
}

/** 下载 uv 二进制（官方 GitHub → 失败自动切清华 PyPI；DSH_BIO_UV_BASE 显式设置时只用用户源）。下载后一律做 SHA256 校验。 */
export async function downloadUvBinary(root, logs) {
  const uv = uvBinary()
  if (existsSync(uv)) return
  const extractDir = join(root, 'bin', 'uv-extract')
  // 自建 bin 目录：selfBootstrap 会先 mkdir，但单独调用（测试/复用）也应自洽
  mkdirSync(join(root, 'bin'), { recursive: true })
  const url = uvDownloadUrl()
  const officialTmp = join(root, 'bin', url.endsWith('.zip') ? 'uv-download.zip' : 'uv-download.tar.gz')
  if (uvUserMirrorSet()) {
    await download(url, officialTmp)
    logs.push(`[bootstrap] uv: 用户镜像 ${url}`)
    // 用户镜像同样要求 sha256sums.txt（放在镜像 release 根目录），缺失即拒绝
    await verifyFromReleaseChecksums(url, officialTmp)
    extractArchive(officialTmp, extractDir)
  } else {
    let downloaded = false
    try {
      // 官方 GitHub 通道限 10s：挂起即快速失败切镜像（见 GITHUB_OFFICIAL_TIMEOUT_MS）
      await download(url, officialTmp, GITHUB_OFFICIAL_TIMEOUT_MS)
      downloaded = true
      logs.push('[bootstrap] uv: 官方 GitHub 下载成功')
    } catch (err) {
      // 下载阶段失败（网络/超时）——官方通道不可用，自动切换清华 PyPI 镜像
      logs.push(`[bootstrap] uv: GitHub 直连下载失败（${err.message}），自动切换清华 PyPI 镜像`)
      const whlTmp = join(root, 'bin', 'uv-download.whl')
      await downloadUvViaPypiMirror(whlTmp)
      extractArchive(whlTmp, extractDir)
      rmSync(whlTmp, { force: true })
    }
    if (downloaded) {
      try {
        // 下载成功后的校验/解压：这一阶段的失败是供应链信号（校验 mismatch / 损坏包），
        // 与网络失败性质不同——单独记录，不并入「GitHub 直连失败」文案
        await verifyFromReleaseChecksums(url, officialTmp)
        extractArchive(officialTmp, extractDir)
      } catch (err) {
        logs.push(`[bootstrap] uv: GitHub 文件校验/解压失败（${err.message}），拒绝使用并切换清华 PyPI 镜像`)
        const whlTmp = join(root, 'bin', 'uv-download.whl')
        await downloadUvViaPypiMirror(whlTmp)
        extractArchive(whlTmp, extractDir)
        rmSync(whlTmp, { force: true })
      }
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

/** requirements.txt 中除 biopython/numpy 外必须可导入的包（环境完整性判断）。 */
const REQUIRED_PACKAGES = ['matplotlib', 'pandas', 'seaborn', 'scipy', 'PIL',
  'primer3', 'dna_features_viewer', 'dnachisel']

/** 查询解释器元数据（python 版本 / 核心库 / 绘图栈）。 */
async function inspect(exe) {
  const NL = String.fromCharCode(10)
  const probe = [
    'import json, sys',
    'def _ver(name):',
    '    try:',
    '        m = __import__(name)',
    '    except Exception:',
    '        return None',
    '    return getattr(m, "__version__", None)',
    'info = {"pythonVersion": sys.version.split()[0],',
    '        "biopython": _ver("Bio"), "numpy": _ver("numpy"),',
    '        "matplotlib": _ver("matplotlib"),',
    '        "packages": {"matplotlib": _ver("matplotlib"), "pandas": _ver("pandas"),',
    '                     "seaborn": _ver("seaborn"), "scipy": _ver("scipy"), "PIL": _ver("PIL"),',
    '                     "primer3": _ver("primer3"), "dna_features_viewer": _ver("dna_features_viewer"),',
    '                     "dnachisel": _ver("dnachisel")}}',
    'print(json.dumps(info))',
  ].join(NL)
  const { code, stdout } = await run(exe, ['-I', '-c', probe])
  const empty = () => ({ pythonVersion: null, biopython: null, numpy: null, matplotlib: null, packages: {} })
  if (code !== 0) return empty()
  try {
    return JSON.parse(stdout.trim().split(NL).pop())
  } catch {
    return empty()
  }
}

/**
 * 轻量补装：requirements 更新（如新增绘图依赖）后，已存在的旧 venv 会缺包。
 * 用已下载的 uv 直接 pip install -r requirements.txt 补齐（幂等、不重建 venv），
 * 让升级插件的存量用户在首次调用时无感自愈，而不是等到绘图 op 报 ModuleNotFoundError。
 */
async function repairPackages(exe, missing) {
  const logs = []
  const uv = uvBinary()
  if (!existsSync(uv)) {
    logs.push('[repair] uv 二进制不存在，无法轻量补装（将走完整自举）')
    return { logs: logs.join(String.fromCharCode(10)), ok: false }
  }
  const req = join(PYTHON_DIR, 'requirements.txt')
  logs.push(`[repair] 环境缺少 ${missing.join(', ')}，uv pip 补装 requirements`)
  const pipMirror = pypiMirrorEnv()
  let r = run(uv, ['pip', 'install', '--python', exe, '-r', req], pipMirror ? { env: pipMirror } : {})
  if (r.code !== 0 && !pipMirror) {
    logs.push(`[repair] 官方 PyPI 失败（${r.stderr.slice(0, 200)}），自动切换清华镜像`)
    r = run(uv, ['pip', 'install', '--python', exe, '-r', req], { env: { UV_DEFAULT_INDEX: MIRROR_PYPI } })
  }
  if (r.code !== 0) {
    logs.push(`[repair] 补装失败: ${r.stderr.slice(0, 300)}`)
    return { logs: logs.join(String.fromCharCode(10)), ok: false }
  }
  logs.push('[repair] 补装完成')
  return { logs: logs.join(String.fromCharCode(10)), ok: true }
}

/**
 * 第二层按需依赖（src/extra-deps.js 的 EXTRA_DEPS）：op 首次调用前检测
 * 其声明的额外包是否可 import，缺失则用已下载的 uv 就地补装（幂等、镜像回退）。
 * 返回 { ok, missing[], installed[], error? }；op 无额外依赖时直接 ok。
 */
export async function ensureExtraDeps(op, exe, { timeoutMs = 600_000 } = {}) {
  const extra = EXTRA_DEPS[op]
  if (!extra || extra.length === 0) return { ok: true, missing: [], installed: [] }
  const missing = []
  for (const pkg of extra) {
    const mod = EXTRA_IMPORT_NAMES[pkg] ?? pkg.replace(/-/g, '_')
    const probe = run(exe, ['-I', '-c', `import ${mod}`], { timeoutMs: 60_000 })
    if (probe.code !== 0) missing.push(pkg)
  }
  if (missing.length === 0) return { ok: true, missing: [], installed: [] }
  const uv = uvBinary()
  if (!existsSync(uv)) {
    return { ok: false, missing, installed: [], error: `uv 二进制不存在，无法自动补装 ${missing.join(', ')}` }
  }
  const pipMirror = pypiMirrorEnv()
  const errors = []
  const installed = []
  // 逐包安装：个别包需 --no-deps（EXTRA_NO_DEPS，如 biocrnpyler 的 fa2-modified
  // 无 Windows wheel），整批安装会让可装包被不可装包拖死
  for (const pkg of missing) {
    const baseArgs = ['pip', 'install', '--python', exe, ...(EXTRA_NO_DEPS.has(pkg) ? ['--no-deps'] : []), pkg]
    let r = run(uv, baseArgs, { timeoutMs, ...(pipMirror ? { env: pipMirror } : {}) })
    if (r.code !== 0 && !pipMirror) {
      r = run(uv, baseArgs, { timeoutMs, env: { UV_DEFAULT_INDEX: MIRROR_PYPI } })
    }
    if (r.code !== 0) {
      errors.push(`${pkg}: ${r.stderr.slice(0, 200)}`)
    } else {
      installed.push(pkg)
    }
  }
  if (errors.length > 0) {
    return { ok: false, missing, installed, error: `自动安装失败: ${errors.join(' | ')}` }
  }
  return { ok: true, missing, installed }
}

/**
 * 批量探测 ADDON_MODULES 全部模块的安装状态：单次 Python 子进程用
 * importlib.metadata 枚举 site-packages 已装发行版元数据（与 uv/pip 的
 * 「已安装」同口径），不真正 import 目标模块。旧实现逐包 spawnSync
 * `import X`（4 模块 12 包 = 12 次解释器冷启动 + bokeh/biocrnpyler 等
 * 重模块的真实导入），设置面板每次打开 >5s；元数据枚举实测 <0.3s，
 * 且语义更准（import 失败可能只是模块自身损坏，不代表未安装）。
 * 返回 { [moduleKey]: { installed, packages: [{package, installed}] } }。
 */
export function addonsStatus(exe) {
  // PEP 503 规范化（小写、[-_.] 归一为 -），两侧同规则比较
  const norm = (name) => name.toLowerCase().replace(/[-_.]+/g, '-').replace(/^-+|-+$/g, '')
  const baseName = (pkg) => pkg.split('>')[0].split('<')[0].split('=')[0].trim()
  const script = [
    'from importlib.metadata import distributions',
    'import json',
    'print(json.dumps([(d.metadata.get("Name") or "") for d in distributions()]))',
  ].join(String.fromCharCode(10))
  const r = run(exe, ['-I', '-c', script], { timeoutMs: 120_000 })
  const installedSet = new Set()
  if (r.code === 0) {
    try {
      for (const name of JSON.parse(r.stdout.trim())) {
        if (name) installedSet.add(norm(String(name)))
      }
    } catch { /* 输出异常按全未安装处理，面板仍可展示/安装 */ }
  }
  const out = {}
  for (const [key, mod] of Object.entries(ADDON_MODULES)) {
    const packages = mod.packages.map((pkg) => ({
      package: pkg,
      installed: installedSet.has(norm(baseName(pkg))),
    }))
    out[key] = { installed: packages.every((p) => p.installed), packages }
  }
  return out
}

/**
 * 第三层扩展模块（ADDON_MODULES）管理：设置面板/手动触发。
 * action: 'status' | 'install' | 'uninstall'
 */
export async function manageAddon(moduleKey, action, exe, { timeoutMs = 900_000 } = {}) {
  const mod = ADDON_MODULES[moduleKey]
  if (!mod) return { ok: false, error: `未知模块: ${moduleKey}` }

  if (action === 'status') {
    return { ok: true, module: moduleKey, ...addonsStatus(exe)[moduleKey] }
  }

  const uv = uvBinary()
  if (!existsSync(uv)) return { ok: false, error: 'uv 二进制不存在' }
  const pipMirror = pypiMirrorEnv()
  const uvRun = (args) => {
    let r = run(uv, args, { timeoutMs, ...(pipMirror ? { env: pipMirror } : {}) })
    if (r.code !== 0 && !pipMirror) {
      r = run(uv, args, { timeoutMs, env: { UV_DEFAULT_INDEX: MIRROR_PYPI } })
    }
    return r
  }

  if (action === 'install') {
    const errors = []
    for (const pkg of mod.packages) {
      const args = ['pip', 'install', '--python', exe, ...(EXTRA_NO_DEPS.has(pkg) ? ['--no-deps'] : []), pkg]
      const r = uvRun(args)
      if (r.code !== 0) errors.push(`${pkg}: ${r.stderr.slice(0, 200)}`)
    }
    const check = addonsStatus(exe)[moduleKey]
    return {
      ok: errors.length === 0 && check.installed, module: moduleKey, installed: check.installed,
      packages: check.packages, ...(errors.length ? { error: errors.join(' | ') } : {}),
    }
  }

  if (action === 'uninstall') {
    const r = uvRun(['pip', 'uninstall', '--python', exe, ...mod.packages])
    return { ok: r.code === 0, module: moduleKey, installed: false,
             ...(r.code !== 0 ? { error: r.stderr.slice(0, 300) } : {}) }
  }

  return { ok: false, error: `未知 action: ${action}（支持 status/install/uninstall）` }
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

  // 3. uv venv（指定完整解释器路径，确保用私有目录里的；--seed 预装 pip/setuptools/wheel，
  //    否则 venv 无 pip——agent 想补装包时只能 ensurepip 绕路，2026-08-17 实战测试发现）
  r = run(uv, ['venv', envDir, '--python', managedPython, '--seed'])
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

// 进程内环境元数据缓存：inspect 需要 import 整个绘图栈（matplotlib/pandas/scipy
// 约 4-6s）。每次工具调用都 spawn 探测会拖慢所有语义化工具与 bio_python，
// 故首次探测成功后缓存，同进程后续调用直接复用（环境变更走 force/reinstall）。
let cachedMeta = null
let cachedEnvDir = null

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
    let repairLogs = ''
    if (!force && cachedMeta && cachedEnvDir === envDir) {
      return {
        ready: true, python: exe, envDir,
        pythonVersion: cachedMeta.pythonVersion, biopython: cachedMeta.biopython, numpy: cachedMeta.numpy,
        bootstrapped: false,
      }
    }
    if (!force && existsSync(exe)) {
      const meta = await inspect(exe)
      if (meta.biopython) {
        // 轻量补装：requirements 更新后旧环境缺包（如新增绘图栈）时，
        // 用 uv 补装而非重建 venv；补装失败再走完整自举兜底。
        const missing = REQUIRED_PACKAGES.filter((p) => !meta.packages?.[p])
        if (missing.length) {
          const repair = await repairPackages(exe, missing)
          const meta2 = await inspect(exe)
          if (repair.ok && missing.every((p) => meta2.packages?.[p])) {
            cachedMeta = meta2
            cachedEnvDir = envDir
            return {
              ready: true, python: exe, envDir,
              pythonVersion: meta2.pythonVersion, biopython: meta2.biopython, numpy: meta2.numpy,
              bootstrapped: false,
            }
          }
          repairLogs = repair.logs
        } else {
          cachedMeta = meta
          cachedEnvDir = envDir
          // 显式字段返回：bio_env 输出 schema 是 additionalProperties:false，
          // 不能像旧代码那样 ...meta 展开（inspect 现在多了 matplotlib/packages 字段）
          return {
            ready: true, python: exe, envDir,
            pythonVersion: meta.pythonVersion, biopython: meta.biopython, numpy: meta.numpy,
            bootstrapped: false,
          }
        }
      }
    }
    let logs = repairLogs
    let ok = false
    try {
      logs += await selfBootstrap(envDir)
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
    cachedMeta = meta
    cachedEnvDir = envDir
    // 显式字段：避免把 inspect 的 matplotlib/packages 泄漏进 bio_env 严格 schema
    return {
      ready: true, python: exe, envDir,
      pythonVersion: meta.pythonVersion, biopython: meta.biopython, numpy: meta.numpy,
      bootstrapped: true, logs,
    }
  }

  bootstrapLock = bootstrapLock.then(attempt, attempt)
  return bootstrapLock
}

/** 同步探测 venv python 是否存在。 */
export function bioEnvExists(config) {
  return existsSync(venvPython(resolveEnvDir(config.pythonEnvDir)))
}
