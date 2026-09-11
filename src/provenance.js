/**
 * dsh-bio-genie — provenance 台账（计算防火墙的数据层）
 *
 * 职责：
 *  1. 给工具结果挂 `_provenance` 背书字段（attachProvenance）
 *  2. 把工具输出中出现过的数值记入台账（recordNumbers）
 *  3. 扫描 agent 回复中的数值声明，找出无溯源数字（findUnverifiedNumbers）
 *
 * 台账按 agent 维度隔离（WeakMap key = agent 对象），进程内共享给
 * tools.js（写入）与 rigor-guard.js（检查）。
 *
 * @module dsh-bio-genie/provenance
 */

/** 每个 agent 台账的数值容量上限（防膨胀）。 */
const LEDGER_CAP = 2000
/** 单次工具结果最多贡献的数值数（防单个超大输出独占台账容量，见 recordResult）。 */
const PER_RESULT_CAP = Math.floor(LEDGER_CAP / 2)
/** 递归收集数值的深度上限。8 层太浅——SBML/配置类嵌套 JSON 常超过 8 层，
 *  深层合法数值收不进来会让 agent 引用它们时被误判"无溯源"，故放宽到 24。 */
const DEPTH_CAP = 24
/** 回复扫描时单次最多报告的违规数。 */
const MAX_VIOLATIONS = 5
/** 数值匹配相对容差：允许 agent 做末位四舍五入（52.3 匹配 52.28）。 */
const REL_TOL = 0.002

/**
 * agent → { numbers: number[], tools: string[], sawQuestion: boolean }
 * @type {WeakMap<object, {numbers:number[], tools:string[], sawQuestion:boolean}>}
 */
const ledgers = new WeakMap()
/** session → agent 映射由 rigor-guard 维护；这里只按 agent 存。 */

function ledgerFor(agent) {
  let l = ledgers.get(agent)
  if (!l) {
    l = { numbers: [], tools: [], sawQuestion: false }
    ledgers.set(agent, l)
  }
  return l
}

/** 文本中的数值形态（工具字符串字段与回复扫描共用）。 */
const NUM_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g

/**
 * 递归收集 JSON 值中的有限数值。
 * @param {number[]} out 收集目标
 * @param {number} depth 当前深度（超过 DEPTH_CAP 停止）
 * @param {number} limit 本次采集的数量上限
 * @param {Set<number>} seen 本次已见数值——**边扫边去重**：重复值不该吃光预算
 */
function collectNumbers(value, out, depth, limit, seen) {
  if (depth > DEPTH_CAP || out.length >= limit) return
  if (typeof value === 'number') {
    if (Number.isFinite(value) && !seen.has(value)) { seen.add(value); out.push(value) }
    return
  }
  if (typeof value === 'string') {
    // 工具 stdout/文本字段里的数字也收（agent 常直接引用 print 输出）
    for (const m of value.matchAll(NUM_RE)) {
      const n = Number(m[0])
      if (Number.isFinite(n) && !seen.has(n)) { seen.add(n); out.push(n) }
      if (out.length >= limit) return
    }
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out, depth + 1, limit, seen)
    return
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectNumbers(v, out, depth + 1, limit, seen)
  }
}

/**
 * 两个数是否"同一个数"（精确，或在相对容差内——与 isVerified 同口径）。
 * 去重与验证必须用同一套判定，否则近似值会白占槽位（外部评审 2026-09-12 指出）。
 */
function sameNumber(a, b) {
  if (a === b) return true
  const scale = Math.max(1, Math.abs(a), Math.abs(b))
  return Math.abs(a - b) / scale <= REL_TOL
}

const FALLBACK_AGENT = {}

/**
 * 只给结果挂 _provenance 背书字段（不写台账）。用于 tools.js 执行链，
 * 台账记录由 rigor-guard 的 tools/post-execute 钩子完成（那里拿得到 agent）。
 * @param {string} tool 工具名
 * @param {*} result 工具原始返回
 * @returns {*} 原对象（原地盖章）
 */
export function stampProvenance(tool, result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    if (result._provenance === undefined) {
      result._provenance = { tool, at: new Date().toISOString() }
    }
  }
  return result
}

/**
 * 把工具结果中的数值记入该 agent 的台账。由 rigor-guard 在
 * tools/post-execute 钩子中调用。
 *
 * 两条不变量（2026-09-12 依外部评审 + 本地复现修正）：
 *  ① **无新增数值就不动台账**——旧实现在"本次结果有无数字"尚未可知时先砍掉一半旧数据，
 *     一个空结果就能把历史合法数值清掉，让 agent 引用它们时被误判无溯源（假阳性）。
 *  ② **按需淘汰**——只丢"刚好容纳新数值"所需的量，不再整段砍半。
 *  另：去重索引保证同一数值不在台账里堆积（重复值输出不该挤掉别的数字）。
 *
 * @param {object} agent 调用方 agent（可为空 → 进程级兜底台账）
 * @param {string} tool 工具名
 * @param {*} result 工具返回
 */
