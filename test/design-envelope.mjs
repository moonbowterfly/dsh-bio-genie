// dsh-bio-genie — A5 result envelope / audit overlay / registry tests.
// The assertions marked "mutation kill" are deliberately sensitive to the
// four safety predicates required by the A5 work order.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DESIGN_RESULT_STATUSES,
  assertNoDesignPreCache,
  buildAuditOverlay,
  finalizeDesignResult,
  isScientificArtifactRef,
  queryScientificRegistry,
  sanitizeDiagnostic,
  validateResultEnvelope,
} from '../src/design-envelope.js'
import { ensureCaseDir } from '../src/design-casefile.js'

let pass = 0
let failed = 0
const roots = []
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log('  PASS ' + name)
  } else {
    failed += 1
    console.log('  FAIL ' + name + (detail ? ' :: ' + detail : ''))
  }
}

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'design-envelope-'))
  roots.push(dir)
  return dir
}

function envelope(status = 'OK', refs = []) {
  return { status, reason_code: status === 'OK' ? 'OK' : 'TEST_TERMINAL', artifact_refs: refs, detail: 'terminal ' + status }
}

function scienceRef() {
  return { artifact_id: A, expected_sha256: A, relative_path: 'objects/' + A }
}

function auditEvents(caseDir) {
  const receipt = join(caseDir, 'run_receipt.jsonl')
  if (!existsSync(receipt)) return []
  return readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((x) => x.event === 'audit_overlay')
}

// ── C4 envelope grammar: all tool terminal statuses are accepted. ────────
for (const status of DESIGN_RESULT_STATUSES) {
  const parsed = validateResultEnvelope(envelope(status))
  check('all terminal statuses accept: ' + status, parsed.ok && parsed.envelope.status === status, JSON.stringify(parsed))
  const audited = buildAuditOverlay({ operation: 'design_casefile_validate', envelope: envelope(status) })
  check('all terminal statuses produce audit overlay: ' + status, audited.ok && audited.audit.status === status, JSON.stringify(audited))
}
check('unknown status rejects', validateResultEnvelope(envelope('SUCCESS')).ok === false)
check('missing reason_code rejects', validateResultEnvelope({ status: 'OK', artifact_refs: [], detail: 'x' }).ok === false)
check('unsafe structured artifact ref rejects', validateResultEnvelope(envelope('OK', [{ artifact_id: A, expected_sha256: A, relative_path: '../escape' }])).ok === false)
check('scientific ref exact shape accepts', isScientificArtifactRef(scienceRef()) === true)
check('scientific ref additional field rejects', isScientificArtifactRef({ ...scienceRef(), injected: true }) === false)
check('scientific ref hash identity mismatch rejects', isScientificArtifactRef({ ...scienceRef(), expected_sha256: B }) === false)

// ── Read-side registry boundary: audit overlays are not scientific inputs. ──
{
  const manifest = { artifacts: [{ artifact_id: A, type: 'genome_ref@1' }, { artifact_id: B, type: 'host_profile@1' }] }
  const q = queryScientificRegistry(manifest, { artifactId: A })
  check('registry query returns only immutable scientific artifact match', q.ok && q.artifacts.length === 1 && q.artifacts[0].type === 'genome_ref@1')
  const bad = queryScientificRegistry({ artifacts: [{ artifact_id: A, type: 'tool_result@1' }] })
  check('registry query rejects receipt-only tool_result as scientific input', bad.ok === false && bad.code === 'AUDIT_INPUT_FORBIDDEN')
}

// ── Sanitization and TS-generated audit overlays. ─────────────────────────
{
  const raw = `\u001b[31mtoken=TOP_SECRET\r\npassword: hunter2\t${'x'.repeat(6_000)}`
  const clean = sanitizeDiagnostic(raw)
  // mutation kill #1: removing redaction/truncation/control cleanup makes one
  // or more predicates below fail.
  check('mutation kill sanitizer redacts credentials', !clean.includes('TOP_SECRET') && !clean.includes('hunter2'), clean.slice(0, 120))
  check('mutation kill sanitizer bounds stderr', clean.length <= 4096 && !/[\r\n\t\x1b]/.test(clean), 'len=' + clean.length)

  const bad = buildAuditOverlay({
    operation: 'design_casefile_validate',
    envelope: null,
    worker: { stderr: raw, exitCode: 7 },
    inputHashes: [B, A],
  })
  check('missing worker envelope becomes TS EXECUTION_ERROR overlay', bad.ok && bad.synthesized && bad.audit.generated_by === 'ts_wrapper' && bad.audit.status === 'EXECUTION_ERROR')
  check('TS audit carries sorted input hashes + bounded sanitized stderr', bad.ok && JSON.stringify(bad.audit.input_hashes) === JSON.stringify([A, B]) && !bad.audit.stderr_summary.includes('TOP_SECRET'))

  const legal = buildAuditOverlay({
    operation: 'design_casefile_validate',
    envelope: envelope('BLOCKED', [scienceRef(), '/non-scientific/export/path']),
    inputHashes: [A],
  })
  check('legal envelope becomes python audit overlay', legal.ok && !legal.synthesized && legal.audit.generated_by === 'python_worker' && legal.audit.status === 'BLOCKED')
  check('audit graph keeps only typed scientific refs; receipt may retain paths', legal.ok && legal.audit.artifact_refs.length === 1 && legal.audit.artifact_refs[0].artifact_id === A)
}

