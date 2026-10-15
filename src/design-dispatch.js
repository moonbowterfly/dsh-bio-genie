/**
 * dsh-bio-genie — designTool dispatch state machine (A3).
 *
 * The worker is deliberately not a casefile producer.  It receives one
 * candidate directory and can only propose bytes there; this module is the
 * sole path that re-reads, hashes, validates, promotes, and (when bound to a
 * case) advances HEAD through A2's CAS transaction.
 *
 * @module dsh-bio-genie/design-dispatch
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync,
  writeFileSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'
import { DESIGN_OPS } from './design-ops.js'
import { verifyDesignPacket, PACKET_DIR } from './design-gate.js'
import { deriveAnnotationsForArtifact, validateDesignArtifact } from './design-validate.js'
import { CASE_LIMITS, commitTransaction, computeSnapshotSha, loadSnapshot, readHead, scanRuntimeMetadata } from './design-casefile.js'
import { spawnPython } from './python.js'

const OPS_PATH = join(import.meta.dirname, '..', 'python', 'bio_ops.py')
const H64 = /^[0-9a-f]{64}$/
const TERMINAL = new Set(['COMMITTED', 'FAILED_CONSUMED'])
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/** v1 defaults.  Callers may tighten them but cannot enlarge them. */
export const DISPATCH_LIMITS = Object.freeze({
  ttlMs: 900_000,
  retentionMs: 86_400_000,
  maxOutputFiles: 16,
  maxOutputFileBytes: CASE_LIMITS.maxObjectBytes,
  maxOutputTotalBytes: CASE_LIMITS.maxObjectBytes,
})

function sha256hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function fail(code, detail = null, extra = {}) {
  return { ok: false, code, ...(detail ? { detail } : {}), ...extra }
}

function iso(now = Date.now()) {
  return new Date(now).toISOString()
}

