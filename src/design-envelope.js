/**
 * dsh-bio-genie — design result envelope, audit overlay, and registry guard (A5).
 *
 * A design worker never writes a scientific snapshot or receipt directly.  Its
 * public result is first reduced to the C4 envelope, then this module writes a
 * receipt-attached `tool_result@1` audit overlay.  Only an explicit, valid OK
 * envelope may reach a supplied scientific-registry callback.
 *
 * `tool_result@1` is deliberately not itself registered: the frozen schema
 * marks it audit_only and case_manifest rejects that type as a scientific
 * artifact.  This module repeats that boundary at the API edge as defence in
 * depth.
 *
 * @module dsh-bio-genie/design-envelope
 */
import { createHash } from 'node:crypto'
import { appendReceipt } from './design-casefile.js'
import { validateDesignArtifact } from './design-validate.js'
import { verifyDesignPacket } from './design-gate.js'
import { DESIGN_OPS } from './design-ops.js'

const H64 = /^[0-9a-f]{64}$/
const REASON = /^[A-Z][A-Z0-9_:-]{0,127}$/
const MAX_DETAIL_CHARS = 8192
const MAX_STDERR_CHARS = 4096
const MAX_REFS = 128
const MAX_INPUT_HASHES = 128

/** Frozen tool-call status vocabulary (v0.2 §3.4 / tool_result@1). */
export const DESIGN_RESULT_STATUSES = Object.freeze([
  'OK',
  'BLOCKED',
  'NOT_RUN',
  'OUT_OF_DOMAIN',
  'DEPENDENCY_UNAVAILABLE',
  'INVALID_INPUT',
  'EXECUTION_ERROR',
])

export const DESIGN_RESULT_STATUS_SET = new Set(DESIGN_RESULT_STATUSES)

/** Stable local failure codes emitted when a worker has no legal C4 envelope. */
export const DESIGN_ENVELOPE_REASON_CODES = Object.freeze({
  WORKER_ENVELOPE_INVALID: 'WORKER_ENVELOPE_INVALID',
  WORKER_TIMEOUT: 'WORKER_TIMEOUT',
  WORKER_ABORTED: 'WORKER_ABORTED',
  WORKER_CRASH: 'WORKER_CRASH',
  GUARD_REJECTED: 'GUARD_REJECTED',
  AUDIT_OVERLAY_INVALID: 'AUDIT_OVERLAY_INVALID',
  AUDIT_RECEIPT_FAILED: 'AUDIT_RECEIPT_FAILED',
  REGISTRY_REJECTED: 'REGISTRY_REJECTED',
  DESIGN_PRECACHE_FORBIDDEN: 'DESIGN_PRECACHE_FORBIDDEN',
  SCIENTIFIC_ARTIFACT_REF_REQUIRED: 'SCIENTIFIC_ARTIFACT_REF_REQUIRED',
})

function fail(code, detail = null, extra = {}) {
  return { ok: false, code, ...(detail ? { detail } : {}), ...extra }
}

function clip(text, max) {
  let out = String(text ?? '')
  if (out.length <= max) return out
  out = out.slice(0, Math.max(0, max - 14))
  // Never leave a lone high surrogate after a UTF-16 slice.
  if (out.length > 0 && /[\ud800-\udbff]/.test(out.at(-1))) out = out.slice(0, -1)
  return out + '…[truncated]'
}

/**
 * Receipt-safe stderr/detail rendering.  It intentionally removes control
 * chars, ANSI escapes and common credential assignment forms before applying
 * the frozen schema's length cap.
 */
export function sanitizeDiagnostic(value, { maxChars = MAX_STDERR_CHARS } = {}) {
  let text = String(value ?? '')
  text = text.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
  text = text.replace(/[\r\n\t]+/g, ' ')
  text = text.replace(/\b(authorization|bearer|token|api[_-]?key|password|secret)\s*([:=])\s*([^\s,;]+)/gi,
    (_all, key, sep) => `${key}${sep}[REDACTED]`)
  text = text.replace(/\s+/g, ' ').trim()
  return clip(text, maxChars)
}

