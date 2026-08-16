/**
 * dsh-bio-genie — 透明性执行日志（P1-5，借鉴 BRAD 透明性日志）
 *
 * 每次 bio_python 代码执行 / 语义化工具调用，异步追加一条 JSONL 到
 * $DSH_HOME/dsh-bio-genie/log/YYYY-MM-DD.jsonl，支持回溯
 * 「某次分析用了什么代码、什么数据、结果如何、耗时多少」。
 *
 * - 不存全代码（隐私 + 体积）：只存 sha256 哈希 + 前 200 字符预览
 * - 异步写（appendFile 不阻塞主返回，保住秒级就绪）
 * - 失败静默：日志故障绝不影响分析主流程
 *
 * @module dsh-bio-genie/log
 */
import { appendFile, mkdir, readFileSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { bioRoot } from './runtime.js'

/** 日志目录（可传 baseDir 覆盖，便于单元测试）。 */
export function logDir(base) {
  return join(base ?? bioRoot(), 'log')
}

function logFileFor(dateStr, base) {
  return join(logDir(base), `${dateStr}.jsonl`)
}

/** 代码 sha256（16 位短哈希，够用于去重/回溯且不泄全文）。 */
export function codeHash(code) {
  return createHash('sha256').update(String(code)).digest('hex').slice(0, 16)
}

/** 串行写链：并发 appendFile 的落盘顺序不保证，串行化保证日志 FIFO。 */
let writeChain = Promise.resolve()

/**
 * 异步追加一条日志。失败静默（日志不应影响分析主流程）。
 * @param {object} entry 日志条目（ts 由本函数填充）
 * @param {string} [base] 覆盖日志根目录（测试用）
 */
export function appendLog(entry, base) {
  const dir = logDir(base)
  const dateStr = new Date().toISOString().slice(0, 10)
  const record = { ts: new Date().toISOString(), ...entry }
  writeChain = writeChain
    .then(() => new Promise((resolve) => {
      // 先确保目录存在（异步 mkdir），再异步 append；任一失败静默
      mkdir(dir, { recursive: true }, (err) => {
        if (err) return resolve()
        appendFile(logFileFor(dateStr, base), JSON.stringify(record) + '\n', 'utf8', () => resolve())
      })
    }))
    .catch(() => {})
}

/**
 * 读日志（bio_log 工具后端）。
 * @param {{action?: 'recent'|'search', query?: string, limit?: number, days?: number}} opts
 * @param {string} [base] 覆盖日志根目录（测试用）
 * @returns {object[]} 新→旧排序的条目
 */
export function readLogs({ action = 'recent', query = '', limit = 20, days = 7 } = {}, base) {
  const dir = logDir(base)
  const out = []
  if (!existsSync(dir)) return out
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().reverse()
  for (const f of files.slice(0, days)) {
    let text
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* 跳过损坏行 */
      }
    }
  }
  out.reverse() // 新在前
  if (action === 'search' && query) {
    const q = query.toLowerCase()
    return out.filter((e) => JSON.stringify(e).toLowerCase().includes(q)).slice(0, limit)
  }
  return out.slice(0, limit)
}