function isContained(root, target) {
  const r = relative(resolve(root), resolve(target))
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

function atomicWriteBytes(path, bytes) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp-' + process.pid + '-' + randomUUID()
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

function atomicWriteJson(path, value) {
  atomicWriteBytes(path, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'))
}

function appendJsonl(path, value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n', 'utf8')
  const fd = openSync(path, 'a')
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function readJson(path, code) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (e) {
    return fail(code, String(e.message).slice(0, 160))
  }
}

function safeLogicalName(name) {
  if (typeof name !== 'string' || !name || name.length > 160) return fail('OUTPUT_NAME_INVALID', 'logical name missing or too long')
  if (name !== name.normalize('NFC')) return fail('OUTPUT_NAME_INVALID', 'logical name must be NFC')
  if (name === '.' || name === '..' || name.includes('..')) return fail('OUTPUT_NAME_INVALID', 'dot traversal is not allowed')
  if (/[\\/]/.test(name) || isAbsolute(name) || win32.isAbsolute(name) || win32.basename(name) !== name || basename(name) !== name) {
    return fail('OUTPUT_NAME_INVALID', 'logical name must be one relative path segment')
  }
  if (/^[A-Za-z]:/.test(name) || /[\x00-\x1f<>:"|?*]/.test(name) || /[. ]$/.test(name)) {
    return fail('OUTPUT_NAME_INVALID', 'logical name contains a Windows-unsafe form')
  }
  if (RESERVED_NAMES.has(name.split('.')[0].toUpperCase())) return fail('OUTPUT_NAME_INVALID', 'reserved device name')
  return { ok: true, name }
}

function normalizeLimits(limits = {}, ttlMs = undefined) {
  const supplied = limits == null ? {} : limits
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) return fail('DISPATCH_LIMIT_INVALID', 'limits must be an object')
  const requested = {
    ttlMs: ttlMs ?? supplied.ttlMs ?? DISPATCH_LIMITS.ttlMs,
    retentionMs: supplied.retentionMs ?? DISPATCH_LIMITS.retentionMs,
    maxOutputFiles: supplied.maxOutputFiles ?? DISPATCH_LIMITS.maxOutputFiles,
    maxOutputFileBytes: supplied.maxOutputFileBytes ?? DISPATCH_LIMITS.maxOutputFileBytes,
    maxOutputTotalBytes: supplied.maxOutputTotalBytes ?? DISPATCH_LIMITS.maxOutputTotalBytes,
  }
  for (const [key, value] of Object.entries(requested)) {
    if (!Number.isSafeInteger(value) || value <= 0) return fail('DISPATCH_LIMIT_INVALID', key + ' must be a positive safe integer')
    if (value > DISPATCH_LIMITS[key]) return fail('DISPATCH_LIMIT_INVALID', key + ' may only tighten v1 default')
  }
  if (requested.maxOutputTotalBytes < requested.maxOutputFileBytes) {
    return fail('DISPATCH_LIMIT_INVALID', 'maxOutputTotalBytes cannot be below maxOutputFileBytes')
  }
  return { ok: true, limits: requested }
}

function normalizeInputRefs(inputRefs = []) {
  if (!Array.isArray(inputRefs)) return fail('DISPATCH_BINDING_INVALID', 'allowedInputRefs must be an array')
  for (const ref of inputRefs) {
    if (!ref || typeof ref !== 'object' || typeof ref.artifact_id !== 'string' || !H64.test(ref.artifact_id)) {
      return fail('DISPATCH_BINDING_INVALID', 'input ref requires artifact_id sha256')
    }
    if (ref.expected_sha256 !== undefined && (typeof ref.expected_sha256 !== 'string' || !H64.test(ref.expected_sha256))) {
      return fail('DISPATCH_BINDING_INVALID', 'input ref expected_sha256 must be sha256')
    }
    if (ref.relative_path !== undefined && safeLogicalName(ref.relative_path).ok === false) {
      return fail('DISPATCH_BINDING_INVALID', 'input ref relative_path is unsafe')
    }
  }
  return { ok: true, refs: inputRefs.map((x) => ({ ...x })) }
}

function defaultOutputs(op, args) {
  if (op === 'design_stage_artifact' && typeof args?.artifact_type === 'string' && args.artifact_type) {
    return [{ logical_name: args.artifact_type + '.json', artifact_type: args.artifact_type, required: true }]
  }
  return []
}

function normalizeOutputs(outputs, op, args) {
  const source = outputs === undefined ? defaultOutputs(op, args) : outputs
  if (!Array.isArray(source)) return fail('DISPATCH_BINDING_INVALID', 'allowedOutputs must be an array')
  const seen = new Set()
  const clean = []
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') return fail('DISPATCH_BINDING_INVALID', 'output entry must be an object')
    const v = safeLogicalName(entry.logical_name)
    if (!v.ok) return v
    if (typeof entry.artifact_type !== 'string' || !entry.artifact_type) return fail('DISPATCH_BINDING_INVALID', 'output artifact_type required')
    const key = v.name.normalize('NFC').toLocaleLowerCase('en-US')
    if (seen.has(key)) return fail('DUPLICATE_LOGICAL_NAME', v.name)
    seen.add(key)
    clean.push({ logical_name: v.name, artifact_type: entry.artifact_type, required: entry.required !== false })
  }
  return { ok: true, outputs: clean }
}

function dispatchRootFor({ cwd, caseHandle } = {}) {
  if (caseHandle?.caseDir) return join(caseHandle.caseDir, 'dispatches')
  return join(resolve(cwd || process.cwd()), 'result', 'design', '.dispatches')
}

function dispatchPaths({ cwd, caseHandle, dispatchId }) {
  const root = dispatchRootFor({ cwd, caseHandle })
  // Control plane and worker-write plane intentionally have separate roots.
  // A worker receives only `stagingDir`; its immediate parent never contains
  // a dispatch manifest, receipt, or state record.  This is not a claim to
  // sandbox malicious same-user code (outside the v1 threat model), but it
  // prevents supported worker paths from treating `../dispatch.json` as a
  // writable control surface.
  const controlRoot = join(root, 'control')
  const stagingRoot = join(root, 'staging')
  const dir = join(controlRoot, dispatchId)
  return {
    root,
    controlRoot,
    stagingRoot,
    dir,
    stagingDir: join(stagingRoot, dispatchId),
    manifestPath: join(dir, 'dispatch.manifest.json'),
    recordPath: join(dir, 'dispatch.json'),
    receiptPath: join(dir, 'dispatch.receipt.jsonl'),
    consumeLockPath: join(dir, '.consume.lock'),
    // Compatibility primitive mode (used by pre-A3 stage tests) historically
    // publishes to <cwd>/objects/<sha>.json.  Worker staging itself remains in
    // the isolated dispatch domain, so this does not reintroduce A2-GC overlap.
    standaloneObjectsDir: join(resolve(cwd || process.cwd()), 'objects'),
  }
}

function dispatchAnchor({ cwd, caseHandle } = {}) {
  return resolve(caseHandle?.caseDir || cwd || process.cwd())
}

/**
 * Create/check a path one segment at a time.  Recursive mkdir followed by a
 * single final lstat is not enough on Windows: an existing junction above the
 * final segment can divert all later writes.  Dispatch storage is TS-owned,
 * so every ancestor below the case/cwd anchor must be a real directory and
 * must resolve beneath that anchor.
 */
function ensureRealDirectory(anchor, target, { create = false } = {}) {
  const anchorAbs = resolve(anchor)
  const targetAbs = resolve(target)
  if (!isContained(anchorAbs, targetAbs)) return fail('DISPATCH_ROOT_ESCAPE', targetAbs)
  let anchorStat
  try { anchorStat = lstatSync(anchorAbs) } catch (e) { return fail('DISPATCH_ROOT_UNREADABLE', String(e.code || e.message)) }
  if (!anchorStat.isDirectory() || anchorStat.isSymbolicLink()) return fail('DISPATCH_REPARSE_POINT', anchorAbs)
  let anchorReal
  try { anchorReal = realpathSync(anchorAbs) } catch (e) { return fail('DISPATCH_ROOT_UNREADABLE', String(e.code || e.message)) }
  const rel = relative(anchorAbs, targetAbs)
  const parts = rel ? rel.split(/[\\/]+/).filter(Boolean) : []
  let current = anchorAbs
  for (const part of parts) {
    current = join(current, part)
    if (!existsSync(current)) {
      if (!create) return fail('DISPATCH_ROOT_MISSING', current)
      try { mkdirSync(current) } catch (e) { return fail('DISPATCH_ROOT_MKDIR_FAILED', String(e.code || e.message), { path: current }) }
    }
    let st
    try { st = lstatSync(current) } catch (e) { return fail('DISPATCH_ROOT_UNREADABLE', String(e.code || e.message), { path: current }) }
    if (!st.isDirectory() || st.isSymbolicLink()) return fail('DISPATCH_REPARSE_POINT', current)
    let real
    try { real = realpathSync(current) } catch (e) { return fail('DISPATCH_ROOT_UNREADABLE', String(e.code || e.message), { path: current }) }
    if (!isContained(anchorReal, real)) return fail('DISPATCH_ROOT_ESCAPE', real)
  }
  return { ok: true, path: targetAbs, anchor: anchorReal }
}

function ensureDispatchDirectories(paths, context, { create = false } = {}) {
  const anchor = dispatchAnchor(context)
  const root = ensureRealDirectory(anchor, paths.root, { create })
  if (!root.ok) return root
  const control = ensureRealDirectory(paths.root, paths.controlRoot, { create })
  if (!control.ok) return control
  const staging = ensureRealDirectory(paths.root, paths.stagingRoot, { create })
  if (!staging.ok) return staging
  const dir = ensureRealDirectory(paths.controlRoot, paths.dir, { create })
  if (!dir.ok) return dir
  return ensureRealDirectory(paths.stagingRoot, paths.stagingDir, { create })
}

function appendDispatchReceipt(paths, event) {
  appendJsonl(paths.receiptPath, { at: iso(), ...event })
}

function writeDispatchRecord(paths, record, event = null) {
  atomicWriteJson(paths.recordPath, record)
  appendDispatchReceipt(paths, event || { dispatch_id: record.dispatch_id, state: record.state, failure_code: record.failure_code || null })
}

function transitionRecord(paths, record, state, { now = Date.now(), failureCode = null, committedSnapshot = null, note = null } = {}) {
  if (TERMINAL.has(record.state)) return fail('ALREADY_CONSUMED', 'dispatch already terminal', { state: record.state })
  if (state !== 'RESERVED' && !TERMINAL.has(state)) return fail('DISPATCH_STATE_INVALID', state)
  const next = {
    ...record,
    state,
    consumed: TERMINAL.has(state) ? iso(now) : record.consumed,
    committed_snapshot: state === 'COMMITTED' ? committedSnapshot : null,
    failure_code: state === 'FAILED_CONSUMED' ? failureCode || 'DISPATCH_FAILED' : null,
    history: [...(record.history || []), { state, at: iso(now), ...(failureCode ? { failure_code: failureCode } : {}), ...(note ? { note } : {}) }],
  }
  writeDispatchRecord(paths, next, { dispatch_id: next.dispatch_id, state, failure_code: next.failure_code, committed_snapshot: next.committed_snapshot })
  return { ok: true, record: next }
}

export function readDispatchRecord({ cwd, caseHandle, dispatchId, dispatchDir } = {}) {
  const paths = dispatchDir
    ? { ...dispatchPaths({ cwd, caseHandle, dispatchId: basename(dispatchDir) }), dir: dispatchDir, recordPath: join(dispatchDir, 'dispatch.json'), manifestPath: join(dispatchDir, 'dispatch.manifest.json'), receiptPath: join(dispatchDir, 'dispatch.receipt.jsonl'), consumeLockPath: join(dispatchDir, '.consume.lock') }
    : dispatchPaths({ cwd, caseHandle, dispatchId })
  if (!existsSync(paths.recordPath)) return fail('DISPATCH_NOT_FOUND', String(dispatchId || dispatchDir || ''))
  const r = readJson(paths.recordPath, 'DISPATCH_RECORD_UNREADABLE')
  if (!r.ok) return r
  const record = r.value
  if (!record || typeof record !== 'object' || typeof record.dispatch_id !== 'string' || !['ISSUED', 'RESERVED', ...TERMINAL].includes(record.state)) {
    return fail('DISPATCH_RECORD_INVALID')
  }
  return { ok: true, record, paths }
}

function readDispatchManifest(paths, expectedHash) {
  const r = readJson(paths.manifestPath, 'DISPATCH_MANIFEST_UNREADABLE')
  if (!r.ok) return r
  const bytes = readFileSync(paths.manifestPath)
  const hash = sha256hex(bytes)
  if (expectedHash && hash !== expectedHash) return fail('DISPATCH_MANIFEST_TAMPERED', 'manifest hash mismatch')
  const m = r.value
  if (!m || typeof m !== 'object' || !Array.isArray(m.allowed_outputs) || !m.limits || typeof m.dispatch_id !== 'string') {
    return fail('DISPATCH_MANIFEST_INVALID')
  }
  return { ok: true, manifest: m, hash }
}

function readRegularBytes(path, stagingDir, limit) {
  let before
  try { before = lstatSync(path) } catch (e) { return fail('STAGED_UNREADABLE', String(e.code || e.message)) }
  if (before.isSymbolicLink()) return fail('STAGING_REPARSE_POINT', 'symbolic link/reparse point')
  if (!before.isFile()) return fail('STAGING_NONREGULAR', 'candidate is not a regular file')
  if (typeof before.nlink === 'number' && before.nlink > 1) return fail('STAGING_HARDLINK', 'candidate has multiple links')
  if (before.size > limit) return fail('OUTPUT_FILE_TOO_LARGE', String(before.size))
  let fd
  try { fd = openSync(path, 'r') } catch (e) { return fail('STAGED_UNREADABLE', String(e.code || e.message)) }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile()) return fail('STAGING_NONREGULAR', 'opened candidate is not a regular file')
    if (typeof opened.nlink === 'number' && opened.nlink > 1) return fail('STAGING_HARDLINK', 'opened candidate has multiple links')
    if (opened.size > limit) return fail('OUTPUT_FILE_TOO_LARGE', String(opened.size))
    const rootReal = realpathSync(stagingDir)
    const fileReal = realpathSync(path)
    if (!isContained(rootReal, fileReal) || dirname(fileReal) !== rootReal) return fail('STAGING_REPARSE_POINT', 'candidate escapes staging root')
    const bytes = readFileSync(fd)
    const after = lstatSync(path)
    if (after.isSymbolicLink() || !after.isFile() || after.size !== before.size || after.size !== opened.size ||
      (Number.isFinite(before.ino) && Number.isFinite(after.ino) && before.ino !== after.ino) ||
      (Number.isFinite(before.dev) && Number.isFinite(after.dev) && before.dev !== after.dev)) {
      return fail('STAGED_UNREADABLE', 'candidate changed while being read')
    }
    return { ok: true, bytes, sha256: sha256hex(bytes), size: bytes.length }
  } catch (e) {
    return fail('STAGED_UNREADABLE', String(e.code || e.message).slice(0, 160))
  } finally {
    try { closeSync(fd) } catch { /* already closed only on exceptional host behavior */ }
  }
}

