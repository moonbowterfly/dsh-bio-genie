/**
 * dsh-bio-genie — R 环境运行时（零依赖自举，镜像 runtime.js 的 Python 引导器模型）
 *
 *   $DSH_HOME/dsh-bio-genie/
 *     r/R-4.6.0/          静默安装的 R（官方 CRAN 安装器，失败自动切清华镜像）
 *     r-lib/              私有 R 包库（BiocManager 安装核心包集，官方→清华镜像）
 *
 * 固定版本对：R 4.6.0 ↔ Bioconductor 3.23（见 THIRD_PARTY_NOTICES.md）。
 * 许可模型：所有 R/CRAN/Bioc 软件均运行时从官方仓库下载安装到用户私有目录，
 * 插件仓库只分发包名清单与原创 R 脚本（MIT）——不复制不分发任何第三方源码。
 *
 * 平台边界：引导器当前仅支持 Windows（R 安装器无跨平台静默可移植安装路径）；
 * macOS/Linux 用户可自行安装 R 并配置 config.rscriptPath 指向 Rscript。
 *
 * @module dsh-bio-genie/r-runtime
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createReadStream, createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import os from 'node:os'

/** 插件随包分发的 R payload 目录（r_bridge.R / install_packages.R / requirements-r.txt）。 */
export const PLUGIN_R_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'r')

/** 固定 R 版本（Bioconductor 3.23 配套 R 4.6，锁定不漂移）。 */
export const R_VERSION = '4.6.0'

const CRAN_OFFICIAL = 'https://cran.r-project.org'
const CRAN_MIRROR = 'https://mirrors.tuna.tsinghua.edu.cn/CRAN'
// 实测：清华 Bioconductor 镜像 binary 索引在但 zip 缺失(404)，必须走官方源装二进制
const BIOC_MIRROR = 'https://bioconductor.org'
const USER_BIOC = process.env.DSH_BIO_R_BIOC_BASE || BIOC_MIRROR

const DOWNLOAD_TIMEOUT_MS = 300_000
const INSTALL_TIMEOUT_MS = 900_000
const PACKAGES_TIMEOUT_MS = 2_400_000

/** dsh-bio-genie 私有根目录（同 runtime.js bioRoot）。 */
export function rRoot() {
  const dshHome = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
  return join(dshHome, 'dsh-bio-genie')
}

/** R 安装根目录（$DSH_HOME/dsh-bio-genie/r/）。 */
export function rInstallDir() {
  return join(rRoot(), 'r')
}

/** Rscript 路径：用户显式配置优先，否则插件私有安装。
 *  实测注意：R 安装器直接解压到 /DIR 根（无 R-<ver> 子目录）→ r/bin/Rscript.exe。 */
export function rscriptPath(config = {}) {
  if (config.rscriptPath) return resolve(config.rscriptPath)
  return join(rInstallDir(), 'bin', 'Rscript.exe')
}

/** 私有 R 包库目录。 */
export function rLibDir(config = {}) {
  if (config.rLibDir) return resolve(config.rLibDir)
  return join(rRoot(), 'r-lib')
}

/** 核心包清单（requirements-r.txt 是探测与补装的单一事实源）。 */
export function rCorePackages() {
  const text = readFileSync(join(PLUGIN_R_DIR, 'requirements-r.txt'), 'utf8')
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}

/** R 子进程环境：包库隔离（不读用户 .Rprofile/环境文件，不泄漏宿主库）。 */
export function rSpawnEnv(lib) {
  return {
    ...process.env,
    R_LIBS: lib,
    R_LIBS_USER: lib,
    R_LIBS_SITE: '',
    R_ENVIRON_USER: '',
    R_PROFILE_USER: '',
    PYTHONPATH: '',
  }
}

async function fetchText(url, timeoutMs = 60_000) {
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

function md5File(file) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('md5')
    createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolvePromise(hash.digest('hex')))
      .on('error', rejectPromise)
  })
}

function installerUrl(base) {
  // CRAN 旧版本目录保持稳定：/bin/windows/base/old/<ver>/R-<ver>-win.exe
  return `${base}/bin/windows/base/old/${R_VERSION}/R-${R_VERSION}-win.exe`
}

