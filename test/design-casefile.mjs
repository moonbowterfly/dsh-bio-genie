// dsh-bio-genie — casefile 目录与身份测试（A1）+ 库测试（A2）
// 运行：node test/design-casefile.mjs
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireCaseLock, appendReceipt, canonicalizeViaPacket, commitTransaction, computeSnapshotSha,
  deriveCaseContentId, ensureCaseDir, gcOrphans, loadSnapshot,
  readHead, releaseCaseLock, resolveCaseContext, resolveCaseOperations, validateCaseInstanceId,
  withCaseLock, writeHeadAtomic, writeSnapshot,
} from '../src/design-casefile.js'
import { deriveAnnotationsForArtifact, validateDesignArtifact } from '../src/design-validate.js'

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
const H64 = /^[0-9a-f]{64}$/
const GOLDEN_CONTENT_ID = 'bdfb54d1459ac5d3b1f96c9562a9872e13835cde919f06422c44202fc9ac41bd'
const GOLDEN_SNAPSHOT_SHA = '3f0c2185291dc2f38d5242ca6a878ac4bd5a97a48c14da4a73ee24c1cd0386df'
const CORPUS = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'design', 'packet', 'schema-corpus', 'schema_cases.json'), 'utf8'))
function findCase(id) {
  const c = CORPUS.cases.find((x) => x.id === id)
  if (!c) throw new Error('corpus case not found: ' + id)
  return c
}

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