function normalizeInputHashes(inputHashes = []) {
  if (!Array.isArray(inputHashes)) return fail('INPUT_HASHES_INVALID', 'input_hashes must be an array')
  if (inputHashes.length > MAX_INPUT_HASHES) return fail('INPUT_HASHES_INVALID', 'too many input hashes')
  const seen = new Set()
  for (const value of inputHashes) {
    if (typeof value !== 'string' || !H64.test(value)) return fail('INPUT_HASHES_INVALID', 'input hash must be lowercase sha256')
    if (seen.has(value)) return fail('INPUT_HASHES_INVALID', 'duplicate input hash')
    seen.add(value)
  }
  return { ok: true, hashes: [...seen].sort() }
}

function stableInputJson(value, seen = new Set()) {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite input number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map((entry) => stableInputJson(entry, seen)).join(',') + ']'
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('cyclic input')
    seen.add(value)
    const text = '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableInputJson(value[key], seen)).join(',') + '}'
    seen.delete(value)
    return text
  }
  throw new Error('non-JSON input type')
}

/** Deterministic receipt-only hash of the caller-supplied operation input. */
export function deriveDesignInputHash(operation, args = {}) {
  try {
    return createHash('sha256').update(stableInputJson({ operation, args }), 'utf8').digest('hex')
  } catch {
    // The tool schema should already limit args to JSON.  If a programmatic
    // caller violates that boundary, retain a deterministic hash rather than
    // placing raw/unserializable values in the receipt.
    return createHash('sha256').update(String(operation) + ':UNSERIALIZABLE_INPUT', 'utf8').digest('hex')
  }
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false
  if (/^[\\/]|^[A-Za-z]:|[\\]/.test(value) || value.includes('\u0000')) return false
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** Exact frozen artifactRef shape, used only for scientific registration/audit refs. */
export function isScientificArtifactRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== 'artifact_id,expected_sha256,relative_path') return false
  return H64.test(value.artifact_id) && value.artifact_id === value.expected_sha256 && isSafeRelativePath(value.relative_path)
}

function normalizeEnvelopeRefs(refs) {
  if (!Array.isArray(refs)) return fail('ENVELOPE_ARTIFACT_REFS_INVALID', 'artifact_refs must be an array')
  if (refs.length > MAX_REFS) return fail('ENVELOPE_ARTIFACT_REFS_INVALID', 'too many artifact_refs')
  const seen = new Set()
  const normalized = []
  for (const ref of refs) {
    let key
    if (typeof ref === 'string') {
      if (ref.length === 0 || ref.length > 2048) return fail('ENVELOPE_ARTIFACT_REFS_INVALID', 'path ref is empty or too long')
      key = 'path:' + ref
    } else if (isScientificArtifactRef(ref)) {
      key = `artifact:${ref.artifact_id}:${ref.expected_sha256}:${ref.relative_path}`
    } else {
      return fail('ENVELOPE_ARTIFACT_REFS_INVALID', 'artifact ref must be a path string or exact artifactRef')
    }
    if (seen.has(key)) return fail('ENVELOPE_ARTIFACT_REFS_INVALID', 'duplicate artifact ref')
    seen.add(key)
    normalized.push(ref)
  }
  return { ok: true, refs: normalized }
}

/**
 * Parse the C4 envelope.  Additional worker fields (for example checks[]) are
 * intentionally retained outside the normalized four-field result, because
 * they are presentation data rather than authorization data.
 */
export function validateResultEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('RESULT_ENVELOPE_INVALID', 'envelope must be an object')
  const { status, reason_code: reasonCode, artifact_refs: artifactRefs, detail } = value
  if (!DESIGN_RESULT_STATUS_SET.has(status)) return fail('RESULT_ENVELOPE_INVALID', 'unknown status')
  if (typeof reasonCode !== 'string' || !REASON.test(reasonCode)) return fail('RESULT_ENVELOPE_INVALID', 'reason_code must be a stable uppercase code')
  if (typeof detail !== 'string' || detail.length > MAX_DETAIL_CHARS) return fail('RESULT_ENVELOPE_INVALID', 'detail must be a bounded string')
  const refs = normalizeEnvelopeRefs(artifactRefs)
  if (!refs.ok) return refs
  return {
    ok: true,
    envelope: { status, reason_code: reasonCode, artifact_refs: refs.refs, detail },
    extra: Object.fromEntries(Object.entries(value).filter(([key]) => !['status', 'reason_code', 'artifact_refs', 'detail'].includes(key))),
  }
}

