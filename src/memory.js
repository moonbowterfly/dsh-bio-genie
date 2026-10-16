/**
 * dsh-bio-genie — 会话记忆（成功模式 + 已验证错误经验）
 *
 * 在 $DSH_HOME/dsh-bio-genie/ 维护：
 *   - memory/success_patterns.json：成功代码模式 {signature, template, tool, ts}
 *     按「意图签名」去重，只存代码前 400 字符模板（不存全文）。
 *   - repair/lessons/<lesson_id>.json：**已验证**错误经验 {type, lesson, proof}
 *     （写入只经 promoteVerifiedLesson + lesson_proof@1；见 Repair Proposal v0）。
 *
 * 【L2 语义收紧（Repair Proposal v0，2026-10-16）】
 * 旧版「失败 → 同意图一次成功即自动写 fix_hint」已移除：未经独立验证的配对不再
 * 进入 L2。经验升级只经 promoteVerifiedLesson(lesson, lesson_proof@1)——proof
 * 来自独立验证（base-red / candidate-green / 冻结 checker），闭集校验 + 交叉校
 * 验；撤销 / 篡改 / 环境不符一律不返回。旧 memory/error_lessons.json 保留但标作
 * LEGACY_UNVERIFIED：不自动迁移、不被 readLessons / searchMemory 返回（仅计数）。
 * 详见 docs/repair-proposal-v0.md 与主 skill 的 ACR 章节。
 *
 * 全部同步读写 + 原子替换；失败静默（记忆故障不影响分析主流程）。
 *
 * @module dsh-bio-genie/memory
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bioRoot } from './runtime.js'
import { LIMITS, validateLesson, validateLessonProof } from './repair-contract.js'
import { listIds, readRecord, writeRecord } from './repair-store.js'
import { readPythonMajor } from './repair-capture.js'

const MAX_PATTERNS = 50
const PKG_URL = new URL('../package.json', import.meta.url)

/** 记忆目录（可传 baseDir 覆盖，便于单元测试）。 */
export function memoryDir(base) {
  return join(base ?? bioRoot(), 'memory')
}

const patternsFile = (base) => join(memoryDir(base), 'success_patterns.json')
const legacyLessonsFile = (base) => join(memoryDir(base), 'error_lessons.json')

function readJson(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function atomicWrite(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    /* 静默 */
  }
}

/**
 * 代码「意图签名」：import 的 Bio.* 模块 + 调用的 Bio.* 函数。
 * 刻意不含普通函数名——修复代码常改函数名（如 GC() → gc_fraction()），
 * 含函数名会导致「失败/修复」无法配对到同一意图。
 */
