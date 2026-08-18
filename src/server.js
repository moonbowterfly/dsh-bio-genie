/**
 * dsh-bio-genie — 宿主侧 RPC 路由（loopback-only）。
 *
 * 浏览器侧设置面板（lib/client.js）通过 fetch 同源调本模块注册的路由，
 * 把环境状态/包列表等运行时数据带回到静态元信息仪表盘。设计要点：
 *
 * - **同源 + loopback 守卫**：仿 @linxin666/dsh-client-ui-web-ui-settings 的
 *   isLoopbackRequest 检查（127.0.0.1/localhost/sec-fetch-site/origin 三层
 *   校验），拒绝跨站/非本地访问；非本机部署也照样拒绝。
 * - **JSON 信封**：`{ ok: true, value: {...} }` 或 `{ ok: false, code, message }`。
 *   失败用 ok:false + 机器可读 code（settings-not-exposed/internal/path-not-found）；
 *   客户端 fetch 包装据此决定渲染。
 * - **不破坏现有契约**：仅注入新服务 `webServer`（cordis.patch.yml 已声明），
 *   旧注册链路（tools/skills/systemPrompt）完全不动。
 * - **小端点 + 幂等**：
 *     - GET  /api/dsh-bio-genie/python-packages  pip freeze 解析（venv 未就绪返回 ok:false）
 *     - GET  /api/dsh-bio-genie/r-packages       installed.packages() 解析（未引导返回 ok:false）
 *     - GET  /api/dsh-bio-genie/skills           listSkillsForPanel()
 * - **超时 + 取消保护**：每个端点最多跑 20s，超时返回 ok:false code:'internal'，
 *   避免面板长时间转圈或被恶意大 payload 阻塞。
 *
 * @module dsh-bio-genie/server
 */
import { spawn } from 'node:child_process'
import { venvPython, resolveEnvDir, bioEnvExists } from './runtime.js'
import { rscriptPath as rscriptPathFn, rLibDir as rLibDirFn, rSpawnEnv } from './r-runtime.js'
import { listSkillsForPanel } from './skills.js'

/** 路由前缀（与 @linxin666/dsh-client-ui-web-ui-settings 同风格）。 */
const ROUTE_PREFIX = '/api/dsh-bio-genie'

/** 单端点执行上限（ms）。pip freeze 在冷启动 venv 内通常 <2s，留 10x 余量。 */
const HARD_TIMEOUT_MS = 20_000

/** JSON 响应体上限（防御恶意大 payload 撑爆内存）。 */
const MAX_JSON_BODY_BYTES = 8 * 1024

/**
 * Loopback + 同源守卫。校验项：
 *  1. socket.remoteAddress 必须是 127.0.0.1 / ::1 / ::ffff:127.0.0.1
 *  2. Host 头是 127.0.0.1 / localhost / [::1]（防 Host 头走私）
 *  3. sec-fetch-site !== 'cross-site'（浏览器发起的跨站请求会带这个头）
 *  4. 若有 Origin 头则同 Host（防表单提交/CSRF）
 * 失败返回 false，调用方负责回 403。
 */
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress
  if (
    address !== '127.0.0.1' &&
    address !== '::1' &&
    address !== '::ffff:127.0.0.1'
  ) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (
    hostUrl.hostname !== '127.0.0.1' &&
    hostUrl.hostname !== 'localhost' &&
    hostUrl.hostname !== '[::1]'
  ) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 写一段 JSON 响应。 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** 读 JSON 请求体（用于未来扩展写端点；当前路由只用 GET，保留以备扩展）。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * 通用子进程执行器：spawn(cmd, args, env) 收集 stdout/stderr；
 * 超时或非 0 退出码视为失败。Windows 上 windowsHide + 不创建控制台窗口。
 */
function runSubprocess(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      ...options,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ ok: false, code: 'timeout', stdout, stderr })
    }, HARD_TIMEOUT_MS)
    child.stdout?.on('data', (b) => { stdout += b.toString('utf8') })
    child.stderr?.on('data', (b) => { stderr += b.toString('utf8') })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: 'spawn-failed', message: err.message, stdout, stderr })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true, stdout, stderr })
      else resolve({ ok: false, code: 'exit-nonzero', exitCode: code, stdout, stderr })
    })
  })
}

/**
 * Python 包列表端点：spawn `<venv>/python -I -m pip list --format=json`，
 * 解析后返回 { name, version }[]。
 * venv 不存在直接返回 ok:false code:'env-not-ready'。
 */
async function handlePythonPackages(req, res, config) {
  const envDir = resolveEnvDir(config.pythonEnvDir)
  const py = venvPython(envDir)
  if (!bioEnvExists(config)) {
    return writeJson(res, 200, {
      ok: false,
      code: 'env-not-ready',
      message: `Python venv 未引导：${py} 不存在（首次调用 bio_python / bio_env 即会触发引导）`,
    })
  }
  const result = await runSubprocess(py, ['-I', '-m', 'pip', 'list', '--format=json'])
  if (!result.ok) {
    return writeJson(res, 200, {
      ok: false,
      code: result.code,
      message: `pip list 失败：${result.stderr.slice(0, 500)}`,
    })
  }
  let packages
  try {
    packages = JSON.parse(result.stdout)
  } catch (err) {
    return writeJson(res, 200, {
      ok: false,
      code: 'parse-failed',
      message: `pip list 输出解析失败：${err.message}`,
    })
  }
  // 按名排序，长度固定方便用户扫读
  packages.sort((a, b) => a.name.localeCompare(b.name))
  writeJson(res, 200, {
    ok: true,
    value: {
      python: py,
      envDir,
      count: packages.length,
      packages,
    },
  })
}

