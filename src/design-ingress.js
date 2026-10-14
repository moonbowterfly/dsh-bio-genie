/**
 * dsh-bio-genie — design case ingress (A4 / S0).
 *
 * This module deliberately does not write into a case.  It turns an external
 * regular file (or bounded caller-supplied bytes) into a re-read, hashed and
 * schema-validated input_snapshot@1 proposal.  A later TS-only transaction is
 * the sole authority allowed to add that proposal to a scientific snapshot.
 *
 * @module dsh-bio-genie/design-ingress
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, parse, relative, resolve, win32 } from 'node:path'
import { CASE_LIMITS, canonicalizeViaPacket } from './design-casefile.js'
import { deriveAnnotationsForArtifact, validateDesignArtifact } from './design-validate.js'

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])
const ROLES = new Set([
  'genome_sequence', 'genome_annotation', 'condition', 'parts_evidence', 'sbol',
  'cassette', 'gem_model', 'gem_card', 'coupling_assumption', 'other',
])

/** v1 keeps S0 materially below the case object limit to bound heap use. */
export const INGRESS_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
})

const EXTENSION_HINTS = Object.freeze({
  '.fa': 'fasta', '.fasta': 'fasta', '.fna': 'fasta', '.faa': 'fasta', '.fas': 'fasta',
  '.gff': 'gff3', '.gff3': 'gff3',
  '.gb': 'genbank', '.gbk': 'genbank', '.genbank': 'genbank',
  '.sbml': 'sbml',
  '.json': 'json',
  '.zip': 'zip',
  '.txt': 'text', '.text': 'text', '.md': 'text',
})

const FORMAT_INFO = Object.freeze({
  fasta: { media_type: 'text/x-fasta' },
  gff3: { media_type: 'text/x-gff3' },
  genbank: { media_type: 'application/x-genbank' },
  sbml: { media_type: 'application/sbml+xml' },
  json: { media_type: 'application/json' },
  zip: { media_type: 'application/zip' },
  text: { media_type: 'text/plain; charset=utf-8' },
  other: { media_type: 'application/octet-stream' },
})

function fail(code, detail = null, extra = {}) {
  return { ok: false, code, ...(detail ? { detail } : {}), ...extra }
}

function sha256hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function contained(root, target) {
  const r = relative(resolve(root), resolve(target))
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

function isWindowsCaseAlias(requested) {
  // On Windows an alternate spelling can name the same object.  A1 returns
  // canonical real paths, so an ingress handle must not quietly reintroduce a
  // different-casing alias.  Other platforms retain normal case sensitivity.
  if (process.platform !== 'win32') return false
  const absolute = resolve(requested)
  const parent = dirname(absolute)
  const leaf = basename(absolute)
  try {
    return readdirSync(parent).some((entry) => entry !== leaf && entry.toLowerCase() === leaf.toLowerCase())
  } catch {
    return true // cannot prove alias safety → fail closed in the caller
  }
}

function normalizeLimit(limits = {}) {
  const supplied = limits == null ? {} : limits
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) return fail('INGRESS_LIMIT_INVALID', 'limits must be an object')
  const maxBytes = supplied.maxBytes ?? INGRESS_LIMITS.maxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > INGRESS_LIMITS.maxBytes || maxBytes > CASE_LIMITS.maxObjectBytes) {
    return fail('INGRESS_LIMIT_INVALID', 'maxBytes must be a non-negative safe integer that only tightens v1')
  }
  return { ok: true, maxBytes }
}

