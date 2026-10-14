// dsh-bio-genie — casefile 目录与身份测试（A1）
// 运行：node test/design-casefile.mjs
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendReceipt, computeSnapshotSha, deriveCaseContentId, ensureCaseDir, readHead,
  validateCaseInstanceId, writeHeadAtomic, writeSnapshot,
} from '../src/design-casefile.js'
import { validateDesignArtifact } from '../src/design-validate.js'

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log('  PASS ' + name)
  } else {
    fail += 1
    console.log('  FAIL ' + name + ' ' + detail)
  }
}

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const GOLDEN_CONTENT_ID = 'bdfb54d1459ac5d3b1f96c9562a9872e13835cde919f06422c44202fc9ac41bd'
const GOLDEN_SNAPSHOT_SHA = '3f0c2185291dc2f38d5242ca6a878ac4bd5a97a48c14da4a73ee24c1cd0386df'

const roots = []
function mkRoot() {
  const d = mkdtempSync(join(tmpdir(), 'design-casefile-'))
  roots.push(d)
  return d
}

// ── 1) case_instance_id 校验矩阵 ────────────────────────────────────
{
  const good = ['case-1', 'Case_2', 'a', '2026-10-14T22-00-00_abcd', 'x'.repeat(128)]
  for (const id of good) check('ID 接受: ' + JSON.stringify(id.slice(0, 24)), validateCaseInstanceId(id).ok === true, JSON.stringify(validateCaseInstanceId(id).problems))
  const bad = ['', '.', '..', 'a/b', 'a\\b', 'C:evil', 'C:\\evil', '\\\\srv\\share', 'con', 'CON', 'nul.json', 'com1', 'trail.', 'trail ', ' lead', 'a\tb', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', '.hidden', 'x'.repeat(129)]
  for (const id of bad) check('ID 拒绝: ' + JSON.stringify(id.slice(0, 24)), validateCaseInstanceId(id).ok === false)
}

// ── 2) ensureCaseDir 布局 + 幂等 + 基础拒绝 ─────────────────────────
{
  const wd = mkRoot()
  const r1 = ensureCaseDir(wd, 'case-alpha')
  check('布局创建 ok（objects/snapshots）', r1.ok === true && existsSync(r1.objectsDir) && existsSync(r1.snapshotsDir), JSON.stringify(r1))
  const r2 = ensureCaseDir(wd, 'case-alpha')
  check('幂等重复打开 ok', r2.ok === true && r2.caseDir === r1.caseDir)
  const r3 = ensureCaseDir(wd, '../evil')
  check('.. 穿越拒绝', r3.ok === false && r3.code === 'CASE_INSTANCE_ID_UNSAFE')
  const r4 = ensureCaseDir(join(wd, 'no-such-workdir'), 'x')
  check('workdir 缺失拒绝', r4.ok === false && r4.code === 'WORKDIR_MISSING')
  const r5 = ensureCaseDir(wd, 'case-beta', { create: false })
  check('create:false 且不存在 → CASE_NOT_FOUND', r5.ok === false && r5.code === 'CASE_NOT_FOUND')
}

// ── 3) Windows 旁路矩阵（junction / 别名）───────────────────────────
{
  const wd = mkRoot()
  const outside = mkRoot()
  const base = ensureCaseDir(wd, 'real-case')
  check('旁路基座 ok', base.ok === true)
  const jTarget = join(wd, 'result', 'design', 'linked-case')
  symlinkSync(outside, jTarget, 'junction')
  const r = ensureCaseDir(wd, 'linked-case')
  check('目标 junction 拒绝（CASE_TARGET_UNSAFE）', r.ok === false && r.code === 'CASE_TARGET_UNSAFE', JSON.stringify(r))
  unlinkSync(jTarget)

  const wd2 = mkRoot()
  mkdirSync(join(wd2, 'result'))
  symlinkSync(outside, join(wd2, 'result', 'design'), 'junction')
  const r2 = ensureCaseDir(wd2, 'x-case')
  check('caseRoot junction 逃逸拒绝（CASE_ROOT_*）', r2.ok === false && String(r2.code).startsWith('CASE_ROOT'), JSON.stringify(r2))

  const wd3 = mkRoot()
  const r3 = ensureCaseDir(wd3, 'Case-B')
  check('别名基座 ok', r3.ok === true)
  const r4 = ensureCaseDir(wd3, 'case-b')
  check('大小写别名拒绝（CASE_ALIAS_CONFLICT）', r4.ok === false && r4.code === 'CASE_ALIAS_CONFLICT', JSON.stringify(r4))

  // 3d: result 处 junction → 外部（final 组件为真实目录）→ 仅 realpath containment 能拦截
  const wd4 = mkRoot()
  const outside2 = mkRoot()
  mkdirSync(join(outside2, 'design'))
  symlinkSync(outside2, join(wd4, 'result'), 'junction')
  const r5 = ensureCaseDir(wd4, 'y-case')
  check('经 result junction 逃逸拒绝（CASE_ROOT_ESCAPE）', r5.ok === false && r5.code === 'CASE_ROOT_ESCAPE', JSON.stringify(r5))
}

// ── 4) case_content_id 派生（derivation v1）─────────────────────────
const params = { capability_policy: 'design-capability-policy@0', design_tier: 'reference_profile' }
{
  const r1 = deriveCaseContentId({ rootInputArtifactIds: [A, B], policyVersion: '0', canonicalParams: params })
  check('派生 ok + golden', r1.ok === true && r1.case_content_id === GOLDEN_CONTENT_ID, JSON.stringify(r1).slice(0, 200))
  const r2 = deriveCaseContentId({ rootInputArtifactIds: [B, A], policyVersion: '0', canonicalParams: params })
  check('set 语义：id 顺序不敏感', r2.case_content_id === r1.case_content_id)
  const r3 = deriveCaseContentId({ rootInputArtifactIds: [A, B], policyVersion: '1', canonicalParams: params })
  check('policy_version 敏感', r3.case_content_id !== r1.case_content_id)
  const r4 = deriveCaseContentId({ rootInputArtifactIds: ['not-hex'], policyVersion: '0' })
  check('非法 artifact id 拒绝', r4.ok === false)
  const r5 = deriveCaseContentId({ rootInputArtifactIds: [A], policyVersion: '0', canonicalParams: { nested: { a: 1 } } })
  check('嵌套 params 拒绝', r5.ok === false)
}

// ── 5) snapshot_sha + 写快照 + 碰撞 ─────────────────────────────────
{
  const wd = mkRoot()
  const cs = ensureCaseDir(wd, 'snap-case')
  check('快照基座 ok', cs.ok === true)
  const manifest = {
    schema_version: '1.0',
    case_content_id: GOLDEN_CONTENT_ID,
    artifacts: [{ artifact_id: A, type: 'genome_ref@1', inputs: [B], producer: 'test', schema_major: '1', canonical_path: 'genome.fna' }],
    policy: { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: B },
  }
  const s = computeSnapshotSha(manifest)
  check('snapshot_sha golden', s.ok === true && s.snapshot_sha === GOLDEN_SNAPSHOT_SHA, JSON.stringify(s).slice(0, 200))
  const validate = (m) => validateDesignArtifact('case_manifest', m)
  const w1 = writeSnapshot({ snapshotsDir: cs.snapshotsDir, manifest, validate })
  check('写快照 ok（schema 校验过）', w1.ok === true && existsSync(w1.path), JSON.stringify(w1).slice(0, 200))
  const w2 = writeSnapshot({ snapshotsDir: cs.snapshotsDir, manifest, validate })
  check('重复写幂等（existed）', w2.ok === true && w2.existed === true)
  const fileText = readFileSync(w1.path, 'utf8')
  check('快照文件为 canonical（无空白 + 含 snapshot_sha）', !fileText.includes('\n') && fileText.includes('"snapshot_sha":"' + w1.snapshot_sha + '"'), fileText.slice(0, 120))
  writeFileSync(w1.path, fileText + ' ')
  const w3 = writeSnapshot({ snapshotsDir: cs.snapshotsDir, manifest, validate })
  check('同名不同字节 → SNAPSHOT_HASH_COLLISION', w3.ok === false && w3.code === 'SNAPSHOT_HASH_COLLISION', JSON.stringify(w3))
  const w4 = writeSnapshot({ snapshotsDir: cs.snapshotsDir, manifest: { schema_version: '1.0', artifacts: [], policy: manifest.policy }, validate })
  check('无效 manifest → SNAPSHOT_INVALID', w4.ok === false && w4.code === 'SNAPSHOT_INVALID', JSON.stringify(w4).slice(0, 200))
}

// ── 6) HEAD（CAS）+ receipt ─────────────────────────────────────────
{
  const wd = mkRoot()
  const cs = ensureCaseDir(wd, 'head-case')
  check('HEAD 初始为 null', readHead(cs.caseDir).snapshot_sha === null)
  const h1 = writeHeadAtomic(cs.caseDir, A)
  check('HEAD 写入 ok', h1.ok === true && readHead(cs.caseDir).snapshot_sha === A)
  const h2 = writeHeadAtomic(cs.caseDir, B, { expect: C })
  check('CAS 不符 → 拒绝且 HEAD 不变', h2.ok === false && h2.code === 'HEAD_CAS_MISMATCH' && readHead(cs.caseDir).snapshot_sha === A, JSON.stringify(h2))
  const h3 = writeHeadAtomic(cs.caseDir, B, { expect: A })
  check('CAS 相符 → 替换', h3.ok === true && readHead(cs.caseDir).snapshot_sha === B)
  const rc1 = appendReceipt(cs.caseDir, { event: 'case_created', run_uuid: 'u1' })
  appendReceipt(cs.caseDir, { event: 'commit', run_uuid: 'u2', snapshot_sha: B })
  const lines = readFileSync(rc1.path, 'utf8').trim().split('\n')
  check('receipt 两行且可解析', lines.length === 2 && JSON.parse(lines[0]).event === 'case_created' && JSON.parse(lines[1]).snapshot_sha === B)
}

// ── cleanup（junction 先解链再删树）─────────────────────────────────
for (const d of roots) {
  for (const rel of [['result', 'design'], ['result', 'design', 'linked-case'], ['result']]) {
    const p = join(d, ...rel)
    try {
      if (existsSync(p) && lstatSync(p).isSymbolicLink()) unlinkSync(p)
    } catch { /* best effort */ }
  }
  try {
    rmSync(d, { recursive: true, force: true })
  } catch { /* best effort */ }
}

console.log('design-casefile: %d passed, %d failed', pass, fail)
process.exit(fail === 0 ? 0 : 1)