// ── Guard → no generic pre-cache → audit/registry → provenance. ──────────
{
  const wd = root()
  const c = ensureCaseDir(wd, 'envelope-case')
  check('A2 case for receipt created', c.ok === true, JSON.stringify(c))
  const order = []
  let registryCalls = 0
  const result = await finalizeDesignResult({
    operation: 'design_casefile_validate',
    envelope: envelope('OK', [scienceRef()]),
    inputHashes: [A],
    caseDir: c.caseDir,
    guard: () => { order.push('guard'); return { ok: true } },
    registerScientific: ({ artifact_refs: refs }) => { order.push('registry'); registryCalls += 1; return { ok: refs.length === 1, committed: true } },
    stampProvenance: (out) => { order.push('provenance'); return { ...out, stamped: true } },
  })
  check('OK envelope registers exactly once', result.ok && result.registry.registered && registryCalls === 1, JSON.stringify(result))
  check('guard precedes registry/provenance', order.join(',') === 'guard,registry,provenance', order.join(','))
  check('all-terminal overlay lives in receipt, not scientific objects', auditEvents(c.caseDir).length === 1 && auditEvents(c.caseDir)[0].audit.audit_only === true && readdirSync(c.objectsDir).length === 0)

  const nonOk = await finalizeDesignResult({
    operation: 'design_casefile_validate',
    envelope: envelope('BLOCKED', [scienceRef()]),
    caseDir: c.caseDir,
    guard: () => ({ ok: true }),
    registerScientific: () => { registryCalls += 100; return { ok: true } },
  })
  // mutation kill #2: weakening the status=OK registry gate makes this fail.
  check('mutation kill registry only records status=OK', nonOk.ok === false && nonOk.registry.registered === false && registryCalls === 1, JSON.stringify(nonOk))

  const invalid = await finalizeDesignResult({
    operation: 'design_casefile_validate',
    envelope: { status: 'OK', artifact_refs: [] },
    worker: { stderr: 'token=worker-secret\ntraceback' },
    caseDir: c.caseDir,
    guard: () => ({ ok: true }),
  })
  check('invalid worker envelope writes TS audit and never registers', invalid.ok === false && invalid.synthesized && invalid.audit.generated_by === 'ts_wrapper' && invalid.registry.registered === false)
  check('receipt contains all three terminal overlays', auditEvents(c.caseDir).length === 3)
}

// ── Generic pre-cache is prohibited only after the guard has run. ─────────
{
  const wd = root()
  const c = ensureCaseDir(wd, 'cache-policy-case')
  check('cache policy case created', c.ok === true, JSON.stringify(c))
  const order = []
  const r = await finalizeDesignResult({
    operation: 'design_casefile_export',
    envelope: envelope('OK'),
    caseDir: c.caseDir,
    guard: () => { order.push('guard'); return { ok: true } },
    cacheGet: () => { order.push('cache'); return { unexpected: true } },
  })
  // mutation kill #3: removing cache policy enforcement (or moving a cache
  // read before the guard) makes this fail.
  check('mutation kill design pre-cache is forbidden after guard', r.ok === false && r.code === 'DESIGN_PRECACHE_FORBIDDEN' && order.join(',') === 'guard', JSON.stringify(r))
  check('pre-cache refusal is also receipt-audited', r.audit?.status === 'EXECUTION_ERROR' && r.audit_write?.ok === true && auditEvents(c.caseDir).length === 1)
  check('direct cache-policy assertion rejects design op', assertNoDesignPreCache({ operation: 'design_consequence', preCache: true }).code === 'DESIGN_PRECACHE_FORBIDDEN')
  check('non-design cache policy remains outside A5 scope', assertNoDesignPreCache({ operation: 'ordinary_op', preCache: true }).ok === true)
}

for (const dir of roots) rmSync(dir, { recursive: true, force: true })
console.log(`design-envelope: ${pass} passed, ${failed} failed`)
if (failed) process.exit(1)
