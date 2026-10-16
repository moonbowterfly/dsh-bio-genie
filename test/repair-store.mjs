// repair-store 单元测试：原子写/完整性/锁/CAS/上限/扫描。
// 用法：node test/repair-store.mjs
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync,
  unlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  countRecords, listIds, readRecord, repairRoot, scanStore, transitionIncident, updateRecord, writeRecord,
} from '../src/repair-store.js'
import { newUuid } from '../src/repair-contract.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const mkBase = () => mkdtempSync(join(tmpdir(), 'dshbio-store-'))

// ① roundtrip + sidecar + 锁释放
console.log('[store] roundtrip / sidecar / lock 释放')
{
  const base = mkBase()
  const id = newUuid()
  const { sha256 } = writeRecord('incidents', id, { state: 'OBSERVED', note: 'A' }, { base })
  const back = readRecord('incidents', id, { base })
  assert(back.record.state === 'OBSERVED' && back.record.note === 'A', 'roundtrip 读写一致')
  assert(back.sha256 === sha256 && /^[0-9a-f]{64}$/.test(sha256), 'sidecar hash 回读一致')
  assert(existsSync(join(repairRoot(base), 'incidents', `${id}.json.sha256`)), 'sidecar 文件存在')
  assert(!existsSync(join(repairRoot(base), '.lock')), '锁已释放')
  assert(listIds('incidents', { base }).length === 1 && countRecords('incidents', base) === 1, 'list/count 一致')
  const scan = scanStore({ base })
  assert(scan.ok && scan.counts.incidents === 1, 'scanStore 健康')
}

// ② 篡改一字节 → INTEGRITY_FAILED；覆盖写可修复
console.log('[store] 字节级篡改检测')
{
  const base = mkBase()
  const id = newUuid()
  writeRecord('incidents', id, { state: 'OBSERVED', note: 'A' }, { base })
  const file = join(repairRoot(base), 'incidents', `${id}.json`)
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, text.replace('"A"', '"B"')) // 同长度替换
  let code = null
  try { readRecord('incidents', id, { base }) } catch (e) { code = e.code }
  assert(code === 'INTEGRITY_FAILED', `篡改被检出（code=${code}）`)
  const scan = scanStore({ base })
  assert(!scan.ok && scan.issues.some((i) => i.code === 'INTEGRITY_FAILED'), 'scanStore 报 INTEGRITY_FAILED')
  writeRecord('incidents', id, { state: 'OBSERVED', note: 'A' }, { base })
  assert(readRecord('incidents', id, { base }).record.note === 'A', '覆盖写修复完整性')
}

// ③ id 白名单 / 路径穿越
console.log('[store] id 白名单')
{
  const base = mkBase()
  for (const bad of ['../../etc/passwd', 'abc', 'x'.repeat(80), `../${newUuid()}`, `${newUuid()}X`]) {
    let code = null
    try { readRecord('incidents', bad, { base }) } catch (e) { code = e.code }
    assert(code === 'BAD_ID', `非法 id 被拒：${String(bad).slice(0, 24)}`)
  }
  let wcode = null
  try { writeRecord('incidents', '../evil', {}, { base }) } catch (e) { wcode = e.code }
  assert(wcode === 'BAD_ID', '写入侧同样拒非法 id')
  assert(!existsSync(join(base, 'evil.json')), '未发生越界写')
}

// ④ symlink 拒读（同内容目标——只有 lstat 检查能拦住）
console.log('[store] symlink/reparse 拒读')
{
  const base = mkBase()
  const id = newUuid()
  writeRecord('incidents', id, { state: 'OBSERVED', note: 'S' }, { base })
  const file = join(repairRoot(base), 'incidents', `${id}.json`)
  const original = readFileSync(file)
  const outside = join(base, 'outside.json')
  writeFileSync(outside, original)
  unlinkSync(file)
  let symlinked = false
  try { symlinkSync(outside, file); symlinked = true } catch { /* Windows 需开发者模式 */ }
  if (symlinked) {
    let code = null
    try { readRecord('incidents', id, { base }) } catch (e) { code = e.code }
    assert(code === 'NOT_REGULAR_FILE', `symlink 被拒（code=${code}）`)
    unlinkSync(file)
  } else {
    console.log('  SKIP symlink 用例（本环境不允许创建 symlink）')
  }
  writeRecord('incidents', id, { state: 'OBSERVED', note: 'S' }, { base })
  assert(readRecord('incidents', id, { base }).record.note === 'S', '记录可恢复')
}

