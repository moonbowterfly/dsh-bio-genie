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
import { appendFile, mkdir, readFileSync, readdirSync, existsSync, statSync, unlinkSync } from 'node:fs'
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

/** 日志保留天数：超过 30 天的 *.jsonl 自动清理。 */
export const LOG_RETENTION_DAYS = 30

/**
 * 30 天轮转：删除日志目录中修改时间早于 retentionDays 的 *.jsonl。
 * 防竞态：删除前二次 stat 复核 mtime（若并发实例刚写入导致 mtime 更新则跳过），
 * 单文件失败与整体失败均静默——日志清理绝不影响分析主流程。
 * @param {string} [base] 覆盖日志根目录（测试用）
 * @param {number} [retentionDays]
 * @returns {string[]} 实际删除的文件名
 */
export function rotateLogs(base, retentionDays = LOG_RETENTION_DAYS) {
  const removed = []
  try {
    const dir = logDir(base)
    if (!existsSync(dir)) return removed
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const p = join(dir, f)
      try {
        const st = statSync(p)
        if (!st.isFile() || st.mtimeMs >= cutoff) continue
        // 删除前再次 stat 复核：mtime 变化（并发写入）则放弃删除
        const st2 = statSync(p)
        if (!st2.isFile() || st2.mtimeMs !== st.mtimeMs || st2.mtimeMs >= cutoff) continue
        unlinkSync(p)
        removed.push(f)
      } catch {
        /* 单文件失败静默 */
      }
    }
  } catch {
    /* 轮转整体失败静默 */
  }
  return removed
}

/** 每进程只轮转一次，避免每次写日志都扫描目录。 */
let rotatedThisProcess = false

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
  if (!rotatedThisProcess) {
    rotatedThisProcess = true
    rotateLogs(base) // 30 天轮转（每进程一次，内部失败静默）
  }
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
