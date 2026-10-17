// repair-gen-canary 单元测试：生成器输入包构建器——canary/凭据/用户路径/二进制拒发、
// 绑定复核、确定性与自我哈希、静态无网络面。全部合成材料（禁真实数据）。
// 用法：node test/repair-gen-canary.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { newUuid, sha256Hex } from '../src/repair-contract.js'

const LF = String.fromCharCode(10)
const BS = String.fromCharCode(92)

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('  PASS ' + msg)
  else { failures++; console.error('  FAIL ' + msg) }
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOOL = join(ROOT, 'scripts', 'repair-gen-package.mjs')
const RUNNER = join(ROOT, 'scripts', 'repair-lab-verify.mjs')
const CONTRACT = join(ROOT, 'src', 'repair-contract.js')

const CANARY = 'CANARY-7f3a9d2e-00b4'
const CANARY2 = 'A_longriverplan-marker'
const CRED_FAKE = 'AKIA' + 'ABCDEFGHIJKLMNOP'
const USERPATH_FAKE = 'C:' + BS + 'Users' + BS + 'example'

function mkTemp(prefix) {
  return mkdtempSync(join(tmpdir(), 'dshbio-gen-' + prefix + '-'))
}
function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}
function mkIncident(id) {
  return {
    schema: 'g-repair-incident/v1',
    incident_id: id,
    state: 'OBSERVED',
    attribution: 'UNVERIFIED',
    source_kind: 'bio_python',
    plugin_id: 'dsh-bio-genie',
    package_fingerprint: {
      package: '@dsh-bio/dsh-bio-genie',
      version: '0.6.51',
      node: '24',
      python: '3.11',
      sources_sha256: sha256Hex('synthetic-sources-v0'),
    },
    tool_id: 'bio_python',
    op_id: 'op_synthetic',
    symptom_class: 'PYTHON_TRACEBACK',
    dedupe_key: 'dk_a1b2c3d4e5f60718293a4b5c6d7e8f90',
    created_at: new Date().toISOString(),
    privacy: 'SANITIZED',
  }
}

const CHECKER_SRC = [
  "import { readFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  'const tree = process.argv[2]',
  "const text = readFileSync(join(tree, 'src', 'math.js'), 'utf8')",
  "process.exit(text.includes('two = 2') ? 0 : 1)",
  '',
].join(LF)

/** 受信材料（合成）：policy（allowed=[src/math.js]）+ 冻结 checker。返回 {policy, checker}。 */
function mkTrusted(dir) {
  const policy = {
    schema: 'g-repair-policy/v1',
    plugin_id: 'dsh-bio-genie',
    mode: 'proposal-only',
    capture: { source_kinds: ['bio_python'], symptom_classes: ['PYTHON_TRACEBACK'], max_captures_per_hour: 20 },
    proposal: {
      enabled: false,
      allowed_files: ['src/math.js'],
      exact_deny: ['package.json'],
      prefix_deny: ['scripts/'],
      suffix_deny: ['.exe'],
    },
    limits: { max_field_len: 512, max_incidents: 500, max_receipts: 500, max_lessons: 100, max_captures_per_hour: 20 },
  }
  const policyPath = join(dir, 'repair-policy-v0.json')
  const checkerPath = join(dir, 'checker.mjs')
  writeFileSync(policyPath, JSON.stringify(policy, null, 2) + LF)
  writeFileSync(checkerPath, CHECKER_SRC)
  return { policyPath, checkerPath }
}

function runTool(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 120_000 })
}

/** 标准工作台：pristine snapshot/mre + trusted + incident + canary 词表 + prepare 出的 request。 */
function mkBench() {
  const t = mkTemp('bench')
  const snap = join(t, 'snapshot')
  const mre = join(t, 'mre')
  writeTree(snap, { 'src/math.js': 'export const two = 1' + LF })
  writeTree(mre, { 'repro.test.js': 'expect(two).toBe(2)' + LF })
  const trusted = mkTrusted(t)
  const canaryPath = join(t, 'canary.txt')
  writeFileSync(canaryPath, [CANARY, CANARY2, 'wangshuaihao-marker'].join(LF) + LF)
  const incident = mkIncident(newUuid())
  const incidentPath = join(t, 'incident.json')
  writeFileSync(incidentPath, JSON.stringify(incident, null, 2) + LF)
  const requestPath = join(t, 'request.json')
  const prep = runTool([
    'prepare', '--incident', incidentPath, '--snapshot', snap, '--mre', mre,
    '--policy', trusted.policyPath, '--checker', trusted.checkerPath, '--runner', RUNNER,
    '--contract', CONTRACT, '--allowed', 'src/math.js', '--out', requestPath,
  ])
  if (prep.status !== 0) {
    console.error('  (prepare 失败，后续用例不可靠) stderr=' + String(prep.stderr).slice(0, 300))
    failures++
  }
  return { t, snap, mre, trusted, canaryPath, incident, incidentPath, requestPath }
}
function buildArgs(b, outDir, { snapshot = b.snap, mre = b.mre, incidentPath = b.incidentPath, requestPath = b.requestPath, canaryPath = b.canaryPath } = {}) {
  return [
    'build', '--incident', incidentPath, '--request', requestPath, '--snapshot', snapshot,
    '--mre', mre, '--canary', canaryPath, '--policy', b.trusted.policyPath,
    '--checker', b.trusted.checkerPath, '--runner', RUNNER, '--contract', CONTRACT, '--out', outDir,
  ]
}

