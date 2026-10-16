// repair-contract 单元测试：闭集 schema / 状态机 / canonical 化 / 策略校验 / 机读镜像防漂移。
// 用法：node test/repair-contract.mjs
import { readFileSync } from 'node:fs'
import {
  describeContract, validateIncident, validateProposalRequest, validateReceipt,
  validateLessonProof, validateLesson, canTransition, canonicalize, recordHash, sha256Hex,
  validateProposalFiles, DEFAULT_POLICY, LIMITS, STATES,
} from '../src/repair-contract.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'))

// ── 机读镜像防漂移（states / transitions / schemas / limits） ──
console.log('[contract] 机读镜像与 JS 模块交叉核对')
const cj = readJson('../design/repair/repair-contract-v0.json')
const pj = readJson('../design/repair/repair-policy-v0.json')
const d = describeContract()
assert(JSON.stringify(cj.states) === JSON.stringify(d.states), 'states 与 design JSON 一致')
{
  let all = true
  for (const [from, tos] of Object.entries(d.transitions)) {
    if (JSON.stringify(cj.transitions[from]) !== JSON.stringify(tos)) { all = false; console.error(`    drift: transitions.${from}`) }
  }
  const extra = Object.keys(cj.transitions).filter((k) => !(k in d.transitions))
  if (extra.length) { all = false; console.error(`    extra: ${extra.join(',')}`) }
  assert(all, 'transitions 全表与 design JSON 一致')
}
{
  let all = true
  for (const [key, schema] of Object.entries(d.schemas)) {
    const fieldsJson = cj.schemas?.[key]?.fields
    if (JSON.stringify(fieldsJson) !== JSON.stringify(schema.fields)) { all = false; console.error(`    drift: schemas.${key}`) }
    if (cj.schemas?.[key]?.name !== schema.name) { all = false; console.error(`    drift: schemas.${key}.name`) }
  }
  assert(all, '五 schema 字段集与 design JSON 一致')
}
assert(JSON.stringify(cj.limits) === JSON.stringify(d.limits), 'limits 与 design JSON 一致')

// ── policy 镜像防漂移 ──
assert(pj.mode === DEFAULT_POLICY.mode && pj.plugin_id === DEFAULT_POLICY.plugin_id, 'policy: mode/plugin_id 一致')
assert(JSON.stringify(pj.capture) === JSON.stringify(DEFAULT_POLICY.capture), 'policy: capture 段一致')
assert(JSON.stringify(pj.limits) === JSON.stringify(DEFAULT_POLICY.limits), 'policy: limits 一致')
assert(JSON.stringify(pj.proposal.exact_deny) === JSON.stringify(DEFAULT_POLICY.proposal.exact_deny), 'policy: exact_deny 一致')
assert(JSON.stringify(pj.proposal.prefix_deny) === JSON.stringify(DEFAULT_POLICY.proposal.prefix_deny), 'policy: prefix_deny 一致')
assert(JSON.stringify(pj.proposal.suffix_deny) === JSON.stringify(DEFAULT_POLICY.proposal.suffix_deny), 'policy: suffix_deny 一致')
assert(pj.proposal.enabled === false, 'policy: v0 proposal.enabled=false')