function inferWorkerFailure(worker = {}) {
  if (worker && worker.timedOut) return DESIGN_ENVELOPE_REASON_CODES.WORKER_TIMEOUT
  if (worker && (worker.code === 'ABORTED' || worker.aborted)) return DESIGN_ENVELOPE_REASON_CODES.WORKER_ABORTED
  if (worker && (worker.error || worker.stderr || worker.exitCode !== undefined)) return DESIGN_ENVELOPE_REASON_CODES.WORKER_CRASH
  return DESIGN_ENVELOPE_REASON_CODES.WORKER_ENVELOPE_INVALID
}

function structuredRefs(refs) {
  return refs.filter(isScientificArtifactRef).sort((a, b) => {
    const ka = `${a.artifact_id}:${a.expected_sha256}:${a.relative_path}`
    const kb = `${b.artifact_id}:${b.expected_sha256}:${b.relative_path}`
    return ka.localeCompare(kb, 'en')
  })
}

/**
 * Construct an audit-only tool_result@1.  A legal worker envelope stays
 * classified as python_worker; malformed/no-envelope paths are TS-owned and
 * always become EXECUTION_ERROR with sanitized diagnostics.
 */
export function buildAuditOverlay({ operation, envelope = null, worker = null, inputHashes = [], reasonCode = null, detail = null, allowUnverifiedPacket = false } = {}) {
  if (typeof operation !== 'string' || !DESIGN_OPS.has(operation)) return fail('AUDIT_OPERATION_INVALID', 'operation must be a design op')
  const hashes = normalizeInputHashes(inputHashes)
  if (!hashes.ok) return hashes
  const parsed = validateResultEnvelope(envelope)
  let audit
  let normalizedEnvelope = null
  if (parsed.ok) {
    normalizedEnvelope = parsed.envelope
    audit = {
      artifact_type: 'tool_result@1',
      audit_only: true,
      status: parsed.envelope.status,
      reason_code: parsed.envelope.reason_code,
      reason_codes: [parsed.envelope.reason_code],
      artifact_refs: structuredRefs(parsed.envelope.artifact_refs),
      detail: sanitizeDiagnostic(parsed.envelope.detail, { maxChars: MAX_DETAIL_CHARS }),
      input_hashes: hashes.hashes,
      producer: operation,
      generated_by: 'python_worker',
    }
  } else {
    const code = reasonCode || inferWorkerFailure(worker)
    const diagnostic = detail || worker?.error || worker?.stderr || parsed.detail || 'worker returned no legal result envelope'
    audit = {
      artifact_type: 'tool_result@1',
      audit_only: true,
      status: 'EXECUTION_ERROR',
      reason_code: REASON.test(code) ? code : DESIGN_ENVELOPE_REASON_CODES.WORKER_ENVELOPE_INVALID,
      reason_codes: [REASON.test(code) ? code : DESIGN_ENVELOPE_REASON_CODES.WORKER_ENVELOPE_INVALID],
      artifact_refs: [],
      detail: sanitizeDiagnostic(diagnostic, { maxChars: MAX_DETAIL_CHARS }),
      input_hashes: hashes.hashes,
      producer: operation,
      generated_by: 'ts_wrapper',
      stderr_summary: sanitizeDiagnostic(worker?.stderr || worker?.error || '', { maxChars: MAX_STDERR_CHARS }),
    }
  }
  const checked = validateDesignArtifact('tool_result', audit)
  if (!checked.ok) {
    // A packet/acceptance failure is itself a terminal result which must be
    // audit-visible.  The overlay is never scientific input; retain the
    // structurally constructed record in receipt only, rather than silently
    // losing the failure because the packet validator is unavailable.
    const packetUnavailable = checked.errors?.some((error) => error?.code === 'PACKET_UNVERIFIED')
    if (!allowUnverifiedPacket || !packetUnavailable) {
      return fail(DESIGN_ENVELOPE_REASON_CODES.AUDIT_OVERLAY_INVALID, 'tool_result@1 validation failed', { errors: checked.errors, audit })
    }
    return { ok: true, audit, envelope: normalizedEnvelope, extra: parsed.ok ? parsed.extra : {}, synthesized: !parsed.ok, unverified_packet: true }
  }
  return { ok: true, audit, envelope: normalizedEnvelope, extra: parsed.ok ? parsed.extra : {}, synthesized: !parsed.ok }
}