/**
 * Stage② frozen c14n check.  JSON.parse is only used to derive annotations;
 * the packet receives the original raw text and therefore remains the
 * authority for lossless duplicate-key/number parsing.
 */
function canonicalCheckViaPacket(artifactType, text) {
  let value
  try {
    value = JSON.parse(text)
  } catch (e) {
    return { ok: false, code: 'STAGED_UNREADABLE', detail: String(e.message).slice(0, 120) }
  }
  // [E3 M0/P0-rework] runtime metadata 拒绝与 casefile canonicalizeViaPacket 同源（单点 denylist）：
  // standalone（无 casefile）dispatch 路径此前不经过该门——在此同口径 fail-closed（写前拒绝）。
  const runtimeHits = scanRuntimeMetadata(value)
  if (runtimeHits.length > 0) {
    return { ok: false, code: 'DETERMINISM_VIOLATION', detail: 'runtime metadata in canonical input: ' + runtimeHits.join(', ') }
  }
  const ann = deriveAnnotationsForArtifact(artifactType, value)
  if (ann === null) return { ok: false, code: 'PACKET_UNVERIFIED', detail: 'annotations derivation failed' }
  const work = mkdtempSync(join(tmpdir(), 'design-c14n-'))
  try {
    const casePath = join(work, 'case.json')
    const outPath = join(work, 'out.json')
    writeFileSync(casePath, JSON.stringify({ cases: [{ id: 'staged', input: text, annotations: ann }] }), 'utf8')
    const r = spawnSync(process.execPath, [join(PACKET_DIR, 'impl', 'c14n.mjs'), '--batch', casePath, '--out', outPath], { encoding: 'utf8', timeout: 120000 })
    if (r.status !== 0) return { ok: false, code: 'C14N_RUNNER_FAILED', detail: String(r.stderr || '').slice(0, 160) }
    const res = JSON.parse(readFileSync(outPath, 'utf8')).results[0]
    if (res.status !== 'accept') return { ok: false, code: res.code || 'C14N_REJECT', detail: String(res.detail || '').slice(0, 160) }
    return { ok: true, canonical: res.canonical }
  } catch (e) {
    return { ok: false, code: 'C14N_OUTPUT_UNREADABLE', detail: String(e.message).slice(0, 120) }
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* temp cleanup is non-authoritative */ }
  }
}