// [P0-reparse] 写前链校验：预置 junction 不被 mkdir 跟随（修复前 result junction 会被递归创建穿透）。
{
  const wd = mkRoot()
  const outside = mkRoot()
  symlinkSync(outside, join(wd, 'result'), 'junction')
  const r = ensureCaseDir(wd, 'no-write-case')
  check('result junction escape rejects (CASE_ROOT_ESCAPE)', r.ok === false && r.code === 'CASE_ROOT_ESCAPE', JSON.stringify(r))
  check('no write-through: junction target untouched', readdirSync(outside).length === 0, JSON.stringify(readdirSync(outside)))
}
{
  const wd = mkRoot()
  const inner = join(wd, 'inner-target')
  mkdirSync(inner)
  symlinkSync(inner, join(wd, 'result'), 'junction')
  const r = ensureCaseDir(wd, 'inner-case')
  check('internal junction rejected all-chain (CASE_ROOT_REPARSE)', r.ok === false && r.code === 'CASE_ROOT_REPARSE', JSON.stringify(r))
  check('no write-through on internal junction', readdirSync(inner).length === 0, JSON.stringify(readdirSync(inner)))
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

// ── 7) 每-case 锁（A2）──────────────────────────────────────────────
{
  const wd = mkRoot()
  const cs = ensureCaseDir(wd, 'lock-case')
  const l1 = acquireCaseLock(cs.caseDir, { op: 'test' })
  check('锁获取 ok', l1.ok === true)
  const l2 = acquireCaseLock(cs.caseDir, { op: 'test' })
  check('同进程二次获取 → LOCK_HELD', l2.ok === false && l2.code === 'LOCK_HELD', JSON.stringify(l2))
  releaseCaseLock(cs.caseDir)
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' }).pid
  writeFileSync(join(cs.caseDir, 'case.lock'), JSON.stringify({ pid: dead, op: 'x', at: 'x' }))
  const l3 = acquireCaseLock(cs.caseDir, { op: 'test' })
  check('死 pid 陈旧锁被抢占', l3.ok === true, JSON.stringify(l3))
  releaseCaseLock(cs.caseDir)
  const r = withCaseLock(cs.caseDir, () => 42, { op: 'test' })
  check('withCaseLock 返回值 + 释放', r === 42 && !existsSync(join(cs.caseDir, 'case.lock')))
}

// ── 8) 单事务提交（六步 / all-or-none / CAS / 上限）─────────────────
{
  const wd = mkRoot()
  const cs = ensureCaseDir(wd, 'tx-case')
  const hp = findCase('hpf-01').doc
  const policy = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: B }
  const tx1 = commitTransaction(cs, {
    caseContentId: GOLDEN_CONTENT_ID,
    policy,
    newArtifacts: [
      { type: 'genome_ref', value: findCase('gvr-01').doc, producer: 'test', canonical_path: 'genome.json' },
      { type: 'host_profile', value: hp, producer: 'test', canonical_path: 'host.json' },
    ],
  })
  check('tx1 提交 ok', tx1.ok === true && H64.test(tx1.snapshot_sha || ''), JSON.stringify(tx1).slice(0, 200))
  check('tx1 HEAD 推进 + objects=2', readHead(cs.caseDir).snapshot_sha === tx1.snapshot_sha && readdirSync(cs.objectsDir).filter((f) => H64.test(f)).length === 2)
  const rc1 = readFileSync(join(cs.caseDir, 'run_receipt.jsonl'), 'utf8').trim().split('\n')
  check('tx1 receipt committed + parent=null', rc1.length === 1 && JSON.parse(rc1[0]).event === 'committed' && JSON.parse(rc1[0]).parent_snapshot_sha === null)
  const tx2 = commitTransaction(cs, { newArtifacts: [{ type: 'evidence_item', value: findCase('evi-01').doc, producer: 'test' }] })
  check('tx2 增量 + parent=tx1', tx2.ok === true && tx2.parent === tx1.snapshot_sha, JSON.stringify(tx2).slice(0, 200))
  const snap2 = loadSnapshot(cs.snapshotsDir, tx2.snapshot_sha)
  check('tx2 manifest 3 artifacts', snap2.ok === true && snap2.manifest.artifacts.length === 3)
  const badHp = JSON.parse(JSON.stringify(hp))
  badHp.artifact_type = 'bogus_type@1'
  const objsBefore = readdirSync(cs.objectsDir).length
  const tx3 = commitTransaction(cs, {
    newArtifacts: [
      { type: 'condition_card', value: findCase('ccd-01').doc, producer: 'test' },
      { type: 'host_profile', value: badHp, producer: 'test' },
    ],
  })
  check('tx3 无效工件 → ARTIFACT_INVALID(step2)', tx3.ok === false && tx3.code === 'ARTIFACT_INVALID' && tx3.step === 2, JSON.stringify(tx3).slice(0, 220))
  check('tx3 all-or-none：objects/HEAD 未变', readdirSync(cs.objectsDir).length === objsBefore && readHead(cs.caseDir).snapshot_sha === tx2.snapshot_sha)
  check('tx3 校验失败零落盘（先判后存）', !existsSync(join(cs.caseDir, 'staging', tx3.txid)))
  const tx4 = commitTransaction(cs, { expectHead: 'f'.repeat(64), newArtifacts: [{ type: 'host_profile', value: hp, producer: 'test' }] })
  check('tx4 CAS 不符 → HEAD_CAS_MISMATCH', tx4.ok === false && tx4.code === 'HEAD_CAS_MISMATCH', JSON.stringify(tx4))
  const tx5 = commitTransaction(cs, { limits: { maxObjectBytes: 100 }, newArtifacts: [{ type: 'host_profile', value: hp, producer: 'test' }] })
  check('tx5 超对象上限 → OBJECT_TOO_LARGE', tx5.ok === false && tx5.code === 'OBJECT_TOO_LARGE')
  const snapsBefore = readdirSync(cs.snapshotsDir).length
  const objs6Before = readdirSync(cs.objectsDir).length
  const tx6 = commitTransaction(cs, { limits: { maxManifestBytes: 10 }, newArtifacts: [{ type: 'coupling_profile', value: findCase('cpl-01').doc, producer: 'test' }] })
  check('tx6 超 manifest 上限 → MANIFEST_TOO_LARGE(step4)', tx6.ok === false && tx6.code === 'MANIFEST_TOO_LARGE' && tx6.step === 4, JSON.stringify(tx6))
  check('tx6 快照文件未留 + HEAD 不变 + 对象成孤儿（已发布）', readdirSync(cs.snapshotsDir).length === snapsBefore && readHead(cs.caseDir).snapshot_sha === tx2.snapshot_sha && readdirSync(cs.objectsDir).length === objs6Before + 1)
  const cs2 = ensureCaseDir(mkRoot(), 'tx-case2')
  const tx7 = commitTransaction(cs2, { newArtifacts: [{ type: 'host_profile', value: hp, producer: 'test' }] })
  check('tx7 缺 base → BASE_REQUIRED', tx7.ok === false && tx7.code === 'BASE_REQUIRED')
  const tx8 = commitTransaction(cs, { newArtifacts: [{ type: 'host_profile', value: hp, producer: 'test' }] })
  check('tx8 全重复 → no_change', tx8.ok === true && tx8.no_change === true && tx8.snapshot_sha === tx2.snapshot_sha, JSON.stringify(tx8).slice(0, 200))
}

