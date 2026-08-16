// log.js 单元测试：追加/读取/检索 + 损坏行容错。
// 用法：node scripts/test-log.mjs
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLog, readLogs, codeHash } from '../src/log.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const base = mkdtempSync(join(tmpdir(), 'dshbio-log-test-'))
console.log(`[log] 测试目录 ${base}`)

assert(readLogs({}, base).length === 0, '空目录返回空数组')
assert(codeHash('abc') === codeHash('abc') && codeHash('abc') !== codeHash('abd'), 'codeHash 稳定且区分输入')

// 异步写：等待一个 tick 让 appendFile 落盘
appendLog({ kind: 'op', op: 'seq_analyze', ok: true, duration_ms: 5 }, base)
appendLog({ kind: 'bio_python', ok: false, error: 'NameError: pritn', code_preview: 'pritn("hi")', duration_ms: 8 }, base)
appendLog({ kind: 'op', op: 'enrichr', ok: true, duration_ms: 1200 }, base)
await new Promise((r) => setTimeout(r, 300))

const recent = readLogs({ limit: 10 }, base)
assert(recent.length === 3, `追加 3 条可读回 ${recent.length} 条`)
assert(recent[0].op === 'enrichr', '最新在前（enrichr 是最后写入的）')
assert(recent[0].ts && recent[0].duration_ms === 1200, 'ts 自动填充 + 字段完整')

const hit = readLogs({ action: 'search', query: 'NameError', limit: 10 }, base)
assert(hit.length === 1 && hit[0].code_preview === 'pritn("hi")', '按关键词检索命中错误记录')

const miss = readLogs({ action: 'search', query: 'NoSuchThing', limit: 10 }, base)
assert(miss.length === 0, '无命中返回空数组')

// 损坏行容错：手工塞一行坏 JSON，读日志不应崩
const todayFile = join(base, 'log', new Date().toISOString().slice(0, 10) + '.jsonl')
writeFileSync(todayFile, readFileSync(todayFile, 'utf8') + '\n{broken json!!\n', 'utf8')
const after = readLogs({}, base)
assert(after.length === 3, '损坏行被跳过，有效条目不受影响')

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
