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

/** 递归收集 JSON 值中的有限数值（裁剪到台账容量）。 */
function collectNumbers(value, out, depth) {
  if (depth > 8 || out.length >= LEDGER_CAP) return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) out.push(value)
    return
  }
  if (typeof value === 'string') {
    // 工具 stdout/文本字段里的数字也收（agent 常直接引用 print 输出）
    for (const m of value.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
      const n = Number(m[0])
      if (Number.isFinite(n)) out.push(n)
      if (out.length >= LEDGER_CAP) return
    }
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectNumbers(v, out, depth + 1)
  }
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
 * @param {object} agent 调用方 agent（可为空 → 进程级兜底台账）
 * @param {string} tool 工具名
 * @param {*} result 工具返回
 */
export function recordResult(agent, tool, result) {
  const ledger = ledgerFor(agent ?? FALLBACK_AGENT)
  collectNumbers(result, ledger.numbers, 0)
  if (ledger.numbers.length > LEDGER_CAP) {
    ledger.numbers.splice(0, ledger.numbers.length - LEDGER_CAP)
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
    const scale = Math.max(1, Math.abs(v), Math.abs(n))
    if (Math.abs(v - n) / scale <= REL_TOL) return true
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
    const numStart = m.index + m[0].length - raw.length
    const before = clean[numStart - 1]
    const before2 = clean[numStart - 2]
    const after = clean[numStart + raw.length]
    const after2 = clean[numStart + raw.length + 1]
    if (after === '.' && /\d/.test(after2 ?? '')) continue
    if (before === '.' && /\d/.test(before2 ?? '')) continue
    // 软件版本豁免：小数紧跟在拉丁字母词后（Python 3.12 / Biopython 1.83 等）
    if (/[A-Za-z]\s*$/.test(clean.slice(Math.max(0, numStart - 32), numStart))) continue
    if (!isVerified(agent, n)) {
      violations.push(raw)
      if (violations.length >= MAX_VIOLATIONS) break
    }
  }
  return violations
}