// ── canonical 化 / hash ──
console.log('[contract] canonical 化与 hash')
assert(canonicalize({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }) === '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}', 'canonical: 递归键排序')
assert(canonicalize({ a: 1, b: 2 }) === canonicalize({ b: 2, a: 1 }), 'canonical: 键序无关')
assert(sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256: 已知向量')
assert(recordHash({ x: 1, y: 'z' }) === recordHash({ y: 'z', x: 1 }), 'recordHash: 键序无关')
assert(recordHash({ x: 1 }) !== recordHash({ x: 2 }), 'recordHash: 值变化即变化')

// ── incident 闭集校验 ──
console.log('[contract] incident 闭集')
const uuid = () => '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const mkIncident = () => ({
  schema: 'g-repair-incident/v1',
  incident_id: uuid(),
  state: 'OBSERVED',
  attribution: 'UNVERIFIED',
  source_kind: 'bio_python',
  plugin_id: 'dsh-bio-genie',
  package_fingerprint: { package: '@dsh-bio/dsh-bio-genie', version: '0.6.51', node: '26.7.0', python: '3.12', sources_sha256: 'a'.repeat(64) },
  tool_id: 'bio_python',
  op_id: null,
  symptom_class: 'PYTHON_TRACEBACK',
  dedupe_key: 'dk_' + 'b'.repeat(32),
  created_at: '2026-10-16T20:00:00+08:00',
  privacy: 'SANITIZED',
})
assert(validateIncident(mkIncident()).ok, 'valid incident 通过')
{
  const bad = mkIncident(); bad.raw_stderr = 'Traceback...'
  const r = validateIncident(bad)
  assert(!r.ok && r.errors.some((e) => e.code === 'UNKNOWN_FIELD' && e.path.includes('raw_stderr')), 'raw 字段被拒（UNKNOWN_FIELD）')
}
{
  const bad = mkIncident(); bad.code_preview = 'from Bio import ...'
  assert(!validateIncident(bad).ok, 'code_preview 类字段被拒')
}
{
  const bad = mkIncident(); bad.incident_id = '../../etc/passwd'
  const r = validateIncident(bad)
  assert(!r.ok && r.errors.some((e) => e.code === 'PATTERN_MISMATCH'), '非法 incident_id 被拒')
}
{
  const bad = mkIncident(); bad.state = 'BOGUS'
  assert(!validateIncident(bad).ok, '非法 state 被拒')
}
{
  const bad = mkIncident(); bad.op_id = 'a'.repeat(100)
  const r = validateIncident(bad)
  assert(!r.ok && r.errors.some((e) => e.code === 'TOO_LONG'), '过长字段被拒（TOO_LONG）')
}
{
  const bad = mkIncident(); bad.created_at = 'not-a-date'
  assert(!validateIncident(bad).ok, '非法时间戳被拒')
}
{
  const bad = mkIncident(); delete bad.privacy
  const r = validateIncident(bad)
  assert(!r.ok && r.errors.some((e) => e.code === 'MISSING_FIELD'), '缺字段被拒（MISSING_FIELD）')
}

// ── 其余 schema 最小验证 ──
console.log('[contract] proposal/receipt/lesson-proof 闭集')
const hex = 'c'.repeat(64)
const mkRequest = () => ({
  schema: 'g-repair-proposal-request/v1', request_id: uuid(), incident_id: uuid(),
  base: { commit: null, tree_sha256: hex, package_version: '0.6.51' },
  repair_contract_sha: hex, mre_id: 'synthetic-toy-1', mre_sha256: hex,
  oracle_id: 'oracle-toy-1', oracle_sha256: hex,
  allowed_files: ['src/foo.js'], allowed_categories: ['logic-fix'],
  verifier_id: 'verifier-local-1', verifier_sha256: hex, frozen_test_set_sha: hex,
  budget: { attempts: 1 }, expiry: '2026-10-17T00:00:00+08:00', requested_by: 'maintainer',
  created_at: '2026-10-16T20:00:00+08:00',
})
assert(validateProposalRequest(mkRequest()).ok, 'valid proposal request 通过')
{
  const bad = mkRequest(); bad.budget.attempts = 0
  assert(!validateProposalRequest(bad).ok, 'attempts 越界被拒')
}
{
  const bad = mkRequest(); bad.note = '看看这个'
  assert(!validateProposalRequest(bad).ok, '未知字段被拒')
}
const mkReceipt = () => ({
  schema: 'g-repair-receipt/v1', receipt_id: uuid(), proposal_id: uuid(),
  verifier: { id: 'verifier-local-1', version: 'v1', sha256: hex },
  base_red: true, patch_green: true, frozen_suite: 'PASS', policy_check: 'PASS',
  evidence: { patch_sha256: hex, mre_sha256: hex, oracle_sha256: hex },
  result: 'READY_FOR_MAINTAINER_REVIEW', created_at: '2026-10-16T20:00:00+08:00',
})
assert(validateReceipt(mkReceipt()).ok, 'valid receipt 通过')
{
  const bad = mkReceipt(); bad.result = 'APPROVED'
  assert(!validateReceipt(bad).ok, 'receipt result 枚举外被拒')
}
const mkProof = () => ({
  schema: 'g-repair-lesson-proof/v1', proof_id: uuid(), lesson_id: uuid(),
  red_case_id: 'red-1', green_case_id: 'green-1', base_fingerprint: hex,
  verifier: { id: 'verifier-local-1', version: 'v1' }, result_sha256: hex,
  revoked: false, created_at: '2026-10-16T20:00:00+08:00',
})
assert(validateLessonProof(mkProof()).ok, 'valid lesson proof 通过')
{
  const bad = mkProof(); bad.revoked = 'no'
  assert(!validateLessonProof(bad).ok, 'revoked 非布尔被拒')
}
const mkLesson = () => ({
  lesson_id: uuid(), error_signature: 'ModuleNotFoundError: No module named X',
  fix_hint: '改用当前 API 名称', env: { plugin: '0.6.51', python: '3.12' },
  status: 'VERIFIED', created_at: '2026-10-16T20:00:00+08:00',
})
assert(validateLesson(mkLesson()).ok, 'valid lesson 通过')
{
  const bad = mkLesson(); bad.status = 'CANDIDATE'
  assert(!validateLesson(bad).ok, 'lesson.status 仅 VERIFIED')
}

