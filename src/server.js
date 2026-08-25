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
 *     - GET  /api/dsh-bio-genie/skills           listSkillsForPanel()
 * - **超时 + 取消保护**：每个端点最多跑 20s，超时返回 ok:false code:'internal'，
 *   避免面板长时间转圈或被恶意大 payload 阻塞。
 *
 * @module dsh-bio-genie/server
 */
import { spawn } from 'node:child_process'
import { join as pathJoin } from 'node:path'
import { venvPython, resolveEnvDir, bioEnvExists, PYTHON_DIR, manageAddon, addonsStatus } from './runtime.js'

import { listSkillsForPanel } from './skills.js'
import { handleConfig } from './config_handler.js'
import { handleWorkspaceConfig } from './workspace_config.js'
import { ADDON_MODULES } from './extra-deps.js'

/** 路由前缀（与 @linxin666/dsh-client-ui-web-ui-settings 同风格）。 */
const ROUTE_PREFIX = '/api/dsh-bio-genie'
/** 工具调试面板的参数 schema（与 client.js 共用）。 */
const TOOL_SCHEMAS = [
  { name: 'seq_analyze', label: '序列分析', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCGATCG...', desc: '核酸或蛋白质序列' },
    { key: 'seq_type', type: 'select', options: ['auto','dna','rna','protein'], default: 'auto', desc: '序列类型' },
    { key: 'codon_stats', type: 'boolean', default: false, desc: '返回密码子统计' },
    { key: 'codon_host', type: 'select', options: ['ecoli','human','yeast'], default: 'ecoli', desc: '统计宿主' },
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
    { key: 'detail', type: 'boolean', default: false, desc: '返回全部位点坐标' },
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
    { key: 'analysis_type', type: 'select', options: ['fba', 'fva', 'pfba', 'loopless', 'geometric', 'optionsfva'], default: 'fba', desc: '分析类型' },
  ]},
  { name: 'gene_knockout', label: '基因敲除', engine: 'python', params: [
    { key: 'model_id', type: 'text', default: 'textbook', desc: '模型 ID' },
    { key: 'gene', type: 'text', required: true, placeholder: 'b2779', desc: '基因 ID（single 模式必填）' },
    { key: 'analysis_type', type: 'select', options: ['single', 'double', 'essentiality', 'optknock'], default: 'single', desc: '分析类型' },
    { key: 'target_reaction', type: 'text', placeholder: 'EX_ac_e', desc: 'OptKnock 目标反应（外泌反应）' },
    { key: 'min_growth', type: 'number', default: 0.1, desc: 'OptKnock 最小生长率（占 WT 比例）' },
    { key: 'max_knockouts', type: 'number', default: 3, desc: 'OptKnock 最大敲除数' },
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
  { name: 'ml_pipeline', label: 'ML 管道', engine: 'python', params: [
    { key: 'path', type: 'text', required: true, placeholder: '/path/to/data.csv', desc: 'CSV 文件路径' },
    { key: 'target', type: 'text', required: true, placeholder: 'label', desc: '目标列名' },
    { key: 'task', type: 'select', options: ['classification','regression'], default: 'classification', desc: '任务类型' },
    { key: 'model', type: 'select', options: ['random_forest','svm','logistic','linear'], default: 'random_forest', desc: '模型' },
  ]},
  { name: 'ml_reduce', label: '降维分析', engine: 'python', params: [
    { key: 'path', type: 'text', required: true, placeholder: '/path/to/data.csv', desc: 'CSV 文件路径' },
    { key: 'method', type: 'select', options: ['pca','tsne'], default: 'pca', desc: '降维方法' },
    { key: 'n_components', type: 'number', default: 2, desc: '目标维度' },
  ]},
  { name: 'ml_cluster', label: '聚类分析', engine: 'python', params: [
    { key: 'path', type: 'text', required: true, placeholder: '/path/to/data.csv', desc: 'CSV 文件路径' },
    { key: 'method', type: 'select', options: ['kmeans','hierarchical'], default: 'kmeans', desc: '聚类方法' },
    { key: 'n_clusters', type: 'number', default: 3, desc: '簇数' },
  ]},
  { name: 'ml_feature', label: '特征重要性', engine: 'python', params: [
    { key: 'path', type: 'text', required: true, placeholder: '/path/to/data.csv', desc: 'CSV 文件路径' },
    { key: 'target', type: 'text', required: true, placeholder: 'label', desc: '目标列名' },
    { key: 'top', type: 'number', default: 10, desc: '返回前 N 个特征' },
  ]},
  { name: 'stats_test', label: '统计检验', engine: 'python', params: [
    { key: 'path', type: 'text', required: true, placeholder: '/path/to/data.csv', desc: 'CSV 文件路径' },
    { key: 'group_col', type: 'text', required: true, placeholder: 'group', desc: '分组列名' },
    { key: 'value_col', type: 'text', required: true, placeholder: 'value', desc: '数值列名' },
    { key: 'test_type', type: 'select', options: ['auto','ttest','mannwhitney','anova','chi2'], default: 'auto', desc: '检验类型' },
  ]},
  { name: 'primer_design', label: '引物设计', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCGATCG...', desc: '模板 DNA 序列' },
    { key: 'product_size', type: 'number', default: 500, desc: '产物大小(bp)' },
    { key: 'tm_target', type: 'number', default: 60, desc: '目标 Tm(°C)' },
    { key: 'top_n', type: 'number', default: 5, desc: '返回候选数' },
    { key: 'tm_diff_max', type: 'number', default: 5, desc: 'Tm 差过滤阈值(°C)' },
  ]},
  { name: 'seq_optimize', label: '密码子优化', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGTAAAGAT...', desc: '编码序列(CDS)' },
    { key: 'organism', type: 'select', options: ['ecoli','human','yeast'], default: 'ecoli', desc: '宿主生物' },
  ]},
  { name: 'assembly_design', label: '组装设计', engine: 'python', params: [
    { key: 'fragments', type: 'text', required: true, placeholder: 'seq1,seq2,seq3', desc: 'DNA 片段（逗号分隔）' },
    { key: 'method', type: 'select', options: ['auto','gibson','golden_gate','restriction'], default: 'auto', desc: '组装方法' },
  ]},
  { name: 'plasmid_map', label: '质粒图谱', engine: 'python', params: [
    { key: 'name', type: 'text', default: 'plasmid', desc: '质粒名称' },
    { key: 'size', type: 'number', default: 5000, desc: '总大小(bp)' },
    { key: 'features', type: 'text', placeholder: '[{"name":"promoter","start":0,"end":200,"type":"regulatory"}]', desc: '特征列表(JSON)' },
    { key: 'sequence', type: 'text', placeholder: 'ATGCGTA...', desc: '质粒序列(传了才出图形)' },
    { key: 'output_format', type: 'select', options: ['png','svg'], default: 'png', desc: '图形格式' },
    { key: 'out_file', type: 'text', placeholder: 'D:/path/plasmid_map.png', desc: '图形输出路径(可选)' },
  ]},
  { name: 'deseq2', label: '差异表达(Python)', engine: 'python', params: [
    { key: 'counts_file', type: 'text', required: true, placeholder: '/path/to/counts.csv', desc: 'counts 矩阵 CSV' },
    { key: 'meta_file', type: 'text', required: true, placeholder: '/path/to/meta.csv', desc: '样本信息 CSV' },
    { key: 'contrast', type: 'text', default: 'trt_vs_ctrl', desc: '对比组' },
  ]},
  { name: 'gsea', label: 'GSEA 富集(Python)', engine: 'python', params: [
    { key: 'de_results_file', type: 'text', required: true, placeholder: '/path/to/de_results.csv', desc: '差异表达结果 CSV' },
    { key: 'gene_sets', type: 'text', default: 'hallmark', desc: '基因集' },
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

/** Skill 清单端点：纯静态（listSkillsForPanel 已是 in-memory 数据）。 */
async function handleSkills(req, res) {
  writeJson(res, 200, { ok: true, value: listSkillsForPanel() })
}

/**
 * 高级模块端点（第三层 ADDON_MODULES 管理）：
 *  - GET  → 全部模块的元数据 + import probe 安装状态
 *  - POST { module, action: 'install'|'uninstall' } → uv pip install/uninstall + 验证
 */
async function handleAddons(req, res, config) {
  const envDir = resolveEnvDir(config.pythonEnvDir)
  const py = venvPython(envDir)
  if (!bioEnvExists(config)) {
    return writeJson(res, 200, {
      ok: false, code: 'env-not-ready',
      message: 'Python venv 未引导（首次调用 bio_python / bio_env 即会触发引导）',
    })
  }
  if (req.method === 'GET') {
    // 批量元数据探测（单次 Python 子进程），替代旧的逐包 import 探测（>5s → <0.5s）
    const status = await addonsStatus(py)
    const modules = {}
    for (const key of Object.keys(ADDON_MODULES)) {
      modules[key] = { ...ADDON_MODULES[key], installed: status[key].installed, packages: status[key].packages }
    }
    return writeJson(res, 200, { ok: true, value: { modules } })
  }
  const body = req.body || {}
  if (typeof body.module !== 'string' || !ADDON_MODULES[body.module]) {
    return writeJson(res, 400, { ok: false, code: 'bad-request', message: `未知模块: ${body.module}` })
  }
  if (body.action !== 'install' && body.action !== 'uninstall') {
    return writeJson(res, 400, { ok: false, code: 'bad-request', message: `action 仅支持 install/uninstall` })
  }
  const result = await manageAddon(body.module, body.action, py)
  writeJson(res, 200, result.ok
    ? { ok: true, value: result }
    : { ok: false, code: 'addon-failed', message: result.error || '操作失败' })
}

/** 工具 schema 端点：返回所有可调试工具的参数定义。 */
async function handleToolSchemas(req, res) {
  writeJson(res, 200, { ok: true, value: TOOL_SCHEMAS })
}

/**
 * 工具执行端点（POST）：接收 { op, args }，通过子进程调用 bio_ops.py（Python）
 * 返回 { ok, result | error }。
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

  // Python 操作：通过 bio_ops.py 执行
  const envDir = resolveEnvDir(config.pythonEnvDir)
  const py = venvPython(envDir)
  if (!bioEnvExists(config)) {
    return writeJson(res, 200, { ok: false, code: 'env-not-ready', message: 'Python 环境未就绪' })
  }
  const opsPath = pathJoin(PYTHON_DIR, 'bio_ops.py')
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
    { kind: 'exact', path: `${ROUTE_PREFIX}/skills`,          handler: guard((req, res) => handleSkills(req, res)) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/config`,         handler: guard((req, res) => handleConfig(req, res, config)) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/workspace-config`, handler: guard((req, res) => handleWorkspaceConfig(req, res)) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/tool-schemas`,    handler: guard((req, res) => handleToolSchemas(req, res)) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/execute-tool`,    handler: guard((req, res) => handleExecuteTool(req, res, config)) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/addons`,          handler: guard((req, res) => handleAddons(req, res, config)) },
  ]) {
    disposers.push(ctx.webServer.register(route))
  }
  return () => {
    for (const d of disposers) d()
  }
}