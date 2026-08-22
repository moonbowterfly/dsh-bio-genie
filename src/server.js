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
import { join as pathJoin } from 'node:path'
import { venvPython, resolveEnvDir, bioEnvExists } from './runtime.js'
import { rscriptPath as rscriptPathFn, rLibDir as rLibDirFn, rSpawnEnv } from './r-runtime.js'
import { listSkillsForPanel } from './skills.js'

/** 路由前缀（与 @linxin666/dsh-client-ui-web-ui-settings 同风格）。 */
const ROUTE_PREFIX = '/api/dsh-bio-genie'
/** 工具调试面板的参数 schema（与 client.js 共用）。 */
const TOOL_SCHEMAS = [
  { name: 'seq_analyze', label: '序列分析', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCGATCG...', desc: '核酸或蛋白质序列' },
    { key: 'seq_type', type: 'select', options: ['auto','dna','rna','protein'], default: 'auto', desc: '序列类型' },
  ]},
  { name: 'seq_translate', label: '序列翻译', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCG...', desc: 'DNA/RNA 序列' },
    { key: 'table', type: 'number', default: 1, desc: '遗传密码表编号' },
    { key: 'to_stop', type: 'boolean', default: false, desc: '遇到终止密码子停止' },
  ]},
  { name: 'seq_gc_skew', label: 'GC Skew', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCG...', desc: 'DNA 序列' },
    { key: 'window', type: 'number', default: 100, desc: '窗口大小' },
  ]},
  { name: 'seq_find_orf', label: 'ORF 查找', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCG...', desc: 'DNA 序列' },
    { key: 'min_len', type: 'number', default: 30, desc: '最小 ORF 长度' },
  ]},
  { name: 'seq_kmer', label: 'K-mer 统计', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCG...', desc: '核酸序列' },
    { key: 'k', type: 'number', default: 3, desc: 'k 值' },
    { key: 'top', type: 'number', default: 10, desc: '返回前 N 个' },
  ]},
  { name: 'seq_restriction', label: '限制酶切', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGAATTCGATCG...', desc: 'DNA 序列' },
    { key: 'enzymes', type: 'text', placeholder: 'EcoRI,BamHI', desc: '酶名列表（逗号分隔）' },
    { key: 'linear', type: 'boolean', default: true, desc: '线性分子' },
  ]},
  { name: 'entrez_search', label: 'NCBI 检索', engine: 'python', params: [
    { key: 'term', type: 'text', required: true, placeholder: 'TP53[Gene Name] AND human[Organism]', desc: '检索式' },
    { key: 'db', type: 'select', options: ['nucleotide','gene','protein'], default: 'nucleotide', desc: '数据库' },
    { key: 'retmax', type: 'number', default: 5, desc: '最大返回数' },
  ]},
  { name: 'enrichr', label: 'Enrichr 富集', engine: 'python', params: [
    { key: 'genes', type: 'text', required: true, placeholder: 'TP53,BRCA1,EGFR', desc: '基因列表（逗号分隔）' },
    { key: 'library', type: 'text', default: 'GO_Biological_Process_2023', desc: '富集库' },
    { key: 'top', type: 'number', default: 10, desc: '返回前 N 条' },
  ]},
  { name: 'pubmed_search', label: 'PubMed 检索', engine: 'python', params: [
    { key: 'term', type: 'text', required: true, placeholder: 'CRISPR gene editing', desc: '检索式' },
    { key: 'retmax', type: 'number', default: 10, desc: '最大返回数' },
  ]},
  { name: 'metabolic_model', label: '代谢模型', engine: 'python', params: [
    { key: 'action', type: 'select', options: ['list','load','info'], default: 'list', desc: '操作类型' },
    { key: 'model_id', type: 'text', default: 'textbook', desc: '模型 ID' },
  ]},
  { name: 'fba', label: 'FBA 分析', engine: 'python', params: [
    { key: 'model_id', type: 'text', default: 'textbook', desc: '模型 ID' },
    { key: 'objective', type: 'text', placeholder: 'Biomass_Ecoli_core', desc: '目标函数（可选）' },
  ]},
  { name: 'gene_knockout', label: '基因敲除', engine: 'python', params: [
    { key: 'model_id', type: 'text', default: 'textbook', desc: '模型 ID' },
    { key: 'gene', type: 'text', required: true, placeholder: 'b2779', desc: '基因 ID' },
  ]},
  { name: 'pathway_search', label: '通路搜索', engine: 'python', params: [
    { key: 'target_metabolite', type: 'text', required: true, placeholder: 'glycolysis', desc: '目标代谢物/关键词' },
    { key: 'organism', type: 'text', default: 'eco', desc: '生物代码' },
    { key: 'limit', type: 'number', default: 10, desc: '返回数量' },
  ]},
  { name: 'pathway_design', label: '通路设计', engine: 'python', params: [
    { key: 'target_product', type: 'text', required: true, placeholder: 'ethanol', desc: '目标产物' },
    { key: 'host_organism', type: 'text', default: 'eco', desc: '宿主生物' },
    { key: 'strategy', type: 'select', options: ['shortest','max_yield','fewest_steps'], default: 'shortest', desc: '设计策略' },
  ]},
  { name: 'seq_io_read', label: '读取序列文件', engine: 'python', params: [
    { key: 'path', type: 'text', required: true, placeholder: '/path/to/sequences.fasta', desc: '序列文件路径' },
    { key: 'format', type: 'select', options: ['fasta','genbank'], default: 'fasta', desc: '文件格式' },
    { key: 'limit', type: 'number', default: 50, desc: '最多返回记录数' },
  ]},
  { name: 'entrez_fetch', label: 'Entrez 下载', engine: 'python', params: [
    { key: 'ids', type: 'text', required: true, placeholder: 'NM_007294', desc: 'NCBI ID（逗号分隔）' },
    { key: 'db', type: 'select', options: ['nucleotide','gene','protein'], default: 'nucleotide', desc: '数据库' },
    { key: 'rettype', type: 'select', options: ['fasta','gb'], default: 'fasta', desc: '返回格式' },
  ]},
  { name: 'pubmed_abstract', label: 'PubMed 摘要', engine: 'python', params: [
    { key: 'ids', type: 'text', required: true, placeholder: '42603971', desc: 'PMID（逗号分隔）' },
  ]},
  { name: 'ref_genome', label: '参考基因组', engine: 'python', params: [
    { key: 'species', type: 'text', required: true, placeholder: 'human', desc: '物种名' },
  ]},
  { name: 'fig_profile', label: '数据剖析', engine: 'python', params: [
    { key: 'path', type: 'text', required: true, placeholder: '/path/to/data.csv', desc: '数据文件路径' },
    { key: 'group_cols', type: 'text', placeholder: 'group,condition', desc: '分组列（逗号分隔）' },
  ]},
  { name: 'fig_export', label: '图文件审计', engine: 'python', params: [
    { key: 'paths', type: 'text', required: true, placeholder: 'fig1.pdf,fig1.png', desc: '图文件路径（逗号分隔）' },
    { key: 'min_dpi', type: 'number', default: 300, desc: '最低 DPI' },
    { key: 'preview', type: 'boolean', default: false, desc: '生成 PNG 预览' },
  ]},
  { name: 'fig_qa', label: '绘图环境检查', engine: 'python', params: [
    { key: 'lang', type: 'select', options: ['zh','en'], default: 'zh', desc: '目标语言' },
    { key: 'journal', type: 'select', options: ['nature','science','ieee','general'], default: 'nature', desc: '期刊预设' },
  ]},
  { name: 'env_status', label: 'Python 环境', engine: 'python', params: [] },
  { name: 'bio_r_env', label: 'R 环境检查', engine: 'python', params: [
    { key: 'action', type: 'select', options: ['status','install','reinstall'], default: 'status', desc: '操作类型' },
  ]},
]


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
 * options.stdin：可选，写入子进程 stdin 的字符串数据。
 */
