/**
 * dsh-bio-genie — 会话记忆与错误学习（P1-2，借鉴 AutoBA 记忆 + BioAgent 会话学习）
 *
 * 在 $DSH_HOME/dsh-bio-genie/memory/ 维护两份 JSON：
 *   - success_patterns.json：成功代码模式 {signature, template, tool, ts}
 *     按「意图签名」（import 的 Bio.* 模块 + 调用的 Bio.* 函数）去重，
 *     只存代码前 400 字符模板，不存全文。
 *   - error_lessons.json：错误→修复映射 {error_signature, fix_hint, example, ts}
 *     由 tools.js 配对「失败 → 修复后成功」自动沉淀，上限 50 条 FIFO。
 *
 * 全部同步读写 + 临时文件原子替换；失败静默（记忆故障不影响分析主流程）。
 *
 * @module dsh-bio-genie/memory
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bioRoot } from './runtime.js'

const MAX_PATTERNS = 50
const MAX_LESSONS = 50

/** 记忆目录（可传 baseDir 覆盖，便于单元测试）。 */
export function memoryDir(base) {
  return join(base ?? bioRoot(), 'memory')
}

const patternsFile = (base) => join(memoryDir(base), 'success_patterns.json')
const lessonsFile = (base) => join(memoryDir(base), 'error_lessons.json')

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

/** 从 stderr 提取错误签名：traceback 最后一行的 `XxxError: message`（截断 120 字符）。 */
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

/** 记错误修复经验（同错误签名去重、保留最新修法，上限 50 条 FIFO）。 */
export function rememberLesson({ error_signature, fix_hint, example }, base) {
  try {
    const file = lessonsFile(base)
    const byErr = new Map(readJson(file).map((e) => [e.error_signature, e]))
    byErr.set(error_signature, {
      error_signature,
      fix_hint: String(fix_hint ?? '').slice(0, 400),
      example: String(example ?? '').slice(0, 400),
      ts: new Date().toISOString(),
    })
    const entries = [...byErr.values()].sort((a, b) => (a.ts < b.ts ? -1 : 1))
    atomicWrite(file, entries.slice(-MAX_LESSONS))
  } catch {
    /* 静默 */
  }
}

/** 成功模式（新在前）。 */
export function readPatterns(base) {
  return readJson(patternsFile(base)).reverse()
}

/** 错误修复经验（新在前）。 */
export function readLessons(base) {
  return readJson(lessonsFile(base)).reverse()
}

/** 跨两类记忆按关键词检索。 */
export function searchMemory(query, base) {
  const q = String(query ?? '').toLowerCase()
  const patterns = readPatterns(base).filter((e) => JSON.stringify(e).toLowerCase().includes(q))
  const lessons = readLessons(base).filter((e) => JSON.stringify(e).toLowerCase().includes(q))
  return { patterns: patterns.slice(0, 10), lessons: lessons.slice(0, 10) }
}

/** 判断记忆是否已初始化（bio_memory 工具提示用）。 */
export function memoryExists(base) {
  return existsSync(patternsFile(base)) || existsSync(lessonsFile(base))
}