// [P0-reparse] commitTransaction staging 链写前校验（预置 junction 不被跟随）。
{
  const wd = mkRoot()
  const cs = ensureCaseDir(wd, 'stage-junc')
  const target = join(wd, 'stage-junc-target')
  mkdirSync(target)
  symlinkSync(target, join(cs.caseDir, 'staging'), 'junction')
  const policy = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: B }
  const tx = commitTransaction(cs, {
    caseContentId: GOLDEN_CONTENT_ID, policy,
    newArtifacts: [{ type: 'genome_ref', value: findCase('gvr-01').doc, producer: 'test' }],
  })
  check('pre-placed staging junction (external target) rejects before write (CASE_STAGING_ESCAPE)', tx.ok === false && tx.code === 'CASE_STAGING_ESCAPE', JSON.stringify(tx))
  check('staging junction target untouched', readdirSync(target).length === 0, JSON.stringify(readdirSync(target)))
  check('HEAD unchanged after staging rejection', readHead(cs.caseDir).snapshot_sha === null)
}
// [P0-reparse] 内部 junction（解析在 caseDir 内）→ 全链拒绝（CASE_STAGING_REPARSE）。
{
  const wd = mkRoot()
  const cs = ensureCaseDir(wd, 'stage-junc-inner')
  const target = join(cs.caseDir, 'inner-target')
  mkdirSync(target)
  symlinkSync(target, join(cs.caseDir, 'staging'), 'junction')
  const policy = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: B }
  const tx = commitTransaction(cs, {
    caseContentId: GOLDEN_CONTENT_ID, policy,
    newArtifacts: [{ type: 'genome_ref', value: findCase('gvr-01').doc, producer: 'test' }],
  })
  check('internal staging junction rejected all-chain (CASE_STAGING_REPARSE)', tx.ok === false && tx.code === 'CASE_STAGING_REPARSE', JSON.stringify(tx))
  check('internal junction target untouched', readdirSync(target).length === 0, JSON.stringify(readdirSync(target)))
}
// [P0-store-order] receipt 超限在任何写入之前拒绝（HEAD/快照/objects/staging/receipt 零残留）。
{
  const wd = mkRoot()
  const cs = ensureCaseDir(wd, 'receipt-cap')
  const policy = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: B }
  const tx = commitTransaction(cs, {
    caseContentId: GOLDEN_CONTENT_ID, policy, limits: { maxReceiptLineBytes: 64 },
    newArtifacts: [{ type: 'genome_ref', value: findCase('gvr-01').doc, producer: 'test' }],
  })
  check('receipt over-limit fails before any write (RECEIPT_TOO_LARGE)', tx.ok === false && tx.code === 'RECEIPT_TOO_LARGE' && tx.step === 4, JSON.stringify(tx))
  check('HEAD unchanged after receipt pre-check failure', readHead(cs.caseDir).snapshot_sha === null)
  check('no snapshot/objects/staging/receipt residue', readdirSync(cs.snapshotsDir).length === 0 && readdirSync(cs.objectsDir).length === 0 && (!existsSync(join(cs.caseDir, 'staging')) || readdirSync(join(cs.caseDir, 'staging')).length === 0) && !existsSync(join(cs.caseDir, 'run_receipt.jsonl')))
}
// [P0-store-order] receipt I/O 失败 → HEAD 回滚（原子性不变量：失败 ⇒ HEAD 不变）。
{
  const wd = mkRoot()
  const cs = ensureCaseDir(wd, 'receipt-io')
  const policy = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: B }
  const ok1 = commitTransaction(cs, { caseContentId: GOLDEN_CONTENT_ID, policy, newArtifacts: [{ type: 'genome_ref', value: findCase('gvr-01').doc, producer: 'test' }] })
  check('receipt-io base commit ok', ok1.ok === true, JSON.stringify(ok1))
  unlinkSync(join(cs.caseDir, 'run_receipt.jsonl'))
  mkdirSync(join(cs.caseDir, 'run_receipt.jsonl'))
  const tx = commitTransaction(cs, { caseContentId: GOLDEN_CONTENT_ID, policy, newArtifacts: [{ type: 'host_profile', value: findCase('hpf-01').doc, producer: 'test' }] })
  check('receipt I/O failure rolls back HEAD (atomicity)', tx.ok === false && tx.code === 'RECEIPT_APPEND_FAILED' && tx.rolled_back === true && tx.committed === undefined, JSON.stringify(tx))
  check('HEAD restored to pre-commit value', readHead(cs.caseDir).snapshot_sha === ok1.snapshot_sha)
  check('rolled-back snapshot removed', readdirSync(cs.snapshotsDir).length === 1)
}