function validateCandidateBytes(artifactType, bytes, displayPath) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) return fail('STAGED_UNREADABLE', 'candidate is not UTF-8')
  const canon = canonicalCheckViaPacket(artifactType, text)
  if (!canon.ok) return fail(canon.code, canon.detail)
  if (canon.canonical !== text) return fail('CANONICAL_BYTES_MISMATCH', 'candidate bytes are not canonical')
  let value
  try { value = JSON.parse(text) } catch (e) { return fail('STAGED_UNREADABLE', String(e.message).slice(0, 120)) }
  const v = validateDesignArtifact(artifactType, value)
  if (!v.ok) return { ok: false, code: (v.errors || [{}])[0].code || 'VALIDATION_FAILED', errors: v.errors || [], path: displayPath }
  return { ok: true, value, canonical: text }
}

function workerReportFor(workerResult, logicalName) {
  if (!workerResult || typeof workerResult !== 'object') return {}
  if (Array.isArray(workerResult.artifacts)) {
    const matches = workerResult.artifacts.filter((x) => x && x.logical_name === logicalName)
    if (matches.length > 1) return { duplicate: true }
    if (matches.length === 1) return matches[0]
  }
  return workerResult
}

/** Safe, side-effect-free stage② scanner.  It never trusts a worker path. */
export function inspectStagingCandidates({ manifest, stagingDir, workerResult = null, now = Date.now() } = {}) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.allowed_outputs) || !manifest.limits) return fail('DISPATCH_MANIFEST_INVALID')
  if (!stagingDir || !existsSync(stagingDir)) return fail('STAGING_MISSING')
  if (Number.isFinite(manifest.expires_at_ms) && now >= manifest.expires_at_ms) return fail('DISPATCH_EXPIRED')
  let root
  try { root = lstatSync(stagingDir) } catch (e) { return fail('STAGING_UNREADABLE', String(e.code || e.message)) }
  if (root.isSymbolicLink() || !root.isDirectory()) return fail('STAGING_REPARSE_POINT', 'staging root must be a real directory')
  const normalized = normalizeOutputs(manifest.allowed_outputs, manifest.operation, {})
  if (!normalized.ok) return normalized
  // Dispatch manifests use snake_case on disk; accept camelCase only for
  // direct unit fixtures so the persistent protocol has one canonical form.
  const limits = {
    maxOutputFiles: manifest.limits.max_files ?? manifest.limits.maxOutputFiles,
    maxOutputFileBytes: manifest.limits.max_file_bytes ?? manifest.limits.maxOutputFileBytes,
    maxOutputTotalBytes: manifest.limits.max_total_bytes ?? manifest.limits.maxOutputTotalBytes,
  }
  if (!Object.values(limits).every((x) => Number.isSafeInteger(x) && x > 0)) return fail('DISPATCH_MANIFEST_INVALID', 'invalid output limits')
  const allowed = new Map(normalized.outputs.map((x) => [x.logical_name.normalize('NFC').toLocaleLowerCase('en-US'), x]))
  let names
  try { names = readdirSync(stagingDir) } catch (e) { return fail('STAGING_UNREADABLE', String(e.code || e.message)) }
  if (names.length > limits.maxOutputFiles) return fail('OUTPUT_FILE_LIMIT', String(names.length))
  const found = new Map()
  let total = 0
  const candidates = []
  for (const name of names) {
    const nameV = safeLogicalName(name)
    if (!nameV.ok) return nameV
    const key = name.normalize('NFC').toLocaleLowerCase('en-US')
    if (found.has(key)) return fail('DUPLICATE_LOGICAL_NAME', name)
    found.set(key, name)
    const output = allowed.get(key)
    if (!output) return fail('UNDECLARED_OUTPUT', name)
    const filePath = join(stagingDir, name)
    const read = readRegularBytes(filePath, stagingDir, limits.maxOutputFileBytes)
    if (!read.ok) return read
    total += read.size
    if (total > limits.maxOutputTotalBytes) return fail('OUTPUT_TOTAL_TOO_LARGE', String(total))
    const report = workerReportFor(workerResult, output.logical_name)
    if (report.duplicate) return fail('DUPLICATE_LOGICAL_NAME', output.logical_name)
    if (report.staged !== undefined && resolve(String(report.staged)) !== resolve(filePath)) {
      return fail('WORKER_PATH_UNTRUSTED', output.logical_name)
    }
    if (report.sha256 !== undefined && report.sha256 !== read.sha256) return fail('WORKER_HASH_MISMATCH', output.logical_name)
    if (report.artifact_type !== undefined && report.artifact_type !== output.artifact_type) return fail('WORKER_ARTIFACT_TYPE_MISMATCH', output.logical_name)
    const semantic = validateCandidateBytes(output.artifact_type, read.bytes, filePath)
    if (!semantic.ok) return semantic
    candidates.push({ ...output, path: filePath, bytes: read.bytes, sha256: read.sha256, size: read.size, value: semantic.value })
  }
  for (const output of normalized.outputs) {
    const key = output.logical_name.normalize('NFC').toLocaleLowerCase('en-US')
    if (output.required && !found.has(key)) return fail('REQUIRED_OUTPUT_MISSING', output.logical_name)
  }
  return { ok: true, candidates, total_bytes: total }
}

/**
 * Compatibility helper kept for existing validation tests.  New dispatches
 * locate candidates through an immutable dispatch manifest instead.
 */