function md5sumUrl(base) {
  // 注意：CRAN 的校验文件按版本命名 md5sum.R-<ver>.txt（不是 md5sum.txt，两源实测确认）
  return `${base}/bin/windows/base/old/${R_VERSION}/md5sum.R-${R_VERSION}.txt`
}

/** 校验 R 安装器的 MD5（CRAN 官方通道仅提供 MD5；强度弱于 SHA256，如实注释）。 */
async function verifyInstallerMd5(file, base) {
  const sumsText = await fetchText(md5sumUrl(base), 30_000)
  const target = `R-${R_VERSION}-win.exe`
  let want = null
  for (const line of sumsText.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && (parts[1] === target || parts[1] === `*${target}`)) { want = parts[0]; break }
  }
  if (!want) throw new Error(`MD5 entry not found for ${target} in ${md5sumUrl(base)}`)
  const actual = await md5File(file)
  if (actual.toLowerCase() !== want.toLowerCase()) {
    throw new Error(`R installer MD5 mismatch: expected ${want}, got ${actual}`)
  }
}

function runSync(cmd, args, { timeoutMs = 300_000, env } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
    env: env ? { ...process.env, ...env } : undefined,
  })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 探测 R 环境：R 版本 / Bioc 版本 / 核心包版本（全部 requirements 包逐一探测）。 */
async function rInspect(rscript, lib) {
  const NL = String.fromCharCode(10)
  const pkgs = rCorePackages().filter((p) => p !== 'BiocManager')
  const pkgVec = 'c(' + pkgs.map((p) => `"${p}"`).join(', ') + ')'
  // Use temp R file instead of -e; R 4.6.0 Windows -e with long code causes SIGSEGV (verified)
  const tmpFile = join(os.tmpdir(), `dshbio-r-inspect-${Date.now()}.R`)
  writeFileSync(tmpFile, [
    'ver <- function(p) tryCatch(as.character(packageVersion(p)), error = function(e) NULL)',
    `pkg = ${pkgVec}`,
    'res <- lapply(pkg, ver)',
    'names(res) <- pkg',
    'bioc <- tryCatch(as.character(BiocManager::version()), error = function(e) NULL)',
    'cat(jsonlite::toJSON(list(r = as.character(getRversion()), bioc = bioc, packages = res), auto_unbox = TRUE, null = "null"))',
  ].join(String.fromCharCode(10)), 'utf8')
  const r = runSync(rscript, ['--vanilla', tmpFile], { timeoutMs: 180_000, env: rSpawnEnv(lib) })
  rmSync(tmpFile, { force: true })
  if (r.code !== 0) return null
  try {
    return JSON.parse(r.stdout.trim().split(NL).pop())
  } catch {
    return null
  }
}

/** 安装/补装核心包集（幂等：已装包跳过）。CRAN 走清华（完整），Bioc 走官方（二进制齐全）。 */
function installCorePackages(config) {
  const rscript = rscriptPath(config)
  const lib = rLibDir(config)
  const cran = process.env.DSH_BIO_R_CRAN_BASE || CRAN_MIRROR  // 让安装器镜像与包源一致
  const r = runSync(rscript, ['--vanilla', join(PLUGIN_R_DIR, 'install_packages.R'), lib, cran, USER_BIOC], {
    timeoutMs: PACKAGES_TIMEOUT_MS,
    env: rSpawnEnv(lib),
  })
  if (r.code !== 0) {
    throw new Error(`R package install failed (exit ${r.code}): ${(r.stdout + r.stderr).slice(-800)}`)
  }
  return r.stdout
}