// ── 9) 孤儿 GC（根=全部不可变快照）─────────────────────────────────
{
  const wd = mkRoot()
  const cs = ensureCaseDir(wd, 'gc-case')
  const policy = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: B }
  const t1 = commitTransaction(cs, { caseContentId: GOLDEN_CONTENT_ID, policy, newArtifacts: [{ type: 'host_profile', value: findCase('hpf-01').doc, producer: 'test' }] })
  const t2 = commitTransaction(cs, { newArtifacts: [{ type: 'genome_ref', value: findCase('gvr-01').doc, producer: 'test' }] })
  check('GC 基座（两快照）', t1.ok === true && t2.ok === true)
  const orphanBytes = Buffer.from('{"orphan":true}', 'utf8')
  const orphanSha = createHash('sha256').update(orphanBytes).digest('hex')
  writeFileSync(join(cs.objectsDir, orphanSha), orphanBytes)
  writeFileSync(join(cs.objectsDir, 'dead.tmp-123-abcd'), 'x')
  mkdirSync(join(cs.caseDir, 'staging', 'dead-tx'), { recursive: true })
  const solo = JSON.parse(JSON.stringify(findCase('hpf-01').doc))
  solo.derived.gc_percent = 51.2
  const soloAnn = deriveAnnotationsForArtifact('host_profile', solo)
  const soloCanon = canonicalizeViaPacket(JSON.stringify(solo), soloAnn)
  const soloBytes = Buffer.from(soloCanon.canonical, 'utf8')
  const soloSha = createHash('sha256').update(soloBytes).digest('hex')
  writeFileSync(join(cs.objectsDir, soloSha), soloBytes)
  const soloSnap = writeSnapshot({
    snapshotsDir: cs.snapshotsDir,
    manifest: {
      schema_version: '1.0', case_content_id: GOLDEN_CONTENT_ID,
      artifacts: [{ artifact_id: soloSha, type: 'host_profile@1', inputs: [], producer: 'test', schema_major: '1', canonical_path: 'solo.json' }],
      policy,
    },
    validate: (m) => validateDesignArtifact('case_manifest', m),
  })
  check('手工第三快照（非 HEAD）ok', soloSnap.ok === true && readHead(cs.caseDir).snapshot_sha !== soloSnap.snapshot_sha)
  const gc1 = gcOrphans(cs)
  check('GC：孤儿 object 移除', gc1.ok === true && gc1.removed.some((x) => x === 'object:' + orphanSha), JSON.stringify(gc1).slice(0, 240))
  check('GC：tmp 残片移除', gc1.removed.some((x) => x.startsWith('tmp:')))
  check('GC：staging 残留移除', gc1.removed.some((x) => x === 'staging:dead-tx'))
  check('GC：非 HEAD 快照引用的 object 保留（根=全部快照）', existsSync(join(cs.objectsDir, soloSha)) === true)
  check('GC：被引用 objects 全保留（仅孤儿被删）', gc1.removed.filter((x) => x.startsWith('object:')).length === 1 && gc1.kept === 3, 'kept=' + gc1.kept)
  const gc2 = gcOrphans(cs)
  check('GC 幂等（二次零移除）', gc2.ok === true && gc2.removed.length === 0, JSON.stringify(gc2))
  writeFileSync(join(cs.objectsDir, orphanSha), orphanBytes)
  const gc3 = gcOrphans(cs, { dryRun: true })
  check('GC dryRun：报告但不动', gc3.removed.some((x) => x === 'object:' + orphanSha) && existsSync(join(cs.objectsDir, orphanSha)))
  gcOrphans(cs)
}