export function recordResult(agent, tool, result) {
  const ledger = ledgerFor(agent ?? FALLBACK_AGENT)
  const incoming = []
  collectNumbers(result, incoming, 0, PER_RESULT_CAP, new Set())
  if (incoming.length > 0) {
    // LRU 语义（外部评审 2026-09-12 P1）：本次结果里出现的数值一律视为"刚被确认"，
    // 因此先把旧队列中与之等值（或容差内近似）的条目**整体移除**，再把 incoming 追加到队尾。
    // 旧实现是"先算 fresh 再淘汰"：被当前工具刚回显的最老值既不在 fresh 里、又正好落在
    // 淘汰区 → 明明是当前工具刚证明过的数，却失去了溯源（回归实测复现）。
    const remaining = ledger.numbers.filter((v) => !incoming.some((n) => sameNumber(n, v)))
    const overflow = Math.max(0, remaining.length + incoming.length - LEDGER_CAP)
    ledger.numbers = remaining.slice(overflow).concat(incoming)
  }
  if (!ledger.tools.includes(tool)) ledger.tools.push(tool)
}

/** 记录一次 ask_user_question 调用（含提问的轮次不做强制扫描——决策点允许提议数值）。 */
export function markQuestionAsked(agent) {
  ledgerFor(agent ?? FALLBACK_AGENT).sawQuestion = true
}

/** 本轮回合是否已向用户提问（决策检查点豁免）。 */
export function sawQuestion(agent) {
  return ledgerFor(agent ?? FALLBACK_AGENT).sawQuestion
}

/** 该 agent 台账是否为空（没用过大 bio 工具的会话不启用强制）。 */
export function ledgerSize(agent) {
  return ledgerFor(agent ?? FALLBACK_AGENT).numbers.length
}

/** 新回合开始：重置提问豁免标记（台账数值保留，供跨回合引用）。 */
export function beginTurn(agent) {
  ledgerFor(agent ?? FALLBACK_AGENT).sawQuestion = false
}

/**
 * 数值是否在台账中有溯源（精确或末位舍入容差内）。
 * 小整数（|n|<=20 的整数）与年份（1900-2100）豁免——它们多是计数/编号。
 */
export function isVerified(agent, n) {
  if (Number.isInteger(n) && Math.abs(n) <= 20) return true
  if (Number.isInteger(n) && n >= 1900 && n <= 2100) return true
  const nums = ledgerFor(agent ?? FALLBACK_AGENT).numbers
  for (const v of nums) {
    if (v === n) return true
    if (sameNumber(v, n)) return true
  }
  return false
}

const CODE_BLOCK_RE = /```[\s\S]*?```|`[^`\n]*`/g
const URL_RE = /https?:\/\/\S+/g
// 数值声明：带小数点/科学计数/百分号，或出现在比较语境（= < > ≈ p padj FC）中的数字
const CLAIM_RE = /(?:[=<>≤≥≈:：]|[pP]\s*[=<>]|padj|FC|fold)[^\d\-]{0,12}(-?\d+\.\d+(?:[eE][+-]?\d+)?|-?\d+[eE][+-]?\d+|-?\d+)%?|\b(\d+\.\d+(?:[eE][+-]?\d+)?)\b/g

/**
 * 扫描回复文本，返回无溯源的数值声明（去重，最多 MAX_VIOLATIONS 条）。
 * 扫描前剔除代码块与 URL；版本号链（如 0.6.0、Python 3.12）豁免。
 * @returns {string[]} 违规数字的字面形式
 */
export function findUnverifiedNumbers(agent, text) {
  if (!text) return []
  const clean = text.replace(CODE_BLOCK_RE, ' ').replace(URL_RE, ' ')
  const violations = []
  const seen = new Set()
  for (const m of clean.matchAll(CLAIM_RE)) {
    const raw = m[1] ?? m[2]
    if (raw === undefined) continue
    const n = Number(raw)
    if (!Number.isFinite(n) || seen.has(raw)) continue
    seen.add(raw)
    // 版本号链豁免：数字前后紧跟 .数字 的（如 0.6.0 中的 0.6）
    // 用 lastIndexOf 定位数值：CLAIM_RE 末尾的 `%?` 会吞掉一个字符，
    // 用 m[0].length - raw.length 反推会偏移一位，导致 `= 68.35%` / `: 68.35%`
    // 这类写法读不到 %，不做 ×100 换算，把合法引用误拦（2026-09-12 复现）。
    const numStart = m.index + m[0].lastIndexOf(raw)
    const before = clean[numStart - 1]
    const before2 = clean[numStart - 2]
    const after = clean[numStart + raw.length]
    const after2 = clean[numStart + raw.length + 1]
    if (after === '.' && /\d/.test(after2 ?? '')) continue
    if (before === '.' && /\d/.test(before2 ?? '')) continue
    // 软件版本豁免：小数紧跟在拉丁字母词后（Python 3.12 / Biopython 1.83 等）
    if (/[A-Za-z]\s*$/.test(clean.slice(Math.max(0, numStart - 32), numStart))) continue
    // 百分比换算容忍：工具常以小数给出比例（如 metabolite_formula_coverage 0.6835），
    // agent 以百分数表达（68.35%）。只比原值会把合法的换算引用判成无溯源
    //（E2E 实测：agent 引用 68.35% 被拦两次，最终靠把 68.35 打印成工具输出才通过，
    // 白烧 3 轮 bio_python）。
    const isPercent = after === '%'
    if (!isVerified(agent, n) && !(isPercent && isVerified(agent, n / 100))) {
      violations.push(raw)
      if (violations.length >= MAX_VIOLATIONS) break
    }
  }
  return violations
}