function receiptSafeRefs(refs) {
  return refs.slice(0, MAX_REFS).map((ref) => {
    if (typeof ref === 'string') return sanitizeDiagnostic(ref, { maxChars: 2048 })
    return { artifact_id: ref.artifact_id, expected_sha256: ref.expected_sha256, relative_path: ref.relative_path }
  })
}

/**
 * Append the complete terminal audit event.  `tool_result@1` remains an audit
 * overlay in JSONL, never a manifest object or a candidate scientific input.
 */
export function appendAuditOverlay(caseDir, result, { operation, now = new Date().toISOString(), limits = null } = {}) {
  if (!result || !result.audit || !result.audit.audit_only) return fail('AUDIT_OVERLAY_INVALID', 'missing audit-only result')
  const event = {
    event: 'audit_overlay',
    at: now,
    operation,
    audit: result.audit,
    // Retain worker-declared paths/checks as receipt evidence without making
    // them valid artifactRefs or scientific graph inputs.
    reported_artifact_refs: result.envelope ? receiptSafeRefs(result.envelope.artifact_refs) : [],
    envelope_valid: !result.synthesized,
  }
  const written = appendReceipt(caseDir, event, { limits })
  if (!written.ok) return fail(DESIGN_ENVELOPE_REASON_CODES.AUDIT_RECEIPT_FAILED, written.code, { event })
  return { ok: true, event, path: written.path }
}

/**
 * Register only a valid `status=OK` result.  The actual snapshot transaction
 * stays caller-owned (A2/A3/B1): this layer refuses audit overlays/non-OK
 * results and hands only normalized scientific artifact references to the
 * transaction callback.
 */
export async function registerSuccessfulDesignResult(result, { registerScientific = null } = {}) {
  if (!result?.ok || !result.envelope) return fail('REGISTRY_ENVELOPE_INVALID', 'legal envelope required')
  if (result.envelope.status !== 'OK') return { ok: true, registered: false, reason: 'STATUS_NOT_OK' }
  const refs = structuredRefs(result.envelope.artifact_refs)
  if (refs.length === 0) return { ok: true, registered: false, reason: 'NO_SCIENTIFIC_ARTIFACT_REFS' }
  if (typeof registerScientific !== 'function') return fail(DESIGN_ENVELOPE_REASON_CODES.REGISTRY_REJECTED, 'scientific registry callback required')
  const registered = await registerScientific({ artifact_refs: refs, envelope: result.envelope })
  if (!registered || registered.ok === false) return fail(DESIGN_ENVELOPE_REASON_CODES.REGISTRY_REJECTED, registered?.code || 'registry callback rejected')
  return { ok: true, registered: true, result: registered }
}

/**
 * Read-side registry boundary for an already-loaded immutable scientific
 * snapshot manifest.  A2 remains the storage/transaction authority; this
 * helper gives callers one place to enforce that receipt-only tool_result@1
 * entries can never be treated as queryable scientific artifacts.
 */
export function queryScientificRegistry(manifest, { artifactId = null, type = null } = {}) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.artifacts)) {
    return fail('REGISTRY_MANIFEST_INVALID', 'immutable manifest.artifacts array required')
  }
  if (artifactId !== null && (typeof artifactId !== 'string' || !H64.test(artifactId))) {
    return fail('REGISTRY_QUERY_INVALID', 'artifactId must be lowercase sha256')
  }
  if (type !== null && (typeof type !== 'string' || !type.endsWith('@1'))) {
    return fail('REGISTRY_QUERY_INVALID', 'type must be an @1 artifact type')
  }
  const artifacts = []
  for (const entry of manifest.artifacts) {
    if (!entry || typeof entry !== 'object' || typeof entry.artifact_id !== 'string' || typeof entry.type !== 'string') {
      return fail('REGISTRY_MANIFEST_INVALID', 'malformed artifact entry')
    }
    if (entry.type === 'tool_result@1') {
      return fail('AUDIT_INPUT_FORBIDDEN', 'tool_result@1 must remain receipt-attached only')
    }
    if ((artifactId === null || entry.artifact_id === artifactId) && (type === null || entry.type === type)) artifacts.push(entry)
  }
  return { ok: true, artifacts }
}