export function verifyStagedCandidate({ stagingFile, expectedSha256, artifactType, objectsDir } = {}) {
  if (!stagingFile || !existsSync(stagingFile)) return { ok: false, errors: [{ code: 'STAGED_MISSING', path: String(stagingFile) }] }
  const parent = dirname(stagingFile)
  const read = readRegularBytes(stagingFile, parent, CASE_LIMITS.maxObjectBytes)
  if (!read.ok) return { ok: false, errors: [{ code: read.code, path: String(stagingFile), detail: read.detail }] }
  if (expectedSha256 && read.sha256 !== expectedSha256) {
    return { ok: false, errors: [{ code: 'STAGED_HASH_MISMATCH', path: String(stagingFile), detail: 'disk=' + read.sha256.slice(0, 16) + ' expected=' + String(expectedSha256).slice(0, 16) }] }
  }
  const semantic = validateCandidateBytes(artifactType, read.bytes, stagingFile)
  if (!semantic.ok) return { ok: false, errors: semantic.errors || [{ code: semantic.code, path: String(stagingFile), detail: semantic.detail }] }
  const dir = objectsDir || join(dirname(stagingFile), '..', '..', 'objects')
  mkdirSync(dir, { recursive: true })
  const objectPath = join(dir, read.sha256 + '.json')
  if (existsSync(objectPath) && !readFileSync(objectPath).equals(read.bytes)) {
    return { ok: false, errors: [{ code: 'OBJECT_HASH_COLLISION', path: objectPath }] }
  }
  if (!existsSync(objectPath)) atomicWriteBytes(objectPath, read.bytes)
  return { ok: true, object_path: objectPath, sha256: read.sha256 }
}

function validateBinding({ op, caseHandle, parentSnapshot, allowedInputRefs, allowedOutputs, limits, ttlMs }) {
  if (!DESIGN_OPS.has(op)) return fail('NOT_A_DESIGN_OP', String(op))
  if (parentSnapshot !== undefined && parentSnapshot !== null && (typeof parentSnapshot !== 'string' || !H64.test(parentSnapshot))) {
    return fail('DISPATCH_BINDING_INVALID', 'parent snapshot must be sha256 or null')
  }
  if (caseHandle !== undefined && caseHandle !== null && (!caseHandle.caseDir || !caseHandle.objectsDir || !caseHandle.snapshotsDir)) {
    return fail('DISPATCH_BINDING_INVALID', 'caseHandle lacks A2 paths')
  }
  const inRefs = normalizeInputRefs(allowedInputRefs || [])
  if (!inRefs.ok) return inRefs
  const outputs = normalizeOutputs(allowedOutputs, op, {})
  if (!outputs.ok) return outputs
  const lim = normalizeLimits(limits, ttlMs)
  if (!lim.ok) return lim
  return { ok: true, inputRefs: inRefs.refs, outputs: outputs.outputs, limits: lim.limits }
}

/** Reserve a new, non-reusable dispatch id and persist ISSUED → RESERVED. */
export function reserveDesignDispatch({ op, args = {}, cwd, caseHandle = null, parentSnapshot = undefined, allowedInputRefs = [], allowedOutputs = undefined, limits = null, ttlMs = undefined, now = Date.now() } = {}) {
  const binding = validateBinding({ op, caseHandle, parentSnapshot, allowedInputRefs, allowedOutputs, limits, ttlMs })
  if (!binding.ok) return binding
  // Default output derivation needs the actual args, after generic validation.
  const outputs = normalizeOutputs(allowedOutputs, op, args)
  if (!outputs.ok) return outputs
  let effectiveParent = parentSnapshot === undefined ? null : parentSnapshot
  if (caseHandle) {
    const head = readHead(caseHandle.caseDir)
    if (!head.ok) return fail('HEAD_UNREADABLE')
    if (parentSnapshot !== undefined && parentSnapshot !== head.snapshot_sha) return fail('PARENT_SNAPSHOT_STALE', 'reservation parent differs from HEAD')
    effectiveParent = head.snapshot_sha
  }
  const dispatchId = randomUUID()
  const paths = dispatchPaths({ cwd, caseHandle, dispatchId })
  // [P0-reparse] 任何写入之前逐段校验/创建 dispatch 存储链（root/control/staging/本次 uuid）：
  // 预置 junction/symlink 在 reserve 即被拒绝，manifest/record/staging 写入不会跟随 reparse。
  const dirs = ensureDispatchDirectories(paths, { cwd, caseHandle }, { create: true })
  if (!dirs.ok) return dirs
  try {
    const created = iso(now)
    const manifest = {
      schema_version: '1.0',
      dispatch_id: dispatchId,
      operation: op,
      case_binding: caseHandle ? { case_dir: caseHandle.caseDir, parent_snapshot: effectiveParent } : { case_dir: null, parent_snapshot: effectiveParent },
      allowed_input_refs: binding.inputRefs,
      allowed_outputs: outputs.outputs,
      limits: {
        max_files: binding.limits.maxOutputFiles,
        max_file_bytes: binding.limits.maxOutputFileBytes,
        max_total_bytes: binding.limits.maxOutputTotalBytes,
      },
      created_at: created,
      expires_at: iso(now + binding.limits.ttlMs),
      expires_at_ms: now + binding.limits.ttlMs,
    }
    atomicWriteJson(paths.manifestPath, manifest)
    const manifestSha = sha256hex(readFileSync(paths.manifestPath))
    const issued = {
      dispatch_id: dispatchId,
      operation: op,
      state: 'ISSUED',
      created,
      consumed: null,
      committed_snapshot: null,
      failure_code: null,
      parent_snapshot: effectiveParent,
      manifest_sha256: manifestSha,
      ttl_ms: binding.limits.ttlMs,
      retention_ms: binding.limits.retentionMs,
      case_dir: caseHandle?.caseDir || null,
      history: [{ state: 'ISSUED', at: created }],
    }
    writeDispatchRecord(paths, issued)
    const reserved = transitionRecord(paths, issued, 'RESERVED', { now })
    if (!reserved.ok) return reserved
    return { ok: true, dispatch_id: dispatchId, paths, manifest, record: reserved.record }
  } catch (e) {
    return fail('DISPATCH_RECORD_WRITE_FAILED', String(e.message).slice(0, 160), { dispatch_id: dispatchId })
  }
}