// ── 10) resolve_case_context（含 A9a 接线）───────────────────────────
{
  const wd = mkRoot()
  const cs = ensureCaseDir(wd, 'ctx-case')
  const policy = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: B }
  const ctx0 = resolveCaseContext(cs)
  check('空 case → missing_annotation', ctx0.ok === true && ctx0.input_state === 'missing_annotation' && ctx0.snapshot_sha === null)
  const annotated = JSON.parse(JSON.stringify(findCase('gvr-01').doc))
  annotated.files.push({ path: 'genes.gff3', sha256: C, format: 'gff3' })
  const t1 = commitTransaction(cs, {
    caseContentId: GOLDEN_CONTENT_ID,
    policy,
    newArtifacts: [
      { type: 'genome_ref', value: annotated, producer: 'test' },
      { type: 'metabolic_model_ref', value: findCase('mmr-01').doc, producer: 'test' },
      { type: 'evidence_item', value: findCase('evi-01').doc, producer: 'test' },
    ],
  })
  check('ctx 基座 ok', t1.ok === true, JSON.stringify(t1).slice(0, 200))
  const ctx1 = resolveCaseContext(cs)
  check('genome(annotated)+gem+evidence 缺 condition → missing_condition', ctx1.ok === true && ctx1.input_state === 'missing_condition' && ctx1.flags.annotated === true, JSON.stringify(ctx1).slice(0, 240))
  const t2 = commitTransaction(cs, { newArtifacts: [{ type: 'condition_card', value: findCase('ccd-01').doc, producer: 'test' }] })
  check('+condition 提交 ok', t2.ok === true)
  const ctx2 = resolveCaseContext(cs)
  check('→ reference_complete', ctx2.input_state === 'reference_complete', JSON.stringify(ctx2).slice(0, 240))
  const ro = resolveCaseOperations(cs, [{ operation: 'sequence_qc' }, { operation: 'consequence_quantitative', claim_target: 'growth' }])
  check('resolveCaseOperations 接线（qc allow / consequence deny 缺 coupling）', ro.ok === true && ro.results[0].decision === 'allow' && ro.results[1].decision === 'deny', JSON.stringify(ro.results?.map((r) => [r.operation, r.decision])))
  const cs2 = ensureCaseDir(mkRoot(), 'ctx-case2')
  const t3 = commitTransaction(cs2, {
    caseContentId: GOLDEN_CONTENT_ID,
    policy,
    newArtifacts: [
      { type: 'genome_ref', value: annotated, producer: 'test' },
      { type: 'metabolic_model_ref', value: findCase('mmr-01').doc, producer: 'test' },
      { type: 'condition_card', value: findCase('ccd-01').doc, producer: 'test' },
      { type: 'coupling_profile', value: findCase('cpl-01').doc, producer: 'test' },
    ],
  })
  check('ctx2 基座 ok', t3.ok === true, JSON.stringify(t3).slice(0, 200))
  const ctx3 = resolveCaseContext(cs2)
  check('user_calibrated coupling → user_calibrated_only', ctx3.ok === true && ctx3.input_state === 'user_calibrated_only' && ctx3.coupling_mode === 'user_calibrated_bound', JSON.stringify(ctx3).slice(0, 240))
  const ro2 = resolveCaseOperations(cs2, [{ operation: 'consequence_quantitative', claim_target: 'growth' }])
  check('user_calibrated 下 quantitative → allow（ceiling ASSUMPTION）', ro2.ok === true && ro2.results[0].decision === 'allow' && ro2.results[0].classification_ceiling === 'ASSUMPTION', JSON.stringify(ro2.results?.[0]?.decision))
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