function runSubprocess(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const useStdin = typeof options.stdin === 'string'
    const child = spawn(cmd, args, {
      ...options,
      windowsHide: true,
      stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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
    // 写入 stdin 数据（用于 bio_ops.py 等通过 stdin 接收 JSON 的工具）
    if (useStdin && child.stdin) {
      child.stdin.write(options.stdin)
      child.stdin.end()
    }
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

/** 工具 schema 端点：返回所有可调试工具的参数定义。 */
async function handleToolSchemas(req, res) {
  writeJson(res, 200, { ok: true, value: TOOL_SCHEMAS })
}

/**
 * 工具执行端点（POST）：接收 { op, args }，通过子进程调用 bio_ops.py（Python）
 * 或 r_bridge.R（R），返回 { ok, result | error }。
 *
 * 执行超时 60s（代谢通路设计等网络操作可能较慢）。
 */
async function handleExecuteTool(req, res, config) {
  const body = req.body
  if (!body || typeof body.op !== 'string') {
    return writeJson(res, 400, { ok: false, code: 'bad-request', message: '缺少 op 字段' })
  }
  const op = body.op
  const args = body.args || {}
  const isROp = typeof op === 'string' && op.startsWith('r:')

  if (isROp) {
    // R 操作：通过 r_bridge.R 执行
    const rscript = rscriptPathFn(config)
    const rlib = rLibDirFn(config)
    if (!rscript) {
      return writeJson(res, 200, { ok: false, code: 'env-not-ready', message: 'R 环境未就绪' })
    }
    const os = await import('node:os')
    const fs = await import('node:fs')
    const realOp = op.slice(2) // 去掉 'r:' 前缀
    const tmp = pathJoin(os.tmpdir(), `dsh-bio-genie-tool-${process.pid}-${Date.now()}.R`)
    const rCode = `result <- tryCatch({ library(jsonlite); source(file.path(Sys.getenv("DSH_BIO_RLIB"), "..", "..", "dsh-bio-genie", "r", "r_bridge.R")); cat(toJSON(r_bridge_execute(list(op="${realOp}", args=toJSON(args))), auto_unbox=TRUE), "\\n") }, error=function(e) cat(jsonlite::toJSON(list(ok=FALSE, error=conditionMessage(e)), auto_unbox=TRUE), "\\n"))\\n`
    // 简化：直接通过 stdin JSON 调用 r_bridge.R
    const rBridgePath = pathJoin(process.env.HOME || process.env.USERPROFILE, '.dsh', 'dsh-bio-genie', 'r', 'r_bridge.R')
    const bridgeExists = fs.existsSync(rBridgePath)
    if (!bridgeExists) {
      return writeJson(res, 200, { ok: false, code: 'r-bridge-not-found', message: `R bridge 不存在: ${rBridgePath}` })
    }
    // 写临时输入 JSON
    const inputJson = JSON.stringify({ op: realOp, args })
    const inputTmp = pathJoin(os.tmpdir(), `dsh-bio-genie-tool-input-${process.pid}-${Date.now()}.json`)
    fs.writeFileSync(inputTmp, inputJson, 'utf8')
    const env = { ...rSpawnEnv(rlib), DSH_BIO_RLIB: rlib }
    const result = await runSubprocess(rscript, ['--vanilla', '--file', rBridgePath], { env })
    try { fs.unlinkSync(inputTmp) } catch { /* ignore */ }
    if (!result.ok) {
      return writeJson(res, 200, { ok: false, code: result.code, message: `R 执行失败: ${result.stderr.slice(0, 500)}` })
    }
    const lastLine = result.stdout.trim().split(/\r?\n/).pop() || ''
    try {
      const parsed = JSON.parse(lastLine)
      writeJson(res, 200, parsed)
    } catch (err) {
      writeJson(res, 200, { ok: false, code: 'parse-failed', message: `R 输出解析失败: ${err.message}`, stdout: result.stdout.slice(-500) })
    }
    return
  }

  // Python 操作：通过 bio_ops.py 执行
  const envDir = resolveEnvDir(config.pythonEnvDir)
  const py = venvPython(envDir)
  if (!bioEnvExists(config)) {
    return writeJson(res, 200, { ok: false, code: 'env-not-ready', message: 'Python 环境未就绪' })
  }
  const opsPath = pathJoin(process.env.HOME || process.env.USERPROFILE, '.dsh', 'profiles', 'web', 'node_modules', '@dsh-bio', 'dsh-bio-genie', 'python', 'bio_ops.py')
  const payload = JSON.stringify({ op, args })
  const result = await runSubprocess(py, ['-I', opsPath], { stdin: payload })
  if (!result.ok) {
    return writeJson(res, 200, { ok: false, code: result.code, message: `Python 执行失败: ${result.stderr.slice(0, 500)}` })
  }
  try {
    const parsed = JSON.parse(result.stdout.trim())
    writeJson(res, 200, parsed)
  } catch (err) {
    writeJson(res, 200, { ok: false, code: 'parse-failed', message: `Python 输出解析失败: ${err.message}`, stdout: result.stdout.slice(-500) })
  }
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
    { kind: 'exact', path: `${ROUTE_PREFIX}/tool-schemas`,    handler: guard((req, res) => handleToolSchemas(req, res)) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/execute-tool`,    handler: guard((req, res) => handleExecuteTool(req, res, config)) },
  ]) {
    disposers.push(ctx.webServer.register(route))
  }
  return () => {
    for (const d of disposers) d()
  }
}