/** 完整自举：下载 R 安装器（官方→清华镜像）→ MD5 校验 → 静默安装 → 装核心包。 */
async function bootstrapR(config, logs) {
  const installRoot = rInstallDir()
  mkdirSync(installRoot, { recursive: true })
  // 唯一临时名：绕开上次崩溃残留的僵尸进程对旧文件名的句柄锁（EPERM 实测根因之一）
  const tmp = join(installRoot, `R-${R_VERSION}-win-installer-${Date.now()}.exe`)

  // 坑（实测）：Inno 安装器可能残留僵尸进程（已终止但未回收，Stop-Process 静默失败、
  // 不影响新安装）；且可能短暂持有旧安装器文件句柄。先尽力杀，再机会性清理旧残留。
  const psKill = [
    `Stop-Process -Name 'R-${R_VERSION}-win-installer' -Force -ErrorAction SilentlyContinue`,
    `Stop-Process -Name 'R-${R_VERSION}-win-installer.tmp' -Force -ErrorAction SilentlyContinue`,
  ].join('; ')
  runSync('powershell', ['-NoProfile', '-Command', psKill], { timeoutMs: 60_000 })
  for (const old of readdirSync(installRoot).filter((f) => f.includes('win-installer'))) {
    try { rmSync(join(installRoot, old), { force: true }) } catch { /* 旧残留锁着就留到下次 */ }
  }

  // 1. 下载 + 校验（官方优先，失败自动切清华镜像；DSH_BIO_R_CRAN_BASE 显式设置时只用该源）
  let fromMirror = false
  const userBase = process.env.DSH_BIO_R_CRAN_BASE
  if (userBase) {
    await download(installerUrl(userBase), tmp)
    await verifyInstallerMd5(tmp, userBase)
    fromMirror = true
  } else {
    try {
      await download(installerUrl(CRAN_OFFICIAL), tmp)
      await verifyInstallerMd5(tmp, CRAN_OFFICIAL)
    } catch (err) {
      logs.push(`[r-bootstrap] 官方 CRAN 失败（${err.message}），自动切换清华镜像`)
      await download(installerUrl(CRAN_MIRROR), tmp)
      await verifyInstallerMd5(tmp, CRAN_MIRROR)
      fromMirror = true
    }
  }
  logs.push(`[r-bootstrap] R ${R_VERSION} 安装器下载完成${fromMirror ? '（镜像源）' : ''}，MD5 校验通过`)

  // 2. 静默安装到私有目录（Inno Setup：/VERYSILENT /NORESTART /DIR）
  // 实测坑：/DIR 不能带内嵌双引号——bash 会剥引号、node spawnSync 原样传导致
  // Inno 退出码 1（初始化失败）；私有路径不含空格，直接裸传最稳。
  const r = runSync(tmp, ['/VERYSILENT', '/NORESTART', `/DIR=${installRoot}`], { timeoutMs: INSTALL_TIMEOUT_MS })
  // 安装器退出后其子进程可能短暂持有 exe 句柄 → 清理带重试（实测 EPERM 坑）
  try {
    rmSync(tmp, { force: true, maxRetries: 3, retryDelay: 2000 })
  } catch {
    try { unlinkSync(tmp) } catch { /* 残留不影响已装好的 R */ }
  }
  if (r.code !== 0) throw new Error(`R silent install failed (exit ${r.code}): ${r.stderr.slice(0, 300)}`)
  const rscript = rscriptPath(config)
  if (!existsSync(rscript)) throw new Error('Rscript.exe not found after silent install — installer layout changed?')

  // 3. 安装核心包集（BiocManager，二进制优先）
  logs.push('[r-bootstrap] 安装核心包集（首次约 5-20 分钟，视网络而定）')
  const out = installCorePackages(config)
  logs.push(`[r-bootstrap] 包安装完成：${out.trim().split(/\r?\n/).pop()}`)
}

// 进程内锁：同一时刻只跑一个 R 引导流程
let rBootstrapLock = Promise.resolve()

// 进程内元数据缓存（同 Python 侧：首次探测后复用，避免每次调用 spawn 探测 R 版本）
let rCachedMeta = null
let rCachedKey = null

/**
 * 确保 R 环境就绪（幂等）。
 * @param {object} config 插件配置（rscriptPath / rLibDir 可覆盖默认私有路径）
 * @param {{force?: boolean}} [opts] force=true 时重新探测/引导
 * @returns {Promise<object>} {ready, rscript, rVersion, bioc, packages, libDir, bootstrapped, error?, logs?}
 */