/** Reject Windows network/namespace/device spellings before resolve/open. */
function validateExternalPath(sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath) return fail('INGRESS_PATH_INVALID', 'path must be a nonempty string')
  if (/[\u0000-\u001f]/.test(sourcePath)) return fail('INGRESS_PATH_INVALID', 'control character')
  const win = sourcePath.replace(/\//g, '\\')
  if (/^\\\\\.\\pipe\\/i.test(win)) return fail('INGRESS_PIPE', 'named pipe path')
  if (/^\\\\[?.]\\/.test(win)) return fail('INGRESS_WINDOWS_NAMESPACE', 'extended/device namespace')
  if (/^\\\\/.test(win)) return fail('INGRESS_UNC_PATH', 'UNC path')
  if (/^[A-Za-z]:[^\\/]/.test(sourcePath)) return fail('INGRESS_DRIVE_RELATIVE', 'drive-relative path')
  const pieces = win.replace(/^[A-Za-z]:/, '').split(/\\+/).filter(Boolean)
  for (const piece of pieces) {
    // Alternate data streams and device suffixes are Windows path syntax, not
    // an acceptable scientific filename.  Reject before any lstat/open.
    if (piece.includes(':')) return fail('INGRESS_DEVICE_PATH', piece)
    const trimmed = piece.replace(/[. ]+$/, '')
    // Win32 ignores trailing dots/spaces in every component, including the
    // base immediately before an extension (for example `COM1 .json`).
    const base = trimmed.split('.')[0].replace(/[. ]+$/, '').toUpperCase()
    if (WINDOWS_RESERVED.has(base)) return fail('INGRESS_DEVICE_PATH', piece)
  }
  return { ok: true }
}

function sameIdentity(a, b) {
  if (!a || !b || a.size !== b.size) return false
  if (Number.isFinite(a.dev) && Number.isFinite(b.dev) && a.dev !== b.dev) return false
  if (Number.isFinite(a.ino) && Number.isFinite(b.ino) && a.ino !== b.ino) return false
  return true
}

/**
 * A final-component lstat does not reveal a junction in an ancestor on
 * Windows.  Walk the already-resolved ancestor chain before opening so a
 * `junction/file.fa` source cannot turn a reparse escape into a normal file.
 * This is intentionally source-side safety, not case-root containment: an
 * external source may legitimately live outside the workdir.
 */
function assertNoReparseAncestors(sourcePath) {
  let absolute
  try { absolute = resolve(sourcePath) } catch (e) { return fail('INGRESS_PATH_INVALID', String(e.message).slice(0, 160)) }
  const root = parse(absolute).root
  const ancestors = []
  for (let current = dirname(absolute); current && current !== root; current = dirname(current)) ancestors.push(current)
  ancestors.reverse()
  for (const ancestor of ancestors) {
    let st
    try { st = lstatSync(ancestor) } catch (e) { return fail('INGRESS_UNREADABLE', String(e.code || e.message)) }
    if (st.isSymbolicLink()) return fail('INGRESS_REPARSE_POINT', 'ancestor reparse point')
    if (!st.isDirectory()) return fail('INGRESS_PATH_INVALID', 'non-directory path ancestor')
  }
  return { ok: true }
}

/**
 * Reads at most maxBytes + 1 from the exact handle whose metadata was
 * validated.  An oversize source is rejected from fstat before any content
 * read; a racing growth is rejected after a bounded read and a same-handle
 * fstat/lstat identity recheck.
 */