function consumeLock(paths) {
  try {
    const fd = openSync(paths.consumeLockPath, 'wx')
    try { writeSync(fd, Buffer.from(String(process.pid), 'utf8')); fsyncSync(fd) } finally { closeSync(fd) }
    return { ok: true }
  } catch (e) {
    return fail('ALREADY_CONSUMED', String(e.code || e.message))
  }
}

function releaseConsumeLock(paths) {
  try { unlinkSync(paths.consumeLockPath) } catch { /* terminal record is authoritative */ }
}

function terminalFailure(paths, record, code, { now = Date.now(), detail = null } = {}) {
  // [P0-reparse] 终态写入前复验：以 dir 的真实父目录为 anchor（不依赖 cwd 推导，
  // 兼容 recover 的显式 dispatchDir 场景）——control 父目录或其下 dispatch 目录为 reparse → 拒绝写。
  const chain = ensureRealDirectory(dirname(paths.dir), paths.dir, { create: false })
  if (!chain.ok) return chain
  try {
    const t = transitionRecord(paths, record, 'FAILED_CONSUMED', { now, failureCode: code, note: detail })
    if (!t.ok) return t
    return fail(code, detail, { record: t.record })
  } catch (e) {
    return fail('DISPATCH_RECORD_WRITE_FAILED', String(e.message).slice(0, 160))
  }
}

function legacyPromote(paths, candidates, { cwd } = {}) {
  // [P0-reparse] standalone objects 目录写入前逐段校验（<cwd>/objects 预置 junction 拒绝）。
  const anchor = resolve(cwd || process.cwd())
  const dirs = ensureRealDirectory(anchor, paths.standaloneObjectsDir, { create: true })
  if (!dirs.ok) return dirs
  const objects = []
  try {
    for (const candidate of candidates) {
      const objectPath = join(paths.standaloneObjectsDir, candidate.sha256 + '.json')
      if (existsSync(objectPath) && !readFileSync(objectPath).equals(candidate.bytes)) return fail('OBJECT_HASH_COLLISION', candidate.sha256)
      if (!existsSync(objectPath)) atomicWriteBytes(objectPath, candidate.bytes)
      objects.push({ ...candidate, object_path: objectPath })
    }
    return { ok: true, objects }
  } catch (e) {
    return fail('OBJECT_PROMOTION_FAILED', String(e.message).slice(0, 160))
  }
}

/**
 * Consume candidates exactly once.  This function can be called after a
 * worker return or directly by recovery/negative tests; terminal states never
 * permit a second promotion.
 */
export function consumeDispatchCandidates({ cwd, caseHandle = null, dispatchId, workerResult = null, now = Date.now(), caseContentId = null, policy = null } = {}) {
  const read = readDispatchRecord({ cwd, caseHandle, dispatchId })
  if (!read.ok) return read
  const { paths } = read
  // [P0-reparse] 写前逐段复验存储链：reserve 之后被替换的 reparse 在此拦截（早于 lock/receipt/record 任何写入）。
  const chain = ensureDispatchDirectories(paths, { cwd, caseHandle }, { create: false })
  if (!chain.ok) return chain
  const gotLock = consumeLock(paths)
  if (!gotLock.ok) return gotLock
  try {
    const current = readDispatchRecord({ cwd, caseHandle, dispatchId })
    if (!current.ok) return current
    const record = current.record
    if (record.state === 'COMMITTED') return fail('ALREADY_CONSUMED', 'dispatch already committed', { record })
    if (record.state === 'FAILED_CONSUMED') {
      appendDispatchReceipt(paths, { dispatch_id: dispatchId, state: record.state, late: true, code: 'LATE_WORKER_RESULT' })
      return fail('LATE_WORKER_RESULT', 'terminal failed dispatch cannot consume a late worker result', { record })
    }
    if (record.state !== 'RESERVED') return terminalFailure(paths, record, 'DISPATCH_STATE_INVALID', { now })
    const manifestRead = readDispatchManifest(paths, record.manifest_sha256)
    if (!manifestRead.ok) return terminalFailure(paths, record, manifestRead.code, { now, detail: manifestRead.detail })
    const { manifest } = manifestRead
    if (now >= manifest.expires_at_ms) return terminalFailure(paths, record, 'DISPATCH_EXPIRED', { now })
    if (caseHandle) {
      const head = readHead(caseHandle.caseDir)
      if (!head.ok) return terminalFailure(paths, record, 'HEAD_UNREADABLE', { now })
      if (head.snapshot_sha !== record.parent_snapshot) return terminalFailure(paths, record, 'PARENT_SNAPSHOT_STALE', { now })
      // Bound input refs must resolve inside the parent snapshot: lineage may
      // not cite artifacts the case never recorded.
      if (manifest.allowed_input_refs.length > 0) {
        const snap = loadSnapshot(caseHandle.snapshotsDir, record.parent_snapshot)
        if (!snap.ok) return terminalFailure(paths, record, 'PARENT_SNAPSHOT_UNREADABLE', { now, detail: snap.detail })
        const ids = new Set((snap.manifest.artifacts || []).map((a) => a.artifact_id))
        for (const ref of manifest.allowed_input_refs) {
          if (!ids.has(ref.artifact_id)) return terminalFailure(paths, record, 'INPUT_REF_UNRESOLVED', { now, detail: String(ref.artifact_id).slice(0, 16) })
        }
      }
    }
    const inspected = inspectStagingCandidates({ manifest, stagingDir: paths.stagingDir, workerResult, now })
    if (!inspected.ok) return terminalFailure(paths, record, inspected.code, { now, detail: inspected.detail })
    let committedSnapshot = null
    let objects
    if (caseHandle) {
      const tx = commitTransaction(caseHandle, {
        caseContentId,
        policy,
        expectHead: record.parent_snapshot,
        txid: dispatchId,
        newArtifacts: inspected.candidates.map((c) => ({
          type: c.artifact_type,
          value: c.value,
          producer: manifest.operation,
          inputs: manifest.allowed_input_refs.map((x) => x.artifact_id),
          canonical_path: c.logical_name,
        })),
      })
      if (!tx.ok) return terminalFailure(paths, record, tx.code === 'HEAD_CAS_MISMATCH' ? 'HEAD_CAS_MISMATCH' : tx.code, { now, detail: tx.detail })
      committedSnapshot = tx.snapshot_sha || record.parent_snapshot
      objects = inspected.candidates.map((c) => ({ ...c, object_path: join(caseHandle.objectsDir, c.sha256) }))
    } else {
      const promoted = legacyPromote(paths, inspected.candidates, { cwd })
      if (!promoted.ok) return terminalFailure(paths, record, promoted.code, { now, detail: promoted.detail })
      objects = promoted.objects
    }
    const terminal = transitionRecord(paths, record, 'COMMITTED', { now, committedSnapshot })
    if (!terminal.ok) return terminal
    return { ok: true, record: terminal.record, candidates: objects, committed_snapshot: committedSnapshot }
  } finally {
    releaseConsumeLock(paths)
  }
}