export async function ensureREnvironment(config = {}, { force = false } = {}) {
  const rscript = rscriptPath(config)
  const lib = rLibDir(config)
  const key = `${rscript}|${lib}`

  const attempt = async () => {
    if (!force && rCachedMeta && rCachedKey === key) {
      return { ...rCachedMeta, bootstrapped: false, cached: true }
    }
    if (existsSync(rscript)) {
      // force=true：强制重装核心包集（R 本体不重装；包级幂等安装器）
      if (force) {
        try { installCorePackages(config) } catch { /* 失败不影响下方探测 */ }
      }
      const meta = await rInspect(rscript, lib)
      if (meta && meta.packages) {
        const missing = rCorePackages().filter((p) => !meta.packages[p])
        if (missing.length === 0) {
          const out = {
            ready: true, rscript, rVersion: meta.r, bioc: meta.bioc,
            packages: meta.packages, libDir: lib, bootstrapped: false,
          }
          rCachedMeta = out
          rCachedKey = key
          return out
        }
        // 轻量补装：requirements 更新后旧环境缺包 → 幂等安装器补装（不重装 R）
        try {
          installCorePackages(config)
          const meta2 = await rInspect(rscript, lib)
          const still = meta2?.packages ? rCorePackages().filter((p) => !meta2.packages[p]) : rCorePackages()
          if (still.length === 0 && meta2) {
            const out = {
              ready: true, rscript, rVersion: meta2.r, bioc: meta2.bioc,
              packages: meta2.packages, libDir: lib, bootstrapped: false,
            }
            rCachedMeta = out
            rCachedKey = key
            return out
          }
        } catch {
          // 补装失败 → 下方完整自举兜底
        }
      }
    }
    if (process.platform !== 'win32' && !config.rscriptPath) {
      return {
        ready: false, rscript, libDir: lib, bootstrapped: false,
        error: `R 引导当前仅支持 Windows。macOS/Linux 请自行安装 R (>= ${R_VERSION})，并在插件配置 rscriptPath 指向 Rscript 后重试。`,
      }
    }
    const logs = []
    try {
      await bootstrapR(config, logs)
      const meta = await rInspect(rscript, lib)
      if (meta) {
        const out = {
          ready: true, rscript, rVersion: meta.r, bioc: meta.bioc,
          packages: meta.packages, libDir: lib, bootstrapped: true,
          logs: logs.join(String.fromCharCode(10)),
        }
        rCachedMeta = out
        rCachedKey = key
        return out
      }
    } catch (err) {
      logs.push(`[r-bootstrap failed: ${err.message}]`)
    }
    return {
      ready: false, rscript, libDir: lib, bootstrapped: false,
      error: logs.join(String.fromCharCode(10)).slice(-1500),
    }
  }

  rBootstrapLock = rBootstrapLock.then(attempt, attempt)
  return rBootstrapLock
}

/**
 * 通过 r_bridge.R 执行任意 R 代码（bio_r 执行器通道，JSON 信封契约同 python.js）。
 * @param {string} rscript Rscript 绝对路径
 * @param {string} libDir 私有包库目录（注入 R_LIBS 隔离）
 * @param {string} code R 源码
 * @param {{cwd?: string, timeoutMs?: number, signal?: AbortSignal}} [opts]
 */
export function runRBridge(rscript, libDir, code, { cwd, timeoutMs = 120_000, signal } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(rscript, ['--vanilla', join(PLUGIN_R_DIR, 'r_bridge.R')], {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: rSpawnEnv(libDir),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let didTimeout = false

    const settle = (obj) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolvePromise(obj)
    }
    const onAbort = () => child.kill()
    const timer = setTimeout(() => { didTimeout = true; child.kill() }, timeoutMs)

    if (signal) {
      if (signal.aborted) child.kill()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => settle({ ok: false, stdout, stderr, error: String(err), exitCode: null, timedOut: false }))
    child.on('close', (code) => {
      let parsed = null
      try { parsed = JSON.parse(stdout.trim()) } catch { /* fallthrough */ }
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
        settle({ ...parsed, exitCode: code, timedOut: didTimeout })
      } else {
        const reason = didTimeout
          ? `R execution timed out after ${timeoutMs} ms (exit ${code})`
          : `R returned no valid JSON (exit ${code})`
        settle({ ok: false, stdout, stderr, error: reason, exitCode: code, timedOut: didTimeout })
      }
    })
    try {
      child.stdin.write(JSON.stringify({ code, cwd }))
      child.stdin.end()
    } catch (err) {
      settle({ ok: false, stdout, stderr, error: `stdin write failed: ${err.message}`, exitCode: null, timedOut: false })
    }
  })
}