function readExternalRegularFile(sourcePath, maxBytes) {
  const lexical = validateExternalPath(sourcePath)
  if (!lexical.ok) return lexical
  const ancestorOk = assertNoReparseAncestors(sourcePath)
  if (!ancestorOk.ok) return ancestorOk
  let before
  try { before = lstatSync(sourcePath) } catch (e) { return fail('INGRESS_UNREADABLE', String(e.code || e.message)) }
  if (before.isSymbolicLink()) return fail('INGRESS_REPARSE_POINT', 'symlink/junction/reparse source')
  if (before.isDirectory()) return fail('INGRESS_DIRECTORY', 'source is a directory')
  if (typeof before.isFIFO === 'function' && before.isFIFO()) return fail('INGRESS_PIPE', 'source is a pipe')
  if (!before.isFile()) return fail('INGRESS_NOT_REGULAR', 'source is not a regular file')
  if (typeof before.nlink === 'number' && before.nlink > 1) return fail('INGRESS_HARDLINK', 'source has multiple links')
  if (before.size > maxBytes) return fail('INGRESS_SIZE_LIMIT', String(before.size), { max_bytes: maxBytes })
  let fd
  try { fd = openSync(sourcePath, 'r') } catch (e) { return fail('INGRESS_UNREADABLE', String(e.code || e.message)) }
  try {
    const opened = fstatSync(fd)
    if (typeof opened.isFIFO === 'function' && opened.isFIFO()) return fail('INGRESS_PIPE', 'opened source is a pipe')
    if (!opened.isFile()) return fail('INGRESS_NOT_REGULAR', 'opened source is not a regular file')
    if (typeof opened.nlink === 'number' && opened.nlink > 1) return fail('INGRESS_HARDLINK', 'opened source has multiple links')
    if (opened.size > maxBytes) return fail('INGRESS_SIZE_LIMIT', String(opened.size), { max_bytes: maxBytes })
    if (!sameIdentity(before, opened)) return fail('INGRESS_RACE_DETECTED', 'source changed before handle validation')
    // Allocate a bounded sentinel byte so a source that grows during reading
    // cannot make this process consume an unbounded stream.
    const capacity = Math.min(maxBytes + 1, opened.size + 1)
    const buffer = Buffer.allocUnsafe(capacity)
    let offset = 0
    while (offset < capacity) {
      const n = readSync(fd, buffer, offset, capacity - offset, null)
      if (n === 0) break
      offset += n
    }
    if (offset > maxBytes) return fail('INGRESS_SIZE_LIMIT', String(offset), { max_bytes: maxBytes })
    const afterHandle = fstatSync(fd)
    let afterPath
    try { afterPath = lstatSync(sourcePath) } catch (e) { return fail('INGRESS_RACE_DETECTED', String(e.code || e.message)) }
    if (afterPath.isSymbolicLink() || afterPath.isDirectory() || !afterPath.isFile() || !sameIdentity(before, afterHandle) || !sameIdentity(before, afterPath)) {
      return fail('INGRESS_RACE_DETECTED', 'source changed while being read')
    }
    const bytes = Buffer.from(buffer.subarray(0, offset))
    return { ok: true, bytes, sha256: sha256hex(bytes), byte_size: bytes.length }
  } catch (e) {
    return fail('INGRESS_UNREADABLE', String(e.code || e.message).slice(0, 160))
  } finally {
    try { closeSync(fd) } catch { /* already closed only on abnormal host behavior */ }
  }
}

function decodeUtf8(bytes) {
  try {
    // JSON classification needs a complete document, not merely a prefix. The
    // input is already bounded by INGRESS_LIMITS before this allocation.
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { ok: false, text: null }
  }
}

function extensionHint(sourceName = '') {
  const e = extname(String(sourceName)).toLowerCase() || win32.extname(String(sourceName)).toLowerCase()
  return EXTENSION_HINTS[e] || null
}

/** Content-first parser dispatch. SBOL XML intentionally maps to schema
 * format=text because input_snapshot@1 has no sbol enum member. */
