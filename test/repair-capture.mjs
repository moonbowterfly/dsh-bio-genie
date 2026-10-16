// repair-capture 单元测试：token 一次性/TTL/指纹/脱敏/去重/限流/失败关闭。
// 用法：node test/repair-capture.mjs
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureIncident, computeFingerprint, issueObservationToken } from '../src/repair-capture.js'
import { listIds, readRecord, repairRoot, scanStore } from '../src/repair-store.js'
import { LIMITS } from '../src/repair-contract.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const base = mkdtempSync(join(tmpdir(), 'dshbio-cap-store-'))
const root = mkdtempSync(join(tmpdir(), 'dshbio-cap-root-'))
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@dsh-bio/dsh-bio-genie', version: '9.9.9' }))
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1\n')
writeFileSync(join(root, 'src', 'b.js'), 'export const b = 2\n')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// ① token 形态 + 首次 traceback 不落盘
console.log('[capture] token 与惰性')
const t1 = issueObservationToken({ root })
assert(typeof t1 === 'string' && UUID_RE.test(t1), 'token 为 UUID')
assert(!t1.includes('Traceback') && t1.length < 80, 'token 不含任何 raw 内容')
assert(listIds('incidents', { base }).length === 0, '发 token 不创建 durable incident')

// ② capture 成功（字段闭集 + 固定语义）
console.log('[capture] 显式 capture → OBSERVED（脱敏）')
const r1 = captureIncident({ token: t1, base, root })
assert(r1.ok && r1.deduped === false && r1.state === 'OBSERVED', `capture ok（${JSON.stringify(r1)}）`)
const { record } = readRecord('incidents', r1.incident_id, { base })
const keys = Object.keys(record).sort().join(',')
assert(keys === 'attribution,created_at,dedupe_key,incident_id,op_id,package_fingerprint,plugin_id,privacy,schema,source_kind,state,symptom_class,tool_id', 'incident 字段闭集')
assert(record.attribution === 'UNVERIFIED' && record.privacy === 'SANITIZED', 'attribution/privacy 固定值')
assert(record.package_fingerprint.version === '9.9.9', '指纹版本来自 package.json')
assert(/^dk_[0-9a-f]{32}$/.test(record.dedupe_key), 'dedupe_key 形态')
assert(!JSON.stringify(record).includes('Traceback'), '记录不含 traceback 文本')

// ③ 重放拒绝
const r1b = captureIncident({ token: t1, base, root })
assert(!r1b.ok && r1b.code === 'TOKEN_ALREADY_USED', `重放被拒（${r1b.code}）`)

// ④ 未知 token
const r2 = captureIncident({ token: '11111111-2222-3333-4444-555555555555', base, root })
assert(!r2.ok && r2.code === 'TOKEN_UNKNOWN', '未知 token 被拒')

// ⑤ 过期
const t3 = issueObservationToken({ root, ttlMs: -1000 })
const r3 = captureIncident({ token: t3, base, root })
assert(!r3.ok && r3.code === 'TOKEN_EXPIRED', '过期 token 被拒')

// ⑥ 指纹不符（安装态变化 → fail closed）
console.log('[capture] 指纹绑定')
{
  const fpA = computeFingerprint({ root })
  const fpB = computeFingerprint({ root })
  assert(fpA.sources_sha256 === fpB.sources_sha256, '指纹可重复计算（确定性）')
  const t4 = issueObservationToken({ root })
  writeFileSync(join(root, 'src', 'b.js'), 'export const b = 42\n')
  const fpC = computeFingerprint({ root })
  assert(fpC.sources_sha256 !== fpA.sources_sha256, '文件变更 → 树哈希变化')
  const r4 = captureIncident({ token: t4, base, root })
  assert(!r4.ok && r4.code === 'FINGERPRINT_MISMATCH', '指纹不符被拒')
  assert(listIds('incidents', { base }).length === 1, '失败捕获未落盘')
}

// ⑦ 去重（同指纹活跃 incident 复用）
console.log('[capture] 去重')
{
  const t5 = issueObservationToken({ root })
  const r5 = captureIncident({ token: t5, base, root })
  assert(r5.ok && r5.deduped === false, '指纹变更后新建 incident')
  const t6 = issueObservationToken({ root })
  const r6 = captureIncident({ token: t6, base, root })
  assert(r6.ok && r6.deduped === true && r6.incident_id === r5.incident_id, '同指纹第二次去重复用')
  assert(listIds('incidents', { base }).length === 2, 'incident 总数 = 2')
}

// ⑧ 限流（放最后：窗口内成功数到顶即拒）
console.log('[capture] 限流')
{
  let successes = 3 // r1 + r5 + r6
  let limited = null
  for (let i = 0; i < 40 && !limited; i += 1) {
    const tk = issueObservationToken({ root })
    const r = captureIncident({ token: tk, base, root })
    if (r.ok) successes += 1
    else limited = r
  }
  assert(limited && limited.code === 'RATE_LIMITED', `限流触发（${limited ? limited.code : 'never'}）`)
  assert(successes === LIMITS.max_captures_per_hour, `窗口内成功数 = ${LIMITS.max_captures_per_hour}（实际 ${successes}）`)
}

// ⑨ 最终 store 健康
console.log('[capture] 收尾')
{
  const scan = scanStore({ base })
  assert(scan.ok, `store 健康（issues=${JSON.stringify(scan.issues)}）`)
  assert(!existsSync(join(repairRoot(base), '.lock')), '无锁残留')
}

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