// ⑤ 锁：BUSY + 过期回收
console.log('[store] 互斥锁')
{
  const base = mkBase()
  writeRecord('incidents', newUuid(), { state: 'OBSERVED' }, { base })
  const lockFile = join(repairRoot(base), '.lock')
  writeFileSync(lockFile, JSON.stringify({ pid: 1, ts: Date.now() }))
  let code = null
  try { writeRecord('incidents', newUuid(), { state: 'OBSERVED' }, { base, lockTimeoutMs: 250 }) } catch (e) { code = e.code }
  assert(code === 'STORE_BUSY', `持锁时写被拒（code=${code}）`)
  const old = new Date(Date.now() - 60_000)
  utimesSync(lockFile, old, old)
  writeRecord('incidents', newUuid(), { state: 'OBSERVED' }, { base })
  assert(!existsSync(lockFile), '过期锁被回收且正常释放')
  assert(countRecords('incidents', base) === 2, '两笔写入成功')
}

// ⑥ CAS / 状态迁移
console.log('[store] CAS 与状态迁移')
{
  const base = mkBase()
  const id = newUuid()
  writeRecord('incidents', id, { state: 'OBSERVED' }, { base })
  let code = null
  try { updateRecord('incidents', id, (r) => r, { base, expect: () => false }) } catch (e) { code = e.code }
  assert(code === 'CAS_MISMATCH', `expect 守卫失败 → CAS_MISMATCH（${code}）`)
  assert(readRecord('incidents', id, { base }).record.state === 'OBSERVED', 'CAS 失败不落任何字节')
  code = null
  try { transitionIncident(id, 'RELEASED', { base }) } catch (e) { code = e.code }
  assert(code === 'INVALID_TRANSITION', `非法迁移被拒（${code}）`)
  transitionIncident(id, 'TRIAGED', { base, expectState: 'OBSERVED' })
  assert(readRecord('incidents', id, { base }).record.state === 'TRIAGED', '合法迁移生效')
  code = null
  try { transitionIncident(id, 'REPRODUCIBLE', { base, expectState: 'OBSERVED' }) } catch (e) { code = e.code }
  assert(code === 'CAS_MISMATCH', '过期 expectState → CAS_MISMATCH')
  assert(readRecord('incidents', id, { base }).record.state === 'TRIAGED', 'CAS 失败保持原状态')
}

// ⑦ 上限
console.log('[store] 上限')
{
  const base = mkBase()
  writeRecord('receipts', newUuid(), { n: 1 }, { base, cap: 1 })
  let code = null
  try { writeRecord('receipts', newUuid(), { n: 2 }, { base, cap: 1 }) } catch (e) { code = e.code }
  assert(code === 'STORE_CAP', `cap 到顶拒写（${code}）`)
  const first = listIds('receipts', { base })[0]
  writeRecord('receipts', first, { n: 3 }, { base, cap: 1 })
  assert(readRecord('receipts', first, { base }).record.n === 3, '覆盖写不受 cap 限制')
}

// ⑧ 失败回滚 + 残留 tmp 检出
console.log('[store] 失败回滚与残留检测')
{
  const base = mkBase()
  const id = newUuid()
  let threw = false
  try { writeRecord('lessons', id, { big: 10n }, { base }) } catch { threw = true }
  assert(threw, 'BigInt 序列化失败被抛出')
  const lessonsDir = join(repairRoot(base), 'lessons')
  assert(!existsSync(join(lessonsDir, `${id}.json`)), '失败未留 record 文件')
  assert(readdirSync(lessonsDir).every((f) => !f.endsWith('.tmp')), '失败未留 tmp')
  assert(!existsSync(join(repairRoot(base), '.lock')), '失败后锁已释放')
  writeFileSync(join(lessonsDir, '.deadbeef.tmp'), 'x')
  const scan = scanStore({ base })
  assert(!scan.ok && scan.issues.some((i) => i.code === 'STRAY_TEMP'), 'scanStore 检出残留 tmp')
}

// ⑨ 坏文件名 / 孤儿 sidecar
console.log('[store] 扫描：坏文件名与孤儿 sidecar')
{
  const base = mkBase()
  const dir = join(repairRoot(base), 'incidents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'notauuid.json'), '{}')
  writeFileSync(join(dir, `${newUuid()}.json.sha256`), '0'.repeat(64))
  const scan = scanStore({ base })
  assert(scan.issues.some((i) => i.code === 'BAD_ID_FILENAME'), '坏文件名被检出')
  assert(scan.issues.some((i) => i.code === 'ORPHAN_SIDECAR'), '孤儿 sidecar 被检出')
}

// ⑩ 不存在的 record
console.log('[store] 边界')
{
  const base = mkBase()
  let code = null
  try { readRecord('incidents', newUuid(), { base }) } catch (e) { code = e.code }
  assert(code === 'NOT_FOUND', '不存在 → NOT_FOUND')
  let kcode = null
  try { readRecord('bogus', newUuid(), { base }) } catch (e) { kcode = e.code }
  assert(kcode === 'BAD_KIND', '非法 kind 被拒')
}

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