// ── 状态机 ──
console.log('[contract] 状态机迁移')
assert(canTransition('OBSERVED', 'TRIAGED'), 'OBSERVED→TRIAGED 合法')
assert(canTransition('OBSERVED', 'REJECTED'), 'OBSERVED→REJECTED 合法')
assert(!canTransition('OBSERVED', 'RELEASED'), 'OBSERVED→RELEASED 非法（禁止跳步）')
assert(!canTransition('REJECTED', 'OBSERVED'), 'REJECTED 无出边')
assert(!canTransition('MERGED', 'INDEPENDENTLY_VERIFIED'), 'MERGED 不可回退')
assert(canTransition('POST_RELEASE_VERIFIED', 'STALE'), 'POST_RELEASE_VERIFIED→STALE 合法')
assert(STATES.length === 14, `状态总数 14（实际 ${STATES.length}）`)

// ── 变更面策略 ──
console.log('[contract] 变更面策略校验（allowlist + deny 兜底）')
const allowPol = (files) => ({ ...DEFAULT_POLICY, proposal: { ...DEFAULT_POLICY.proposal, allowed_files: files } })
{
  const r = validateProposalFiles([{ path: 'src/foo.js', kind: 'modify' }])
  assert(!r.ok && r.rejects[0].reason === 'NOT_ON_ALLOWLIST', '默认策略（空 allowlist）：拒绝')
}
{
  const r = validateProposalFiles([{ path: 'src/foo.js', kind: 'modify' }], allowPol(['src/foo.js']))
  assert(r.ok && r.verdict === 'ACCEPT', '纯逻辑文件在 allowlist 内：通过')
}
{
  const r = validateProposalFiles([{ path: 'src/b.js', kind: 'rename', from: 'src/a.js' }], allowPol(['src/a.js', 'src/b.js']))
  assert(r.ok, '合法 rename 通过')
}
const rejectCases = [
  [[{ path: 'package.json', kind: 'modify' }], 'EXACT_DENY', '改 package.json'],
  [[{ path: 'Package.JSON', kind: 'modify' }], 'EXACT_DENY', '大小写绕过 package.json'],
  [[{ path: 'pnpm-lock.yaml', kind: 'modify' }], 'EXACT_DENY', '改 lockfile'],
  [[{ path: 'src/index.js', kind: 'modify' }], 'EXACT_DENY', '改 src/index.js'],
  [[{ path: 'scripts/install-preset.js', kind: 'modify' }], 'EXACT_DENY', '改 postinstall'],
  [[{ path: 'scripts/anything.mjs', kind: 'modify' }], 'PREFIX_DENY', 'scripts/ 前缀'],
  [[{ path: '.github/workflows/ci.yml', kind: 'add' }], 'PREFIX_DENY', 'CI 目录'],
  [[{ path: 'preset/bio-genie/agent.cordis.yml', kind: 'modify' }], 'PREFIX_DENY', 'preset 目录'],
  [[{ path: 'test/repair-store.mjs', kind: 'modify' }], 'PREFIX_DENY', '改冻结测试'],
  [[{ path: 'src/foo.exe', kind: 'add' }], 'SUFFIX_DENY', '二进制扩展名'],
  [[{ path: 'src/foo.tgz', kind: 'add' }], 'SUFFIX_DENY', '包格式'],
  [[{ path: '../src/foo.js', kind: 'modify' }], 'DOT_SEGMENT', '路径穿越 ..'],
  [[{ path: 'src/../foo.js', kind: 'modify' }], 'DOT_SEGMENT', '路径穿越 中段'],
  [[{ path: 'C:/src/foo.js', kind: 'modify' }], 'ABSOLUTE_PATH', '绝对路径'],
  [[{ path: 'src\\foo.js', kind: 'modify' }], 'BACKSLASH_PATH', '反斜杠路径'],
  [[{ path: 'src/foo.js:ads', kind: 'modify' }], 'COLON_ADS_OR_DRIVE', 'ADS 冒号'],
  [[{ path: 'src/foo.js. ', kind: 'modify' }], 'TRAILING_DOT_OR_SPACE', '尾点/空格'],
  [[{ path: 'src/node_modules/x.js', kind: 'modify' }], 'VCS_OR_MODULES_SEGMENT', 'node_modules'],
  [[{ path: 'src/.git/config', kind: 'modify' }], 'VCS_OR_MODULES_SEGMENT', '.git 元数据'],
  [[{ path: 'src/b.js', kind: 'rename', from: 'src/A.js' }, { path: 'src/a.js', kind: 'modify' }], 'CASE_COLLISION', '大小写冲突组合'],
]
for (const [changes, expect, label] of rejectCases) {
  const r = validateProposalFiles(changes, allowPol(['src/a.js', 'src/b.js', 'src/foo.js']))
  const hit = r.rejects.some((x) => x.reason === expect)
  assert(!r.ok && hit, `拒绝性用例：${label} → ${expect}`)
}
{
  const r = validateProposalFiles([{ path: 'src/a.js', kind: 'rename', from: 'src/A.js' }], allowPol(['src/a.js', 'src/A.js']))
  assert(!r.ok && r.rejects.some((x) => x.reason === 'CASE_ONLY_RENAME'), '仅大小写 rename 被拒')
}
{
  const r = validateProposalFiles([{ path: 'src/b.js', kind: 'rename', from: 'src/c.js' }], allowPol(['src/a.js', 'src/b.js']))
  assert(!r.ok && r.rejects.some((x) => x.reason === 'FROM_NOT_ON_ALLOWLIST'), 'rename 源不在 allowlist 被拒')
}
{
  const r = validateProposalFiles([])
  assert(!r.ok && r.rejects[0].reason === 'EMPTY_CHANGES', '空变更集被拒')
}
{
  const r = validateProposalFiles([{ path: 'design/repair/repair-contract-v0.json', kind: 'modify' }], allowPol(['design/repair/repair-contract-v0.json']))
  assert(!r.ok && r.rejects.some((x) => x.reason === 'EXACT_DENY'), '策略/契约文件即使进 allowlist 仍被 deny 兜底')
}

// ── limits 常量 ──
assert(LIMITS.max_captures_per_hour > 0 && LIMITS.max_incidents >= 100, 'limits 合理')

// ── 合成 fixtures（仅合成数据；禁真实日志/序列/路径） ──
console.log('[contract] 合成 fixtures')
{
  const fv = readJson('../test/fixtures/repair/incident-valid.json')
  assert(validateIncident(fv).ok, 'fixtures: incident-valid.json 通过闭集校验')
  const rej = readJson('../test/fixtures/repair/reject-samples.json')
  let allRej = true
  for (const s of rej.samples) {
    if (validateIncident(s.record).ok) { allRej = false; console.error(`    fixture 未被拒绝: ${s.name}`) }
  }
  assert(rej.samples.length >= 3 && allRej, `fixtures: reject-samples.json 全部被拒（${rej.samples.length} 例）`)
}

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