export function classifyIngressBytes(bytes, { sourceName = '' } = {}) {
  const b = Buffer.from(bytes)
  const hint = extensionHint(sourceName)
  const zip = b.length >= 4 && (b.subarray(0, 4).equals(Buffer.from('PK\x03\x04')) || b.subarray(0, 4).equals(Buffer.from('PK\x05\x06')) || b.subarray(0, 4).equals(Buffer.from('PK\x07\x08')))
  let detected = null
  if (zip) {
    detected = { format: 'zip', detected_kind: 'zip' }
  } else {
    const decoded = decodeUtf8(b)
    if (!decoded.ok) {
      detected = { format: 'other', detected_kind: 'binary' }
    } else {
      const text = decoded.text.replace(/^\uFEFF/, '')
      if (text.includes('\u0000')) {
        detected = { format: 'other', detected_kind: 'binary_nul' }
      } else {
        const lead = text.trimStart()
        const gffFeature = lead.split(/\r?\n/).find((line) => line && !line.startsWith('#'))
        if (/^>[^\r\n]+/.test(lead)) detected = { format: 'fasta', detected_kind: 'fasta' }
        else if (/^##gff-version\s+3\b/i.test(lead) && typeof gffFeature === 'string' && gffFeature.split('\t').length === 9) detected = { format: 'gff3', detected_kind: 'gff3' }
        else if (/^LOCUS\s+/i.test(lead) && /(?:^|\r?\n)FEATURES\b/im.test(lead) && /(?:^|\r?\n)ORIGIN\b/im.test(lead)) detected = { format: 'genbank', detected_kind: 'genbank' }
        else if (/^(?:<\?xml[^>]*>\s*)?<sbml\b/i.test(lead)) detected = { format: 'sbml', detected_kind: 'sbml' }
        else if (lead.startsWith('{') || lead.startsWith('[')) {
          try {
            JSON.parse(lead)
            detected = /sbols\.org\/v[23]|"sbolVersion"|"sbol_version"/i.test(lead)
              ? { format: 'json', detected_kind: 'sbol_json' }
              : { format: 'json', detected_kind: 'json' }
          } catch { /* malformed JSON falls through to ordinary text */ }
        }
        else if (/^(?:<\?xml[^>]*>\s*)?</i.test(lead) && (/<(?:sbol:|[^>]*\bsbol[^>]*)/i.test(lead) || /sbols\.org\/v[23]/i.test(lead))) detected = { format: 'text', detected_kind: 'sbol_xml' }
        if (!detected) detected = { format: text.length ? 'text' : 'other', detected_kind: text.length ? 'text' : 'empty' }
      }
    }
  }
  // Known biological/data extensions are only a cross-check.  They never
  // manufacture a typed classification for arbitrary text.  Generic .txt is
  // deliberately neutral, so a valid FASTA saved as sample.txt remains FASTA.
  if (hint && hint !== 'text' && hint !== detected.format) {
    return fail('INGRESS_FORMAT_CONFLICT', `extension=${hint}, content=${detected.format}`)
  }
  return { ok: true, ...detected, hint }
}

function consumersFor(role, classification) {
  if (classification.detected_kind === 'sbol_xml' || classification.detected_kind === 'sbol_json') return ['bio_circuit_contextualize', 'bio_sbol_read']
  if (role === 'genome_sequence') return ['bio_chassis_profile']
  if (role === 'genome_annotation') return ['bio_chassis_profile', 'bio_integration_candidates']
  if (role === 'cassette') return ['bio_circuit_contextualize', 'bio_integration_candidates']
  if (role === 'gem_model' || role === 'gem_card' || role === 'coupling_assumption') return ['bio_design_consequence']
  if (role === 'condition') return classification.format === 'json' || classification.format === 'text' ? ['bio_chassis_profile'] : []
  if (role === 'parts_evidence') return classification.format === 'json' || classification.format === 'text' ? ['bio_chassis_profile', 'bio_circuit_contextualize'] : []
  return []
}

function roleAllows(role, classification) {
  const f = classification.format
  if (role === 'other') return true
  if (role === 'genome_sequence') return f === 'fasta' || f === 'genbank'
  if (role === 'genome_annotation') return f === 'gff3' || f === 'genbank'
  if (role === 'condition' || role === 'parts_evidence') return f === 'json' || f === 'text'
  if (role === 'sbol') return classification.detected_kind === 'sbol_xml' || classification.detected_kind === 'sbol_json'
  if (role === 'cassette') return f === 'fasta' || f === 'genbank' || classification.detected_kind === 'sbol_xml' || classification.detected_kind === 'sbol_json'
  if (role === 'gem_model') return f === 'sbml'
  if (role === 'gem_card' || role === 'coupling_assumption') return f === 'json'
  return false
}

function validateCaseHandle(caseHandle) {
  if (caseHandle == null) return { ok: true }
  if (!caseHandle || typeof caseHandle !== 'object' || typeof caseHandle.caseDir !== 'string' || typeof caseHandle.objectsDir !== 'string' || typeof caseHandle.snapshotsDir !== 'string') {
    return fail('INGRESS_CASE_HANDLE_INVALID')
  }
  for (const p of [caseHandle.caseDir, caseHandle.objectsDir, caseHandle.snapshotsDir]) {
    const lexical = validateExternalPath(p)
    if (!lexical.ok) return fail('INGRESS_CASE_HANDLE_UNSAFE', lexical.code)
  }
  let caseStat
  try { caseStat = lstatSync(caseHandle.caseDir) } catch (e) { return fail('INGRESS_CASE_HANDLE_INVALID', String(e.code || e.message)) }
  if (!caseStat.isDirectory() || caseStat.isSymbolicLink()) return fail('INGRESS_CASE_HANDLE_UNSAFE', caseHandle.caseDir)
  const ancestors = assertNoReparseAncestors(caseHandle.caseDir)
  if (!ancestors.ok) return fail('INGRESS_CASE_HANDLE_UNSAFE', ancestors.code)
  let caseReal
  try { caseReal = realpathSync(caseHandle.caseDir) } catch (e) { return fail('INGRESS_CASE_HANDLE_UNSAFE', String(e.code || e.message)) }
  if (isWindowsCaseAlias(caseHandle.caseDir)) return fail('INGRESS_CASE_ALIAS_CONFLICT', caseHandle.caseDir)
  const expected = [resolve(caseHandle.caseDir, 'objects'), resolve(caseHandle.caseDir, 'snapshots')]
  if (resolve(caseHandle.objectsDir) !== expected[0] || resolve(caseHandle.snapshotsDir) !== expected[1]) return fail('INGRESS_CASE_TARGET_ESCAPE', 'case handle shape')
  for (const p of [caseHandle.objectsDir, caseHandle.snapshotsDir]) {
    if (!contained(caseReal, p) || !existsSync(p)) return fail('INGRESS_CASE_TARGET_ESCAPE', p)
    let st; let real
    try { st = lstatSync(p); real = realpathSync(p) } catch (e) { return fail('INGRESS_CASE_HANDLE_UNSAFE', String(e.code || e.message)) }
    if (!st.isDirectory() || st.isSymbolicLink() || !contained(caseReal, real)) return fail('INGRESS_CASE_TARGET_ESCAPE', p)
    if (isWindowsCaseAlias(p)) return fail('INGRESS_CASE_ALIAS_CONFLICT', p)
  }
  return { ok: true }
}

function buildInventory(bytes, { role, originKind, originRef, sourceName = '', caseHandle = null } = {}) {
  if (!ROLES.has(role)) return fail('INGRESS_ROLE_INVALID', String(role))
  if (originKind !== 'external' && originKind !== 'ingest_produced') return fail('INGRESS_ORIGIN_INVALID', String(originKind))
  if (originRef !== undefined && (typeof originRef !== 'string' || originRef.length > 512 || /[\u0000-\u001f]/.test(originRef))) return fail('INGRESS_ORIGIN_REF_INVALID')
  if (originKind === 'ingest_produced' && (typeof originRef !== 'string' || originRef.trim().length === 0)) return fail('INGRESS_ORIGIN_REF_REQUIRED', 'produced artifact requires origin_ref')
  const caseOk = validateCaseHandle(caseHandle)
  if (!caseOk.ok) return caseOk
  const classification = classifyIngressBytes(bytes, { sourceName })
  if (!classification.ok) return classification
  if (!roleAllows(role, classification)) return fail('INGRESS_ROLE_FORMAT_MISMATCH', `${role}:${classification.format}`)
  const info = FORMAT_INFO[classification.format]
  const inventory = {
    artifact_type: 'input_snapshot@1',
    role,
    media_type: classification.detected_kind === 'sbol_xml' ? 'application/rdf+xml' : info.media_type,
    format: classification.format,
    consumer_compatibility: consumersFor(role, classification),
    sha256: sha256hex(bytes),
    byte_size: bytes.length,
    origin: { kind: originKind, ...(originRef ? { origin_ref: originRef } : {}) },
  }
  const checked = validateDesignArtifact('input_snapshot', inventory)
  if (!checked.ok) return { ok: false, code: 'INGRESS_INVENTORY_INVALID', errors: checked.errors || [] }
  const annotations = deriveAnnotationsForArtifact('input_snapshot', inventory)
  if (annotations === null) return fail('INGRESS_PACKET_UNVERIFIED')
  const canonical = canonicalizeViaPacket(JSON.stringify(inventory), annotations)
  if (!canonical.ok) return fail('INGRESS_INVENTORY_CANONICAL_INVALID', canonical.code)
  let canonicalInventory
  try { canonicalInventory = JSON.parse(canonical.canonical) } catch { return fail('INGRESS_INVENTORY_CANONICAL_INVALID', 'canonical JSON parse') }
  return {
    ok: true,
    // Return the normalized/canonical object, not the pre-c14n construction,
    // so downstream B1 sees exactly the record whose bytes were checked.
    inventory: canonicalInventory,
    inventory_canonical: canonical.canonical,
    inventory_sha256: sha256hex(Buffer.from(canonical.canonical, 'utf8')),
    classification,
  }
}

/** Ingest a bounded caller-owned byte sequence through the same inventory gate. */
export function ingestBytes(bytes, { role, originKind = 'external', originRef, sourceName = '', limits = null, caseHandle = null } = {}) {
  const l = normalizeLimit(limits)
  if (!l.ok) return l
  const caseOk = validateCaseHandle(caseHandle)
  if (!caseOk.ok) return caseOk
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) return fail('INGRESS_BYTES_INVALID', 'bytes must be Buffer or Uint8Array')
  if (bytes.byteLength > l.maxBytes) return fail('INGRESS_SIZE_LIMIT', String(bytes.byteLength), { max_bytes: l.maxBytes })
  const owned = Buffer.from(bytes)
  const built = buildInventory(owned, { role, originKind, originRef, sourceName, caseHandle })
  return built.ok ? { ...built, bytes: owned, sha256: sha256hex(owned), byte_size: owned.length } : built
}