/** Six design ops may never pass generic pre-cache callbacks into this path. */
export function assertNoDesignPreCache({ operation, cacheGet = null, cacheSet = null, preCache = false } = {}) {
  if (!DESIGN_OPS.has(operation)) return { ok: true }
  if (preCache || typeof cacheGet === 'function' || typeof cacheSet === 'function') {
    return fail(DESIGN_ENVELOPE_REASON_CODES.DESIGN_PRECACHE_FORBIDDEN, 'design operations cannot use generic pre-cache')
  }
  return { ok: true }
}

/**
 * Guard → (pre-cache policy) → audit/registry → provenance.  The explicit
 * ordering is testable through injected callbacks and leaves no route for a
 * generic pre-cache to return a design result before the packet guard.
 */
export async function finalizeDesignResult({
  operation,
  envelope = null,
  worker = null,
  inputHashes = [],
  caseDir = null,
  guard = verifyDesignPacket,
  cacheGet = null,
  cacheSet = null,
  preCache = false,
  registerScientific = null,
  stampProvenance = null,
  now = undefined,
} = {}) {
  if (typeof guard !== 'function') return fail('GUARD_INVALID', 'guard must be a function')
  const gate = await guard()
  if (!gate || gate.ok === false) {
    const overlay = buildAuditOverlay({
      operation,
      worker,
      inputHashes,
      reasonCode: gate?.code && REASON.test(gate.code) ? gate.code : DESIGN_ENVELOPE_REASON_CODES.GUARD_REJECTED,
      detail: gate?.detail || 'design packet guard rejected operation',
      allowUnverifiedPacket: true,
    })
    const audit = overlay.ok && caseDir ? appendAuditOverlay(caseDir, overlay, { operation, now }) : null
    return fail(gate?.code || DESIGN_ENVELOPE_REASON_CODES.GUARD_REJECTED, gate?.detail, { audit: overlay.audit, audit_write: audit })
  }
  const cachePolicy = assertNoDesignPreCache({ operation, cacheGet, cacheSet, preCache })
  if (!cachePolicy.ok) {
    const overlay = buildAuditOverlay({
      operation,
      worker,
      inputHashes,
      reasonCode: cachePolicy.code,
      detail: cachePolicy.detail || 'generic pre-cache was offered to a design operation',
    })
    const audit = overlay.ok && caseDir ? appendAuditOverlay(caseDir, overlay, { operation, now }) : null
    return fail(cachePolicy.code, cachePolicy.detail, { audit: overlay.audit, audit_write: audit })
  }
  const result = buildAuditOverlay({ operation, envelope, worker, inputHashes })
  if (!result.ok) return result
  let audit = null
  if (caseDir) {
    audit = appendAuditOverlay(caseDir, result, { operation, now })
    if (!audit.ok) return audit
  }
  // A malformed/absent worker envelope is already represented by the
  // TS-generated audit overlay.  It is terminal failure, not a failed attempt
  // to register a scientific result.
  const registry = result.envelope
    ? await registerSuccessfulDesignResult(result, { registerScientific })
    : { ok: true, registered: false, reason: 'INVALID_ENVELOPE' }
  if (!registry.ok) return registry
  const output = result.envelope
    ? { ...result.envelope, ...result.extra }
    : null
  // Provenance decorates a successfully returned design result only; terminal
  // non-OK outcomes are already captured by the immutable audit overlay.
  const stamped = output && result.envelope?.status === 'OK' && typeof stampProvenance === 'function'
    ? await stampProvenance(output)
    : output
  return {
    ok: result.envelope?.status === 'OK',
    status: result.audit.status,
    envelope: stamped,
    audit: result.audit,
    audit_write: audit,
    registry,
    synthesized: result.synthesized,
  }
}

/** Stable audit identity helper for tests/report builders; not an artifact id. */
export function auditOverlayId(audit) {
  return createHash('sha256').update(JSON.stringify(audit)).digest('hex')
}