/** Crash-window recovery: the A2 transaction may have committed under this
 *  dispatch id (its receipt carries txid === dispatch_id) while the record
 *  was never terminalized.  In that case the record is restored to
 *  COMMITTED; a HEAD that moved without our txid means the commit never
 *  happened and the dispatch is dead. */
function recoverCommitCrashWindow(current, { now }) {
  const record = current.record
  if (!record.case_dir) return null
  const head = readHead(record.case_dir)
  if (!head.ok) return null // leave to the manifest/expiry path below
  if (head.snapshot_sha === record.parent_snapshot) return null
  const receiptPath = join(record.case_dir, 'run_receipt.jsonl')
  let committed = null
  if (existsSync(receiptPath)) {
    try {
      for (const line of readFileSync(receiptPath, 'utf8').split('\n')) {
        if (!line.includes(record.dispatch_id)) continue
        try {
          const ev = JSON.parse(line)
          if (ev && ev.event === 'committed' && ev.txid === record.dispatch_id) committed = ev
        } catch { /* malformed receipt lines are skipped */ }
      }
    } catch { /* unreadable receipt → fail-closed branch below */ }
  }
  if (committed) {
    const t = transitionRecord(current.paths, record, 'COMMITTED', { now, committedSnapshot: committed.snapshot_sha, note: 'crash-window recovery (committed receipt found)' })
    if (t.ok) return { dispatch_id: record.dispatch_id, code: 'COMMITTED_RECOVERED' }
    return null
  }
  const f = terminalFailure(current.paths, record, 'PARENT_SNAPSHOT_STALE', { now, detail: 'HEAD diverged without a matching committed receipt' })
  return { dispatch_id: record.dispatch_id, code: f.code }
}

/** Scan persisted dispatch records after a process restart. */
export function recoverDispatches({ cwd, caseHandle = null, dispatchRoot = null, now = Date.now() } = {}) {
  const root = dispatchRoot || dispatchRootFor({ cwd, caseHandle })
  const controlRoot = join(root, 'control')
  if (!existsSync(controlRoot)) return { ok: true, recovered: [], kept: [], problems: [] }
  // [P0-reparse] recovery 的读/写同样不得跟随预置 reparse（root/control 链逐段复验）。
  // 显式 dispatchRoot（调用方自定域根）以 root 自身为 anchor：校验 root/control 为真实目录；
  // 默认路径则以 cwd/caseDir 为 anchor 做全链校验。
  const recAnchor = dispatchRoot ? resolve(dispatchRoot) : dispatchAnchor({ cwd, caseHandle })
  const rootCheck = ensureRealDirectory(recAnchor, root, { create: false })
  if (!rootCheck.ok) return { ok: false, recovered: [], kept: [], problems: [rootCheck.code] }
  const controlCheck = ensureRealDirectory(root, controlRoot, { create: false })
  if (!controlCheck.ok) return { ok: false, recovered: [], kept: [], problems: [controlCheck.code] }
  const recovered = []; const kept = []; const problems = []
  for (const entry of readdirSync(controlRoot)) {
    const dir = join(controlRoot, entry)
    let st
    try { st = lstatSync(dir) } catch { continue }
    if (!st.isDirectory() || st.isSymbolicLink()) { problems.push(entry + ':unsafe'); continue }
    const r = readDispatchRecord({ cwd, caseHandle, dispatchId: entry, dispatchDir: dir })
    if (!r.ok) { problems.push(entry + ':' + r.code); continue }
    if (TERMINAL.has(r.record.state)) { kept.push(entry); continue }
    // Recovery must share the exact consume serialization boundary.  A live
    // worker may be between inspection and A2's HEAD CAS; without this lock
    // recovery could mark FAILED_CONSUMED while that worker still commits.
    const locked = consumeLock(r.paths)
    if (!locked.ok) { kept.push(entry); continue }
    try {
      const current = readDispatchRecord({ cwd, caseHandle, dispatchId: entry, dispatchDir: dir })
      if (!current.ok) { problems.push(entry + ':' + current.code); continue }
      if (TERMINAL.has(current.record.state)) { kept.push(entry); continue }
      const crash = recoverCommitCrashWindow(current, { now })
      if (crash) { recovered.push(crash); continue }
      const currentManifest = readDispatchManifest(current.paths, current.record.manifest_sha256)
      if (!currentManifest.ok) {
        const f = terminalFailure(current.paths, current.record, currentManifest.code, { now })
        recovered.push({ dispatch_id: entry, code: f.code })
      } else if (now >= currentManifest.manifest.expires_at_ms) {
        const f = terminalFailure(current.paths, current.record, 'DISPATCH_EXPIRED_RECOVERED', { now })
        recovered.push({ dispatch_id: entry, code: f.code })
      } else kept.push(entry)
    } finally {
      releaseConsumeLock(r.paths)
    }
  }
  return { ok: problems.length === 0, recovered, kept, problems }
}

/** Dispatch-domain GC.  RESERVED is always a root; only aged terminals go.
 *  The control and staging domains are scanned separately so the worker
 *  staging twin is reclaimed together with its record, and foreign entries
 *  directly under the dispatch root are never touched. */