/** External source ingress: lexical path gate → one-handle bounded read → inventory. */
export function ingestExternalInput(sourcePath, { role, originRef, limits = null, caseHandle = null } = {}) {
  const l = normalizeLimit(limits)
  if (!l.ok) return l
  const caseOk = validateCaseHandle(caseHandle)
  if (!caseOk.ok) return caseOk
  const read = readExternalRegularFile(sourcePath, l.maxBytes)
  if (!read.ok) return read
  const built = buildInventory(read.bytes, { role, originKind: 'external', originRef, sourceName: basename(sourcePath), caseHandle })
  return built.ok ? { ...built, bytes: read.bytes, sha256: read.sha256, byte_size: read.byte_size } : built
}

/**
 * Existing tool / bio_python output ingress.  It intentionally uses the exact
 * same path reader and classification gate as an external file; `origin_ref`
 * is provenance only, never a trust upgrade.
 */
export function ingestProducedArtifact(sourcePath, { role, originRef, limits = null, caseHandle = null } = {}) {
  if (typeof originRef !== 'string' || !originRef) return fail('INGRESS_ORIGIN_REF_REQUIRED', 'produced artifact requires origin_ref')
  const l = normalizeLimit(limits)
  if (!l.ok) return l
  const caseOk = validateCaseHandle(caseHandle)
  if (!caseOk.ok) return caseOk
  const read = readExternalRegularFile(sourcePath, l.maxBytes)
  if (!read.ok) return read
  const built = buildInventory(read.bytes, { role, originKind: 'ingest_produced', originRef, sourceName: basename(sourcePath), caseHandle })
  return built.ok ? { ...built, bytes: read.bytes, sha256: read.sha256, byte_size: read.byte_size } : built
}

