// dsh-bio-genie — A3 dispatch state machine tests
// Covers formal state transitions, staging protocol, recovery/GC, and one
// real Python worker route.  Fixtures are self-contained and cleaned up.
import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  consumeDispatchCandidates, DISPATCH_LIMITS, dispatchDesignOp, gcDispatches,
  inspectStagingCandidates, readDispatchRecord, recoverDispatches, reserveDesignDispatch,
} from '../src/design-dispatch.js'
import { canonicalizeViaPacket, commitTransaction, deriveCaseContentId, ensureCaseDir, gcOrphans, writeHeadAtomic } from '../src/design-casefile.js'
import { deriveAnnotationsForArtifact } from '../src/design-validate.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKET = join(ROOT, 'design', 'packet')
const CORPUS = JSON.parse(readFileSync(join(PACKET, 'schema-corpus', 'schema_cases.json'), 'utf8'))
const home = process.env.USERPROFILE || process.env.HOME
const VENV = process.env.DSH_BIO_PYTHON || join(home, '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe')
const GOOD = CORPUS.cases.find((x) => x.id === 'gvr-01')
if (!GOOD) throw new Error('missing gvr-01 fixture')

let pass = 0
let fail = 0
const roots = []
function check(name, actual, detail = '') {
  if (actual) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
function workdir() {
  const d = mkdtempSync(join(tmpdir(), 'design-dispatch-'))
  roots.push(d)
  return d
}
function canonicalGenome() {
  const ann = deriveAnnotationsForArtifact('genome_ref', GOOD.doc)
  const c = canonicalizeViaPacket(JSON.stringify(GOOD.doc), ann)
  if (!c.ok) throw new Error('cannot canonicalize fixture: ' + c.code)
  return Buffer.from(c.canonical, 'utf8')
}
const GOOD_BYTES = canonicalGenome()
/** 第二合法 fixture：corpus 中 genome_ref 仅 gvr-01 为 valid 样例（其余为负例），
 *  这里用字段变体构造一个 canonical 不同的合法工件。 */
function altGenomeDoc() {
  const d = JSON.parse(JSON.stringify(GOOD.doc))
  d.fetched_at = '2025-01-02T03:04:05Z'
  return d
}
function reserve(wd, opts = {}) {
  const r = reserveDesignDispatch({
    cwd: wd,
    op: 'design_stage_artifact',
    args: { artifact_type: 'genome_ref' },
    now: opts.now ?? 1_000_000,
    ...opts,
  })
  // Test-only provenance; production records never receive this field.
  r.test_cwd = wd
  return r
}
function stage(res, bytes = GOOD_BYTES, logicalName = 'genome_ref.json') {
  writeFileSync(join(res.paths.stagingDir, logicalName), bytes)
}
function consume(res, worker = null, options = {}) {
  return consumeDispatchCandidates({ cwd: options.cwd ?? res.test_cwd, caseHandle: options.caseHandle, dispatchId: res.dispatch_id, workerResult: worker, now: options.now ?? 1_000_001, caseContentId: options.caseContentId, policy: options.policy })
}

// ── R1/R2: reservation, state contract, immutable manifest ────────────────
{
  const wd = workdir()
  const r = reserve(wd)
  check('reserve succeeds', r.ok === true, JSON.stringify(r))
  const record = readDispatchRecord({ cwd: wd, dispatchId: r.dispatch_id })
  check('record is RESERVED after ISSUED transition', record.ok && record.record.state === 'RESERVED' && record.record.history.map((x) => x.state).join(',') === 'ISSUED,RESERVED')
  check('audit record has required D1 fields', record.ok && ['dispatch_id', 'state', 'created', 'consumed', 'committed_snapshot', 'failure_code'].every((k) => Object.hasOwn(record.record, k)))
  const manifest = JSON.parse(readFileSync(r.paths.manifestPath, 'utf8'))
  check('manifest binds inputs/outputs/default TTL/limits', Array.isArray(manifest.allowed_input_refs) && manifest.allowed_outputs[0].logical_name === 'genome_ref.json' && manifest.expires_at_ms === 1_900_000 && manifest.limits.max_files === DISPATCH_LIMITS.maxOutputFiles)
  stage(r)
  const c = consume(r, { staged: join(r.paths.stagingDir, 'genome_ref.json'), sha256: undefined, artifact_type: 'genome_ref' })
  check('standalone candidate consumes to COMMITTED', c.ok && c.record.state === 'COMMITTED' && c.record.committed_snapshot === null, JSON.stringify(c))
  check('standalone object was TS-promoted', c.ok && existsSync(c.candidates[0].object_path) && readFileSync(c.candidates[0].object_path).equals(GOOD_BYTES))
  const again = consume(r)
  check('duplicate callback is rejected idempotently', again.ok === false && again.code === 'ALREADY_CONSUMED', JSON.stringify(again))
}

// Reservation rejects unsafe output names and case-fold duplicate names before worker spawn.
{
  const wd = workdir()
  for (const outputs of [
    [{ logical_name: '../evil.json', artifact_type: 'genome_ref' }],
    [{ logical_name: 'x/y.json', artifact_type: 'genome_ref' }],
    [{ logical_name: 'C:evil.json', artifact_type: 'genome_ref' }],
    [{ logical_name: 'x.json', artifact_type: 'genome_ref' }, { logical_name: 'X.json', artifact_type: 'genome_ref' }],
  ]) {
    const r = reserve(wd, { allowedOutputs: outputs })
    check('unsafe/duplicate logical output rejected', r.ok === false && ['OUTPUT_NAME_INVALID', 'DUPLICATE_LOGICAL_NAME'].includes(r.code), JSON.stringify(r))
  }
}

// ── R3: safe staging scanner rejects every protocol class ─────────────────
{
  const wd = workdir()
  const r = reserve(wd)
  stage(r)
  writeFileSync(join(r.paths.stagingDir, 'extra.json'), GOOD_BYTES)
  const c = consume(r)
  check('undeclared output rejects + consumes dispatch', c.ok === false && c.code === 'UNDECLARED_OUTPUT' && c.record?.state === 'FAILED_CONSUMED', JSON.stringify(c))
}
{
  const wd = workdir()
  const r = reserve(wd, { limits: { maxOutputFileBytes: 1, maxOutputTotalBytes: 1 } })
  stage(r)
  const c = consume(r)
  check('per-file size limit rejects', c.ok === false && c.code === 'OUTPUT_FILE_TOO_LARGE', JSON.stringify(c))
}
{
  const wd = workdir()
  const r = reserve(wd)
  stage(r)
  const c = consume(r, { staged: join(r.paths.stagingDir, 'genome_ref.json'), sha256: '0'.repeat(64), artifact_type: 'genome_ref' })
  check('worker self-reported hash mismatch rejects', c.ok === false && c.code === 'WORKER_HASH_MISMATCH', JSON.stringify(c))
}
{
  const wd = workdir()
  const r = reserve(wd)
  stage(r)
  const outside = join(wd, 'outside.json')
  writeFileSync(outside, GOOD_BYTES)
  const c = consume(r, { staged: outside, artifact_type: 'genome_ref' })
  check('worker absolute/external staged path is diagnostic-only and rejected', c.ok === false && c.code === 'WORKER_PATH_UNTRUSTED', JSON.stringify(c))
}
{
  const wd = workdir()
  const r = reserve(wd)
  stage(r)
  const c = consume(r, { artifacts: [{ logical_name: 'genome_ref.json' }, { logical_name: 'genome_ref.json' }] })
  check('duplicate callback logical name rejects', c.ok === false && c.code === 'DUPLICATE_LOGICAL_NAME', JSON.stringify(c))
}
{
  const wd = workdir()
  const r = reserve(wd)
  const outside = join(wd, 'reparse-target')
  mkdirSync(outside)
  writeFileSync(join(outside, 'payload.json'), GOOD_BYTES)
  try {
    // A junction is a Windows reparse link and is constructible without the
    // SeCreateSymbolicLinkPrivilege required for a native file symlink.  The
    // scanner's lstat branch is the same mandatory fail-closed path.
    symlinkSync(outside, join(r.paths.stagingDir, 'genome_ref.json'), 'junction')
    const c = consume(r)
    check('candidate reparse link rejects as reparse point', c.ok === false && c.code === 'STAGING_REPARSE_POINT', JSON.stringify(c))
  } catch (e) {
    check('candidate reparse fixture is constructible (never silently skipped)', false, String(e.message))
  }
}
{
  const wd = workdir()
  const r = reserve(wd)
  const target = join(wd, 'junction-target')
  mkdirSync(target)
  writeFileSync(join(target, 'genome_ref.json'), GOOD_BYTES)
  try {
    rmSync(r.paths.stagingDir, { recursive: true, force: true })
    symlinkSync(target, r.paths.stagingDir, 'junction')
    const c = consume(r)
    // [P0-reparse] consume 入口写前链校验先于 inspect 拦截（更早、更强；修复前由 inspect 报 STAGING_REPARSE_POINT）。
    check('junction staging dir rejects pre-write (chain gate)', c.ok === false && c.code === 'DISPATCH_REPARSE_POINT', JSON.stringify(c))
  } catch (e) {
    check('junction fixture is constructible (never silently skipped)', false, String(e.message))
  }
}
{
  const wd = workdir()
  const r = reserve(wd)
  const outside = join(wd, 'hardlink-source.json')
  writeFileSync(outside, GOOD_BYTES)
  try {
    linkSync(outside, join(r.paths.stagingDir, 'genome_ref.json'))
    const c = consume(r)
    check('hardlink rejects', c.ok === false && c.code === 'STAGING_HARDLINK', JSON.stringify(c))
  } catch (e) {
    check('hardlink fixture is constructible (never silently skipped)', false, String(e.message))
  }
}

// Direct scanner retains a pure, independently testable layer.
{
  const wd = workdir()
  const r = reserve(wd)
  stage(r)
  const manifest = JSON.parse(readFileSync(r.paths.manifestPath, 'utf8'))
  const inspected = inspectStagingCandidates({ manifest, stagingDir: r.paths.stagingDir, now: 1_000_001 })
  check('pure inspect accepts a canonical regular candidate', inspected.ok && inspected.candidates.length === 1 && inspected.candidates[0].sha256.length === 64, JSON.stringify(inspected))
}

// [P0-reparse] 预置 junction 在 reserve 阶段被写前链校验拒绝（修复前会被递归 mkdir 跟随写穿）。
{
  const wd = workdir()
  const target = join(wd, 'pre-junction-target')
  mkdirSync(join(wd, 'result', 'design'), { recursive: true })
  mkdirSync(target)
  symlinkSync(target, join(wd, 'result', 'design', '.dispatches'), 'junction')
  const r = reserve(wd)
  check('pre-placed dispatch-root junction rejects at reserve', r.ok === false && r.code === 'DISPATCH_REPARSE_POINT', JSON.stringify(r))
  check('junction target untouched (no write-through at reserve)', readdirSync(target).length === 0, JSON.stringify(readdirSync(target)))
}
{
  const wd = workdir()
  const target = join(wd, 'pre-control-target')
  mkdirSync(join(wd, 'result', 'design', '.dispatches'), { recursive: true })
  mkdirSync(target)
  symlinkSync(target, join(wd, 'result', 'design', '.dispatches', 'control'), 'junction')
  const r = reserve(wd)
  check('pre-placed control-dir junction rejects at reserve', r.ok === false && r.code === 'DISPATCH_REPARSE_POINT', JSON.stringify(r))
  check('control junction target untouched', readdirSync(target).length === 0, JSON.stringify(readdirSync(target)))
}
// [E3 M0] runtime metadata 在 standalone dispatch 路径同样被拒绝（与 casefile 单点 denylist 同源）。
{
  const wd = workdir()
  const r = reserve(wd)
  const tainted = JSON.parse(JSON.stringify(GOOD.doc))
  tainted._provenance = { tool: 'review', at: '2026-01-01T00:00:00Z' }
  writeFileSync(join(r.paths.stagingDir, 'genome_ref.json'), JSON.stringify(tainted))
  const c = consume(r)
  check('runtime metadata taint rejects on standalone path', c.ok === false && c.code === 'DETERMINISM_VIOLATION', JSON.stringify(c))
  check('no standalone objects promoted for tainted candidate', !existsSync(join(wd, 'objects')) || readdirSync(join(wd, 'objects')).length === 0, '')
}

// ── R4/R6/R7: expiration, late result, restart recovery and GC roots ──────
{
  const wd = workdir()
  const r = reserve(wd, { now: 0, ttlMs: 1 })
  stage(r)
  const expired = consume(r, null, { now: 1 })
  check('expired dispatch is FAILED_CONSUMED', expired.ok === false && expired.code === 'DISPATCH_EXPIRED' && expired.record?.state === 'FAILED_CONSUMED', JSON.stringify(expired))
  const late = consume(r, null, { now: 2 })
  check('late worker result after terminal failure rejects', late.ok === false && late.code === 'LATE_WORKER_RESULT', JSON.stringify(late))
}
{
  const wd = workdir()
  const r = reserve(wd, { now: 0, ttlMs: 100 })
  const moduleUrl = pathToFileURL(join(ROOT, 'src', 'design-dispatch.js')).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { recoverDispatches } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(recoverDispatches({dispatchRoot:${JSON.stringify(r.paths.root)},now:101})))`], { encoding: 'utf8' })
  let output = null
  try { output = JSON.parse(child.stdout.trim()) } catch { /* asserted below */ }
  const record = readDispatchRecord({ cwd: wd, dispatchId: r.dispatch_id })
  check('separate process recovers an expired RESERVED record', child.status === 0 && output?.recovered?.some((x) => x.dispatch_id === r.dispatch_id) && record.record?.state === 'FAILED_CONSUMED', child.stderr || child.stdout)
}
{
  const wd = workdir()
  const r = reserve(wd, { now: 0, ttlMs: 1 })
  // A live consumer owns this lock while it may be inside A2's HEAD CAS.
  writeFileSync(r.paths.consumeLockPath, 'simulated-live-consumer')
  const held = recoverDispatches({ cwd: wd, now: 2 })
  const before = readDispatchRecord({ cwd: wd, dispatchId: r.dispatch_id })
  check('recovery never terminalizes a dispatch while consume lock is held', held.kept.includes(r.dispatch_id) && before.record?.state === 'RESERVED', JSON.stringify({ held, before }))
  unlinkSync(r.paths.consumeLockPath)
  recoverDispatches({ cwd: wd, now: 2 })
  const after = readDispatchRecord({ cwd: wd, dispatchId: r.dispatch_id })
  check('recovery terminalizes the same expired dispatch only after lock release', after.record?.state === 'FAILED_CONSUMED', JSON.stringify(after))
}
{
  const wd = workdir()
  const r = reserve(wd, { now: 1_000_000, ttlMs: 1000 })
  stage(r)
  const before = gcDispatches({ cwd: wd, now: 1_000_001 })
  check('GC keeps live RESERVED dispatch as a root', before.kept.includes(r.dispatch_id) && existsSync(r.paths.stagingDir), JSON.stringify(before))
  const failed = consume(r, { sha256: '0'.repeat(64) }, { now: 1_000_002 })
  const after = gcDispatches({ cwd: wd, now: 1_000_002 + DISPATCH_LIMITS.retentionMs + 1 })
  check('FAILED_CONSUMED remains through terminal transition then is GC eligible after retention', failed.code === 'WORKER_HASH_MISMATCH' && after.removed.includes(r.dispatch_id) && !existsSync(r.paths.dir), JSON.stringify({ failed, after }))
  check('retention cleanup also reclaims the staging twin', after.removed.includes(r.dispatch_id) && !existsSync(r.paths.stagingDir), JSON.stringify({ after }))
}
{
  const wd = workdir()
  const r = reserve(wd)
  const outside = join(wd, 'gc-outside')
  const foreign = join(r.paths.root, 'foreign-junction')
  mkdirSync(outside)
  try {
    symlinkSync(outside, foreign, 'junction')
    const gc = gcDispatches({ cwd: wd, now: 1_000_001 })
    check('dispatch GC never follows or deletes foreign reparse roots', gc.kept.includes('foreign-junction') && existsSync(foreign) && existsSync(outside), JSON.stringify(gc))
  } catch (e) {
    check('foreign junction fixture is constructible (never silently skipped)', false, String(e.message))
  }
}

// A2 gc owns caseDir/staging only: it must not delete a live A3 dispatch.
{
  const wd = workdir()
  const handle = ensureCaseDir(wd, 'case-gc')
  const r = reserve(wd, { caseHandle: handle })
  stage(r)
  const gc = gcOrphans(handle)
  check('A2 gc does not touch independent dispatch staging', gc.ok && existsSync(r.paths.stagingDir) && existsSync(join(r.paths.stagingDir, 'genome_ref.json')), JSON.stringify(gc))
}

// Parent snapshot is checked both at reservation and before consuming output.
{
  const wd = workdir()
  const handle = ensureCaseDir(wd, 'case-stale')
  const content = deriveCaseContentId({ rootInputArtifactIds: ['a'.repeat(64)], policyVersion: '0', canonicalParams: { t: 'a3' } })
  const policy = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: 'b'.repeat(64) }
  const base = commitTransaction(handle, { caseContentId: content.case_content_id, policy, newArtifacts: [{ type: 'genome_ref', value: GOOD.doc, producer: 'test' }] })
  check('case base for stale-parent test commits', base.ok === true, JSON.stringify(base))
  const r = reserve(wd, { caseHandle: handle, parentSnapshot: base.snapshot_sha })
  stage(r)
  writeHeadAtomic(handle.caseDir, 'c'.repeat(64), { expect: base.snapshot_sha })
  const c = consume(r, null, { caseHandle: handle, caseContentId: content.case_content_id, policy })
  check('parent HEAD change before consume is fail-closed', c.ok === false && c.code === 'PARENT_SNAPSHOT_STALE' && c.record?.state === 'FAILED_CONSUMED', JSON.stringify(c))
}

// Input refs bound to a case must resolve inside the parent snapshot.
{
  const wd = workdir()
  const handle = ensureCaseDir(wd, 'case-inputrefs')
  const content = deriveCaseContentId({ rootInputArtifactIds: ['d'.repeat(64)], policyVersion: '0', canonicalParams: { t: 'a3-refs' } })
  const policy = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: 'e'.repeat(64) }
  const base = commitTransaction(handle, { caseContentId: content.case_content_id, policy, newArtifacts: [{ type: 'genome_ref', value: GOOD.doc, producer: 'test' }] })
  check('case base for input-ref test commits', base.ok === true && base.published.length === 1, JSON.stringify(base))
  const bad = reserve(wd, { caseHandle: handle, parentSnapshot: base.snapshot_sha, allowedInputRefs: [{ artifact_id: 'f'.repeat(64) }] })
  check('reservation with bound input refs succeeds (shape only)', bad.ok === true, JSON.stringify(bad))
  stage(bad)
  const unresolved = consume(bad, null, { caseHandle: handle, caseContentId: content.case_content_id, policy })
  check('input ref absent from parent snapshot rejects + consumes', unresolved.ok === false && unresolved.code === 'INPUT_REF_UNRESOLVED' && unresolved.record?.state === 'FAILED_CONSUMED', JSON.stringify(unresolved))
  const good = reserve(wd, { caseHandle: handle, parentSnapshot: base.snapshot_sha, allowedInputRefs: [{ artifact_id: base.published[0] }] })
  stage(good)
  const resolved = consume(good, null, { caseHandle: handle, caseContentId: content.case_content_id, policy })
  check('input ref resolved in parent snapshot commits', resolved.ok === true && resolved.record?.state === 'COMMITTED', JSON.stringify(resolved))
}

// Crash-window recovery: committed transaction, record never terminalized.
{
  const wd = workdir()
  const handle = ensureCaseDir(wd, 'case-crashwin')
  const altDoc = altGenomeDoc()
  const content = deriveCaseContentId({ rootInputArtifactIds: ['3'.repeat(64)], policyVersion: '0', canonicalParams: { t: 'a3-crash' } })
  const policy = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: '4'.repeat(64) }
  const base = commitTransaction(handle, { caseContentId: content.case_content_id, policy, newArtifacts: [{ type: 'genome_ref', value: GOOD.doc, producer: 'test' }] })
  check('case base for crash-window test commits', base.ok === true, JSON.stringify(base))
  const r = reserve(wd, { caseHandle: handle, now: 1_000_000 })
  stage(r)
  // Simulate: the A2 transaction ran under our txid, then the process died
  // before transitionRecord(COMMITTED) could terminalize the record.
  const tx = commitTransaction(handle, { caseContentId: content.case_content_id, policy, expectHead: base.snapshot_sha, txid: r.dispatch_id, newArtifacts: [{ type: 'genome_ref', value: altDoc, producer: 'design_stage_artifact', inputs: [] }] })
  check('simulated committed transaction under the dispatch txid', tx.ok === true && tx.snapshot_sha !== base.snapshot_sha, JSON.stringify(tx))
  const recovery = recoverDispatches({ cwd: wd, caseHandle: handle, now: 1_000_001 })
  check('crash-window recovery reports COMMITTED_RECOVERED', recovery.recovered.some((x) => x.dispatch_id === r.dispatch_id && x.code === 'COMMITTED_RECOVERED'), JSON.stringify(recovery))
  const after = readDispatchRecord({ cwd: wd, caseHandle: handle, dispatchId: r.dispatch_id })
  check('crash-window recovery restores COMMITTED + committed_snapshot', after.record?.state === 'COMMITTED' && after.record.committed_snapshot === tx.snapshot_sha, JSON.stringify(after))
}

// A foreign transaction that advances HEAD without our txid kills the dispatch.
{
  const wd = workdir()
  const handle = ensureCaseDir(wd, 'case-crashstale')
  const altDoc = altGenomeDoc()
  const content = deriveCaseContentId({ rootInputArtifactIds: ['5'.repeat(64)], policyVersion: '0', canonicalParams: { t: 'a3-crashstale' } })
  const policy = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: '6'.repeat(64) }
  const base = commitTransaction(handle, { caseContentId: content.case_content_id, policy, newArtifacts: [{ type: 'genome_ref', value: GOOD.doc, producer: 'test' }] })
  const r = reserve(wd, { caseHandle: handle, now: 2_000_000 })
  const other = commitTransaction(handle, { caseContentId: content.case_content_id, policy, expectHead: base.snapshot_sha, txid: 'foreign-tx', newArtifacts: [{ type: 'genome_ref', value: altDoc, producer: 'other' }] })
  check('foreign transaction advances HEAD', base.ok === true && other.ok === true && other.snapshot_sha !== base.snapshot_sha, JSON.stringify(other))
  recoverDispatches({ cwd: wd, caseHandle: handle, now: 2_000_001 })
  const after = readDispatchRecord({ cwd: wd, caseHandle: handle, dispatchId: r.dispatch_id })
  check('HEAD advanced without our txid -> PARENT_SNAPSHOT_STALE', after.record?.state === 'FAILED_CONSUMED' && after.record.failure_code === 'PARENT_SNAPSHOT_STALE', JSON.stringify(after))
}

// One real worker route preserves the public dispatchDesignOp compatibility API.
{
  const wd = workdir()
  const e2e = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: 'genome_ref', raw_json: JSON.stringify(GOOD.doc) }, { cwd: wd, timeoutMs: 180000 })
  const record = e2e.dispatch_id ? readDispatchRecord({ cwd: wd, dispatchId: e2e.dispatch_id }) : null
  check('real Python worker E2E reaches COMMITTED through manifest candidate path', e2e.ok === true && e2e.committed?.ok === true && record?.record?.state === 'COMMITTED', JSON.stringify(e2e).slice(0, 360))
}

for (const root of roots) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* cleanup does not change test verdict */ }
}
console.log(`design-dispatch: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