// ── ① 正常路径：prepare → build → payload + record ──
console.log('[gen-canary] 正常路径')
const B = mkBench()
const out1 = join(B.t, 'out1')
{
  const r = runTool(buildArgs(B, out1))
  assert(r.status === 0, 'build exit 0（实际 ' + r.status + '；stderr=' + String(r.stderr).slice(0, 200) + '）')
  const payload = readFileSync(join(out1, 'payload.json'))
  const text = payload.toString('utf8')
  assert(text.includes('"schema":"g-repair-gen-payload/v1"'), 'payload schema 正确')
  assert(!text.toLowerCase().includes(CANARY.toLowerCase()), 'payload 不含 canary 词 1')
  assert(!text.toLowerCase().includes(CANARY2.toLowerCase()), 'payload 不含 canary 词 2')
  const record = JSON.parse(readFileSync(join(out1, 'payload-record.json'), 'utf8'))
  assert(record.payload.sha256 === sha256Hex(payload), 'record.payload.sha256 == 重算（记录完整性）')
  assert(record.builder.sha256 === sha256Hex(readFileSync(TOOL)), 'record.builder.sha256 == 工具自我哈希')
  assert(record.scan.hits === 0 && record.verdict === 'READY_TO_SEND', 'record verdict/scans = READY/hits0')
}

// ── ② 确定性：同输入二跑 → payload 逐字节一致 ──
console.log('[gen-canary] 确定性')
{
  const out2 = join(B.t, 'out2')
  const r = runTool(buildArgs(B, out2))
  assert(r.status === 0, 'build 二跑 exit 0')
  const a = readFileSync(join(out1, 'payload.json'))
  const b = readFileSync(join(out2, 'payload.json'))
  assert(Buffer.compare(a, b) === 0, '两次 payload.json 逐字节一致（' + a.length + ' bytes）')
}

// ── ③ incident 未知/raw 字段 → prepare 拒（闭集） ──
console.log('[gen-canary] 输入闭集')
{
  const bad = mkIncident(newUuid())
  bad.raw_stderr = 'traceback: synthetic'
  const p = join(B.t, 'bad-incident.json')
  writeFileSync(p, JSON.stringify(bad))
  const r = runTool([
    'prepare', '--incident', p, '--snapshot', B.snap, '--mre', B.mre,
    '--policy', B.trusted.policyPath, '--checker', B.trusted.checkerPath, '--runner', RUNNER,
    '--contract', CONTRACT, '--allowed', 'src/math.js', '--out', join(B.t, 'x.json'),
  ])
  assert(r.status === 3, 'raw 字段 incident → exit 3（实际 ' + r.status + '）')
}

// ── ④ canary 入快照 → 拒发 + refusal 不回声 + 无 payload ──
console.log('[gen-canary] canary 拒发')
{
  const dirtySnap = join(B.t, 'snap-dirty')
  writeTree(dirtySnap, { 'src/math.js': 'export const two = 1' + LF + '// ' + CANARY + LF })
  const outD = join(B.t, 'out-dirty')
  const r = runTool(buildArgs(B, outD, { snapshot: dirtySnap }))
  assert(r.status === 2, '脏快照 → exit 2（实际 ' + r.status + '）')
  const refusal = readFileSync(join(outD, 'refusal.json'), 'utf8')
  assert(!refusal.includes(CANARY), 'refusal 不回声 canary 值')
  assert(refusal.includes('canary'), 'refusal 记录命中 kind=canary')
  let hasPayload = true
  try { readFileSync(join(outD, 'payload.json')) } catch { hasPayload = false }
  assert(!hasPayload, '拒发时不产生 payload.json')
}