/**
 * R 包列表端点：写一个临时 .R 文件，里面只放
 *   cat(toJSON(list(ok=TRUE, value=list(rscript=..., libDir=..., packages=...))))
 * 用 --file= 喂给 Rscript；path 永远走 JS 字符串不做 R 转义，避开反斜杠
 * 把 "\U..." 误识为 R 半截 unicode 转义（之前 -e 长代码踩坑的修复方案）。
 * Rscript 不存在返回 ok:false code:'env-not-ready'。
 */
async function handleRPackages(req, res, config) {
  const rscript = rscriptPathFn(config)
  const rlib = rLibDirFn(config)
  const os = await import('node:os')
  const fs = await import('node:fs')
  const pathMod = await import('node:path')
  const tmp = pathMod.join(os.tmpdir(), `dsh-bio-genie-r-pkg-${process.pid}-${Date.now()}.R`)
  // R 脚本里只放字面 JSON 结构，包路径通过 env var 传入；避免任何字符串拼接。
  const rScript = `env <- Sys.getenv(c("DSH_BIO_RSCRIPT","DSH_BIO_RLIB"), unset=NA)
df <- as.data.frame(installed.packages()[, c("Package","Version")], stringsAsFactors=FALSE)
out <- list(ok=TRUE, value=list(
  rscript=unname(env["DSH_BIO_RSCRIPT"]),
  libDir=unname(env["DSH_BIO_RLIB"]),
  packages=df
))
cat(jsonlite::toJSON(out, auto_unbox=TRUE, na="null"), "\\n")\n`
  try {
    fs.writeFileSync(tmp, rScript, 'utf8')
  } catch (err) {
    return writeJson(res, 200, {
      ok: false,
      code: 'tempfile-failed',
      message: `临时 .R 写入失败：${err.message}`,
    })
  }
  const env = { ...rSpawnEnv(rlib), DSH_BIO_RSCRIPT: rscript, DSH_BIO_RLIB: rlib }
  // Rscript 长选项语法是 `--file <path>`（空格分隔），不接受 `--file=<path>`，
  // Windows 上后者会触发 "file name is missing"。
  const result = await runSubprocess(rscript, ['--vanilla', '--file', tmp], { env })
  try { fs.unlinkSync(tmp) } catch { /* ignore */ }
  if (!result.ok) {
    return writeJson(res, 200, {
      ok: false,
      code: result.code,
      message: `Rscript 失败：${result.stderr.slice(0, 500)}`,
    })
  }
  // R 通过 cat(toJSON(...)) 在最后一行输出 JSON
  const lastLine = result.stdout.trim().split(/\r?\n/).pop() || ''
  let parsed
  try {
    parsed = JSON.parse(lastLine)
  } catch (err) {
    return writeJson(res, 200, {
      ok: false,
      code: 'parse-failed',
      message: `R 输出解析失败：${err.message}\nstdout tail: ${result.stdout.slice(-300)}`,
    })
  }
  if (!parsed.ok) {
    return writeJson(res, 200, { ok: false, code: 'r-bridge-failed', message: parsed.error || 'unknown' })
  }
  // R 的 data.frame → list of {Package, Version}
  const packages = (parsed.value.packages || []).map((p) => ({
    name: p.Package,
    version: p.Version,
  }))
  packages.sort((a, b) => a.name.localeCompare(b.name))
  writeJson(res, 200, {
    ok: true,
    value: {
      rscript,
      libDir: rlib,
      count: packages.length,
      packages,
    },
  })
}

/** Skill 清单端点：纯静态（listSkillsForPanel 已是 in-memory 数据）。 */
async function handleSkills(req, res) {
  writeJson(res, 200, { ok: true, value: listSkillsForPanel() })
}

/**
 * 路由注册入口：被 src/index.js 的 apply() 在 cordis ctx.webServer 可用时调用。
 * 路由 kind: 'exact'（精确路径匹配，模仿 web-ui-settings 的做法）。
 */
export function registerApiRoutes(ctx, config = {}) {
  const guard = (handler) => async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return writeJson(res, 403, { ok: false, code: 'loopback-required', message: 'loopback requests only' })
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      return writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `method not allowed: ${req.method}` })
    }
    // POST 端点（未来扩展）允许带 body；当前 GET 端点忽略 body
    if (req.method === 'POST') {
      req.body = await readJsonBody(req)
      if (req.body === undefined) {
        return writeJson(res, 400, { ok: false, code: 'bad-body', message: 'unreadable JSON body' })
      }
    }
    try {
      await handler(req, res)
    } catch (err) {
      writeJson(res, 500, { ok: false, code: 'internal', message: err?.message || String(err) })
    }
  }
  const disposers = []
  for (const route of [
    { kind: 'exact', path: `${ROUTE_PREFIX}/python-packages`, handler: guard((req, res) => handlePythonPackages(req, res, config)) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/r-packages`,      handler: guard((req, res) => handleRPackages(req, res, config)) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/skills`,          handler: guard((req, res) => handleSkills(req, res)) },
  ]) {
    disposers.push(ctx.webServer.register(route))
  }
  return () => {
    for (const d of disposers) d()
  }
}