export function codeSignature(code) {
  const text = String(code ?? '')
  const imports = new Set()
  const names = new Set()
  const calls = new Set()
  // from Bio import SeqIO / from Bio.Seq import Seq —— 记录导入的顶层名字
  for (const m of text.matchAll(/from\s+(Bio[\w.]*)\s+import\s+([^\n;]+)/g)) {
    imports.add(m[1].trim())
    for (const n of m[2].replace(/[()*]/g, ' ').split(',')) {
      const nm = n.trim().split(/\s+as\s+/).pop().trim()
      if (nm) names.add(nm)
    }
  }
  // import Bio / import Bio.Align
  for (const m of text.matchAll(/\bimport\s+(Bio[\w.]*)/g)) imports.add(m[1].trim())
  // Bio.xxx() 直接调用
  for (const m of text.matchAll(/\b(Bio\.[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)) calls.add(m[1])
  // SeqIO.parse() / Seq.translate() —— 经 from-import 的名字调用（Biopython 最常见的写法）
  const nameAlt = [...names].join('|')
  if (nameAlt) {
    const re = new RegExp(`\\b(${nameAlt})\\.[A-Za-z_]\\w*`, 'g')
    for (const m of text.matchAll(re)) calls.add(`${m[1]}.*`)
  }
  return [...imports].sort().join('|') + ' :: ' + [...calls].slice(0, 8).sort().join('|')
}

/** 从 stderr 提取错误签名：traceback 最后一行的 `XxxError: message`（截断 120 字符）。
 *  ⚠️ 仅供**本地进程内**配对/分类枚举使用；原始 message 可能携带路径/数据，
 *  绝不进入 repair incident / 公开产物（见 docs/repair-proposal-v0.md）。 */
export function errorSignature(stderr) {
  const text = String(stderr ?? '')
  let last = null
  for (const m of text.matchAll(/(?:^|\n)([A-Za-z_][\w.]*(?:Error|Exception)):\s*([^\n]*)/g)) {
    last = m
  }
  if (last) return `${last[1]}: ${last[2].slice(0, 120)}`
  const tail = text.trim().split('\n').pop().slice(0, 120)
  return tail || 'unknown'
}

/** 记成功模式（同签名去重、保留最新模板，上限 50 条）。 */
export function rememberSuccess({ signature, template, tool }, base) {
  try {
    const file = patternsFile(base)
    const bySig = new Map(readJson(file).map((e) => [e.signature, e]))
    bySig.set(signature, {
      signature,
      template: String(template ?? '').slice(0, 400),
      tool: tool ?? 'bio_python',
      ts: new Date().toISOString(),
    })
    const entries = [...bySig.values()].sort((a, b) => (a.ts < b.ts ? -1 : 1))
    atomicWrite(file, entries.slice(-MAX_PATTERNS))
  } catch {
    /* 静默 */
  }
}

/** 成功模式（新在前）。 */
export function readPatterns(base) {
  return readJson(patternsFile(base)).reverse()
}

/** 旧版未验证经验（LEGACY_UNVERIFIED）计数——只计不返（维护者参考）。 */
export function legacyLessonCount(base) {
  return readJson(legacyLessonsFile(base)).length
}

/** 当前插件版本（环境兼容判定用；读包内 package.json）。 */
function currentPluginVersion() {
  try {
    return JSON.parse(readFileSync(PKG_URL, 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * 写入一条**已验证**经验（L2 的唯一写入口）。只接受 lesson_proof@1：
 * 闭集校验（lesson + proof）→ 交叉校验（lesson_id 一致、revoked=false）→
 * 写 repair store（非 memory/，不进科研目录）。上限 LIMITS.max_lessons。
 * @returns {{ok: true, lesson_id: string} | {ok: false, code: string, errors?: object[], message?: string}}
 */
export function promoteVerifiedLesson(lesson, proof, base) {
  try {
    const lv = validateLesson(lesson)
    if (!lv.ok) return { ok: false, code: 'LESSON_SCHEMA', errors: lv.errors.slice(0, 3) }
    const pv = validateLessonProof(proof)
    if (!pv.ok) return { ok: false, code: 'PROOF_SCHEMA', errors: pv.errors.slice(0, 3) }
    if (proof.lesson_id !== lesson.lesson_id) return { ok: false, code: 'PROOF_LESSON_MISMATCH' }
    if (proof.revoked !== false) return { ok: false, code: 'PROOF_REVOKED' }
    writeRecord('lessons', lesson.lesson_id, { type: 'lesson', lesson, proof }, { base, cap: LIMITS.max_lessons })
    return { ok: true, lesson_id: lesson.lesson_id }
  } catch (err) {
    return { ok: false, code: err.code ?? 'PROMOTE_FAILED', message: String(err.message ?? err).slice(0, 200) }
  }
}

/**
 * 读取已验证经验（新在前）。过滤链：sidecar 完整性 → status=VERIFIED →
 * proof 闭集有效 → proof 未撤销 → 环境指纹兼容（版本不符即不返回）。
 * legacy（error_lessons.json）**永不返回**。
 * @param {string} [base]
 * @param {{env?: {plugin: string|null, python: string|null}}} [opts] 覆盖当前环境（测试用）
 */
export function readLessons(base, { env } = {}) {
  const current = env ?? { plugin: currentPluginVersion(), python: readPythonMajor() }
  const out = []
  for (const id of listIds('lessons', { base })) {
    try {
      const { record } = readRecord('lessons', id, { base })
      if (!record || record.type !== 'lesson' || !record.lesson || !record.proof) continue
      const { lesson, proof } = record
      if (lesson.status !== 'VERIFIED') continue
      if (proof.revoked === true) continue
      if (!validateLesson(lesson).ok) continue
      if (!validateLessonProof(proof).ok) continue
      if (current.plugin && lesson.env?.plugin && lesson.env.plugin !== current.plugin) continue
      if (current.python && lesson.env?.python && lesson.env.python !== current.python) continue
      out.push({
        lesson_id: lesson.lesson_id,
        error_signature: lesson.error_signature,
        fix_hint: lesson.fix_hint,
        env: lesson.env,
        proof_id: proof.proof_id,
        ts: lesson.created_at,
      })
    } catch { /* 坏记录/篡改：不返回（由 bio_repair_ledger_verify 报告） */ }
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  return out
}

/** 跨两类记忆按关键词检索（lessons 仅返回已验证）。 */
export function searchMemory(query, base) {
  const q = String(query ?? '').toLowerCase()
  const patterns = readPatterns(base).filter((e) => JSON.stringify(e).toLowerCase().includes(q))
  const lessons = readLessons(base).filter((e) => JSON.stringify(e).toLowerCase().includes(q))
  return { patterns: patterns.slice(0, 10), lessons: lessons.slice(0, 10) }
}

/** 判断记忆是否已初始化（bio_memory 工具提示用）。 */
export function memoryExists(base) {
  if (existsSync(patternsFile(base)) || existsSync(legacyLessonsFile(base))) return true
  return listIds('lessons', { base }).length > 0
}