// ── ⑤ canary 入 MRE → 拒发 ──
{
  const dirtyMre = join(B.t, 'mre-dirty')
  writeTree(dirtyMre, { 'repro.test.js': 'expect(two).toBe(2) // ' + CANARY2 + LF })
  const r = runTool(buildArgs(B, join(B.t, 'out-mre'), { mre: dirtyMre }))
  assert(r.status === 2, '脏 MRE → exit 2（实际 ' + r.status + '）')
}

// ── ⑥ canary 走私经「允许字段」（攻击载荷字节终扫）→ exit 2 stage=payload-bytes ──
{
  const inc2 = mkIncident(B.incident.incident_id)
  inc2.package_fingerprint.version = CANARY
  const p2 = join(B.t, 'incident-smuggle.json')
  writeFileSync(p2, JSON.stringify(inc2, null, 2) + LF)
  const req2 = join(B.t, 'request-smuggle.json')
  const prep = runTool([
    'prepare', '--incident', p2, '--snapshot', B.snap, '--mre', B.mre,
    '--policy', B.trusted.policyPath, '--checker', B.trusted.checkerPath, '--runner', RUNNER,
    '--contract', CONTRACT, '--allowed', 'src/math.js', '--out', req2,
  ])
  assert(prep.status === 0, '走私 incident 通过 schema 校验（证明终点防线必要）')
  const outS = join(B.t, 'out-smuggle')
  const r = runTool(buildArgs(B, outS, { incidentPath: p2, requestPath: req2 }))
  assert(r.status === 2, '走私 → 字节终扫拒发 exit 2（实际 ' + r.status + '）')
  const refusal = JSON.parse(readFileSync(join(outS, 'refusal.json'), 'utf8'))
  assert(refusal.stage === 'payload-bytes', '拒绝阶段 = payload-bytes（实际 ' + refusal.stage + '）')
}

// ── ⑦ 凭据形状入快照 → 拒发 ──
console.log('[gen-canary] 凭据形状/路径/二进制')
{
  const dirtySnap = join(B.t, 'snap-cred')
  writeTree(dirtySnap, { 'src/math.js': 'export const two = 1' + LF + '// ' + CRED_FAKE + LF })
  const r = runTool(buildArgs(B, join(B.t, 'out-cred'), { snapshot: dirtySnap }))
  assert(r.status === 2, '凭据形状 → exit 2（实际 ' + r.status + '）')
}

// ── ⑧ 用户路径模式入快照 → 拒发 ──
{
  const dirtySnap = join(B.t, 'snap-path')
  writeTree(dirtySnap, { 'src/math.js': 'export const two = 1' + LF + '// ' + USERPATH_FAKE + LF })
  const r = runTool(buildArgs(B, join(B.t, 'out-path'), { snapshot: dirtySnap }))
  assert(r.status === 2, '用户路径模式 → exit 2（实际 ' + r.status + '）')
}

// ── ⑨ 二进制文件入快照 → 拒发 ──
{
  const dirtySnap = join(B.t, 'snap-bin')
  writeTree(dirtySnap, { 'src/math.js': 'export const two = 1' + LF })
  writeFileSync(join(dirtySnap, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42]))
  const r = runTool(buildArgs(B, join(B.t, 'out-bin'), { snapshot: dirtySnap }))
  assert(r.status === 2, '二进制 → exit 2（实际 ' + r.status + '）')
}

// ── ⑩ 缺快照目录 → fail-closed exit 3 ──
{
  const r = runTool(buildArgs(B, join(B.t, 'out-missing'), { snapshot: join(B.t, 'no-such-dir') }))
  assert(r.status === 3, '缺目录 → exit 3（实际 ' + r.status + '）')
}

// ── ⑪ 静态面：零反斜杠字节 + 无网络模块 + 自身零折损 ──
console.log('[gen-canary] 静态面')
{
  const src = readFileSync(TOOL)
  let bs = 0
  for (const byte of src) if (byte === (BS).charCodeAt(0)) bs++
  assert(bs === 0, '构建器源码零反斜杠字节（通道折损免疫）')
  const text = src.toString('utf8')
  for (const token of ['node:http', 'node:https', 'node:net', 'node:dns', 'node:tls', 'fetch(', 'XMLHttpRequest', 'WebSocket']) {
    assert(!text.includes(token), '源码不引用 ' + token)
  }
  const self = readFileSync(fileURLToPath(import.meta.url))
  let bs2 = 0
  for (const byte of self) if (byte === (BS).charCodeAt(0)) bs2++
  assert(bs2 === 0, '本测试文件零反斜杠字节')
}

if (failures === 0) console.log(LF + 'ALL PASS')
else { console.error(LF + failures + ' FAILURES'); process.exit(1) }