export function gcDispatches({ cwd, caseHandle = null, dispatchRoot = null, now = Date.now(), dryRun = false } = {}) {
  const root = dispatchRoot || dispatchRootFor({ cwd, caseHandle })
  const recovery = recoverDispatches({ cwd, caseHandle, dispatchRoot: root, now })
  if (!existsSync(root)) return { ok: recovery.ok, removed: [], kept: [], recovery }
  // [P0-reparse] 删除前复验（预置 reparse → fail-closed，不做任何删除；不存在的子域不触发）。
  // 显式 dispatchRoot 以 root 自身为 anchor；默认路径以 cwd/caseDir 为 anchor。
  const gcAnchor = dispatchRoot ? resolve(dispatchRoot) : dispatchAnchor({ cwd, caseHandle })
  const chainRoot = ensureRealDirectory(gcAnchor, root, { create: false })
  if (!chainRoot.ok) return { ok: false, removed: [], kept: [], recovery }
  for (const sub of ['control', 'staging']) {
    const subPath = join(root, sub)
    if (!existsSync(subPath)) continue
    const subCheck = ensureRealDirectory(root, subPath, { create: false })
    if (!subCheck.ok) return { ok: false, removed: [], kept: [], recovery }
  }
  const removed = []; const kept = []
  const controlRoot = join(root, 'control')
  const stagingRoot = join(root, 'staging')
  if (existsSync(controlRoot)) {
    for (const entry of readdirSync(controlRoot)) {
      const dir = join(controlRoot, entry)
      // Do not follow/delete untrusted reparse entries even after recovery
      // reported them.  Dispatch GC owns only real directories it created.
      let st
      try { st = lstatSync(dir) } catch { kept.push(entry); continue }
      if (!st.isDirectory() || st.isSymbolicLink()) { kept.push(entry); continue }
      const r = readDispatchRecord({ cwd, caseHandle, dispatchId: entry, dispatchDir: dir })
      if (!r.ok || !TERMINAL.has(r.record.state)) { kept.push(entry); continue }
      const consumedAt = Date.parse(r.record.consumed || r.record.created || '')
      const retention = Number.isSafeInteger(r.record.retention_ms) ? r.record.retention_ms : DISPATCH_LIMITS.retentionMs
      if (!Number.isFinite(consumedAt) || now < consumedAt + retention) { kept.push(entry); continue }
      if (!dryRun) {
        rmSync(dir, { recursive: true, force: true })
        // Reclaim the worker staging twin only when it resolves to a real
        // directory; foreign reparse entries are never followed.
        try {
          const sd = join(stagingRoot, entry)
          const ss = lstatSync(sd)
          if (ss.isDirectory() && !ss.isSymbolicLink()) rmSync(sd, { recursive: true, force: true })
        } catch { /* staging twin absent or unsafe — leave it */ }
      }
      removed.push(entry)
    }
  }
  // Entries directly under the dispatch root that are not the control or
  // staging domains are foreign and are never touched.
  for (const entry of readdirSync(root)) {
    if (entry === 'objects' || entry === 'control' || entry === 'staging') continue
    kept.push(entry)
  }
  return { ok: recovery.ok, removed, kept, recovery }
}

/**
 * Public compatibility entrypoint.  It performs gate → reservation → worker
 * spawn → TS-only candidate consumption, while preserving the v4 return keys
 * used by design-validation/containment tests.
 */
export async function dispatchDesignOp(pythonPath, op, args = {}, {
  cwd,
  timeoutMs = 300_000,
  signal,
  caseHandle = null,
  parentSnapshot = undefined,
  allowedInputRefs = [],
  allowedOutputs = undefined,
  limits = null,
  ttlMs = undefined,
  caseContentId = null,
  policy = null,
  now = Date.now(),
} = {}) {
  if (!DESIGN_OPS.has(op)) return fail('NOT_A_DESIGN_OP', `不是 design op：${op}（本通道仅接受 DESIGN_OPS 集合）`)
  // Gate must precede reservation, cache, registry, or worker spawn.
  const gate = verifyDesignPacket()
  if (!gate.ok) return fail(gate.code, `design gate 拒绝：${gate.detail}`)
  const reserved = reserveDesignDispatch({ op, args, cwd, caseHandle, parentSnapshot, allowedInputRefs, allowedOutputs, limits, ttlMs, now })
  if (!reserved.ok) return reserved
  const { dispatch_id: dispatchId, paths } = reserved
  const res = await spawnPython(pythonPath, OPS_PATH, { op, args }, {
    cwd,
    timeoutMs,
    signal,
    env: {
      DSH_DESIGN_STAGING: paths.stagingDir,
      DSH_DESIGN_DISPATCH_ID: dispatchId,
      DSH_DESIGN_PACKET: '',
      DSH_DESIGN_PACKET_FIXED: PACKET_DIR,
      DSH_DESIGN_EXPECT_INDEX_SHA: gate.index_sha256 || '',
      DSH_DESIGN_EXPECT_MANIFEST_SHA: gate.manifest_sha256 || '',
      DSH_DESIGN_ACCEPTANCE_ID: gate.acceptance_id || '',
    },
  })
  let consumed = null
  if (res.timedOut) {
    const r = readDispatchRecord({ cwd, caseHandle, dispatchId })
    if (r.ok && r.record.state === 'RESERVED') {
      const terminal = terminalFailure(r.paths, r.record, 'WORKER_TIMEOUT', { now: Date.now() })
      consumed = terminal
    } else consumed = r.ok ? fail('ALREADY_CONSUMED') : r
  } else if (!res.ok) {
    const r = readDispatchRecord({ cwd, caseHandle, dispatchId })
    consumed = r.ok && r.record.state === 'RESERVED'
      ? terminalFailure(r.paths, r.record,
        res.code === 'ABORTED' ? 'WORKER_ABORTED' : (res.exitCode === 0 ? 'WORKER_REJECTED' : 'WORKER_CRASH'),
        { now: Date.now(), detail: res.error || res.stderr })
      : fail('WORKER_CRASH')
  } else {
    consumed = consumeDispatchCandidates({ cwd, caseHandle, dispatchId, workerResult: res.result || null, now: Date.now(), caseContentId, policy })
  }
  const committed = consumed?.ok && consumed.candidates?.length === 1
    ? { ok: true, object_path: consumed.candidates[0].object_path, sha256: consumed.candidates[0].sha256 }
    : (consumed?.ok ? { ok: true, objects: consumed.candidates || [] } : null)
  return {
    ...res,
    ok: Boolean(res.ok && consumed?.ok),
    dispatch_id: dispatchId,
    staging_dir: paths.stagingDir,
    committed,
    dispatch: consumed?.record || null,
    ...(consumed?.ok ? {} : { dispatch_failure: consumed?.code || 'DISPATCH_FAILED' }),
  }
}
