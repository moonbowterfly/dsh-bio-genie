/**
 * dsh-bio-genie — casefile 目录与身份（A1）
 *
 * 不变量：
 *   1. case 根 `<workdir>/result/design/<case_instance_id>/` 由 TS 唯一创建；case_instance_id
 *      必须是单段安全名（拒绝绝对/盘符相对/`..`/UNC/保留设备名/尾点尾空格/控制符/分隔符）；
 *      创建与打开前做 realpath containment + reparse 检查（junction/symlink 拒绝）。
 *   2. case_content_id 由 root input artifact IDs + policy version + canonical 参数派生
 *      （经冻结 c14n 的 canonical bytes → sha256）；case_instance_id 仅目录/receipt 用，
 *      不得进入 canonical bytes。
 *   3. snapshot_sha = sha256(canonical(manifest_without_snapshot_sha))（冻结 c14n）；
 *      同名快照文件非逐字节相同 → SNAPSHOT_HASH_COLLISION（拒绝）。
 *   4. 快照/HEAD 写入 = 原子（tmp + fsync + rename）；receipt = append-only JSONL + fsync；
 *      HEAD 替换支持 CAS（expect 不符 → HEAD_CAS_MISMATCH，HEAD 不变）。
 * @module dsh-bio-genie/design-casefile
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { PACKET_DIR } from './design-gate.js'
import { deriveAnnotationsForArtifact, validateDesignArtifact } from './design-validate.js'
import { loadCapabilityPolicy, resolveOperation } from './design-capability.js'

const C14N_IMPL = join(PACKET_DIR, 'impl', 'c14n.mjs')
const MAX_INSTANCE_ID = 128
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

function sha256hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function isContained(rootReal, targetReal) {
  const rel = relative(rootReal, targetReal)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 键序不敏感的 JSON 深比较（canonical 相等语义的最小充分实现）。快照经 c14n
 *  序列化读回后对象键被重排，直接 JSON.stringify 比较会把同义 policy 误判为
 *  POLICY_MISMATCH（键序差异是合法输入，不是内容差异）。 */
function jsonDeepEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!jsonDeepEqual(a[i], b[i])) return false
    return true
  }
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return false
    if (!jsonDeepEqual(a[k], b[k])) return false
  }
  return true
}

/** case_instance_id 校验（单段安全名）。返回 {ok, problems}。 */
export function validateCaseInstanceId(id) {
  const problems = []
  if (typeof id !== 'string' || id.length === 0) return { ok: false, problems: ['empty or non-string'] }
  if (id.length > MAX_INSTANCE_ID) problems.push('too long (>' + MAX_INSTANCE_ID + ')')
  if (/[\u0000-\u001f]/.test(id)) problems.push('control character')
  if (/[\\/:*?"<>|]/.test(id)) problems.push('forbidden character (\\ / : * ? " < > |)')
  if (id === '.' || id === '..') problems.push('dot segment')
  if (/^\./.test(id)) problems.push('leading dot') // 隐藏目录/别名风险
  if (/[. ]$/.test(id)) problems.push('trailing dot or space (Windows alias)')
  if (/^\s/.test(id)) problems.push('leading whitespace')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) problems.push('charset (allow A-Za-z0-9 . _ -)')
  const base = id.split('.')[0].toUpperCase()
  if (RESERVED_NAMES.has(base)) problems.push('reserved device name')
  return { ok: problems.length === 0, problems }
}

/**
 * [E3 M0] runtime metadata denylist（spec v0.3 §4.1：canonical 序列化必须剥离/拒绝
 * 任何 runtime metadata——provenance.js:96 注入的字段一律不进 canonical，只进 receipt）。
 *
 * denylist 定稿（2026-10-15 全仓 grep 查证）：
 *   `_provenance`（含其下所有子键）——注入层字段（src/provenance.js:96-100
 *     stampProvenance 挂 `{tool, at}`；src/tools.js:292/954 输出信封附加），
 *     全仓无任何 schema 将其定义为工件合法字段；
 *   `generated_at` / `captured_at` / `run_uuid` —— 全仓 0 处合法用途；
 *   `fetched_at` —— **已从 denylist 移除**：design/packet/schemas/genome_ref.json:102
 *     将其定义为 genome_ref 工件合法字段（$ref isoTimestamp），且
 *     test/design-dispatch.mjs:47 以 fetched_at 变体构造合法 genome_ref 工件走
 *     canonical 路径（保留会破坏纯净输入，违反「纯净输入零行为变化」约束）。
 */
const RUNTIME_METADATA_DENYLIST = new Set(['_provenance', 'generated_at', 'captured_at', 'run_uuid'])

/** 递归扫描对象/数组中的 runtime metadata 键。返回命中键的路径列表（空数组 = 纯净）。 */
export function scanRuntimeMetadata(value, path = '$') {
  const hits = []
  const walk = (v, p) => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) walk(v[i], p + '[' + i + ']')
      return
    }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        const child = p + '.' + k
        if (RUNTIME_METADATA_DENYLIST.has(k)) hits.push(child)
        walk(v[k], child)
      }
    }
  }
  walk(value, path)
  return hits
}

/** 经冻结 c14n（packet impl CLI 子进程）做 canonical 序列化。 */
export function canonicalizeViaPacket(text, annotations) {
  // [E3 M0] 系统级 fail-closed 拒绝（单点接线）：解析后、进 c14n 子进程前扫描
  // runtime metadata。命中 → DETERMINISM_VIOLATION，不进入子进程；下游
  // （content id / snapshot sha / artifact staging / ingress inventory）自动继承拒绝。
  let scanned = null
  try {
    scanned = JSON.parse(text)
  } catch { /* 非 JSON 文本交给下游既有路径（c14n 子进程自行判定），不改变行为 */ }
  if (scanned !== null) {
    const hits = scanRuntimeMetadata(scanned)
    if (hits.length > 0) {
      return { ok: false, code: 'DETERMINISM_VIOLATION', detail: 'runtime metadata in canonical input: ' + hits.join(', ') }
    }
  }
  const work = mkdtempSync(join(tmpdir(), 'design-casefile-c14n-'))
  try {
    const casePath = join(work, 'case.json')
    const outPath = join(work, 'out.json')
    writeFileSync(casePath, JSON.stringify({ cases: [{ id: 'c', input: text, annotations: annotations || {} }] }), 'utf8')
    const r = spawnSync(process.execPath, [C14N_IMPL, '--batch', casePath, '--out', outPath], { encoding: 'utf8', timeout: 120000 })
    if (r.status !== 0) return { ok: false, code: 'C14N_RUNNER_FAILED', detail: String(r.stderr || '').slice(0, 160) }
    const res = JSON.parse(readFileSync(outPath, 'utf8')).results[0]
    if (res.status !== 'accept') return { ok: false, code: res.code || 'C14N_REJECT', detail: String(res.detail || '').slice(0, 160) }
    return { ok: true, canonical: res.canonical }
  } catch (e) {
    return { ok: false, code: 'C14N_ERROR', detail: String(e.message).slice(0, 160) }
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

const H64 = /^[0-9a-f]{64}$/
const CASE_REPORT_TYPE = 'case_report@1'
const MAX_CASE_REPORT_BYTES = 16 * 1024 * 1024

/**
 * `case_report@1` is intentionally a narrow raw-byte exception to the packet
 * JSON artifact path.  The frozen case_manifest schema already enumerates the
 * type, while report.md itself must remain Markdown bytes so that its content
 * hash is the report identity.  Keep this validator local and restrictive:
 * it is not a generic escape hatch for unknown artifact types.
 */
function reportForbiddenProblems(text, { caseDir = null, sourceSnapshotSha = null } = {}) {
  const problems = []
  const normalized = text.replace(/\\/g, '/').toLowerCase()
  const add = (code) => { if (!problems.includes(code)) problems.push(code) }
  if (/\bcase_instance_id\b/i.test(text)) add('REPORT_FORBIDDEN_CASE_INSTANCE_ID')
  if (caseDir) {
    const roots = [caseDir, dirname(dirname(dirname(caseDir)))]
    for (const root of roots) {
      const candidate = String(root).replace(/\\/g, '/').toLowerCase()
      if (candidate && normalized.includes(candidate)) add('REPORT_FORBIDDEN_WORKDIR')
    }
    const instance = basename(caseDir)
    if (instance) {
      const escaped = instance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(^|[^A-Za-z0-9._-])${escaped}($|[^A-Za-z0-9._-])`, 'i').test(text)) add('REPORT_FORBIDDEN_CASE_INSTANCE_ID')
    }
  }
  if (/(?:^|[\\/])(tmp|temp)(?:[\\/]|$)/i.test(text)) add('REPORT_FORBIDDEN_TEMP_PATH')
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text)) add('REPORT_FORBIDDEN_RUN_UUID')
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(text)) add('REPORT_FORBIDDEN_REAL_TIME')
  if (/\bstderr\b/i.test(text)) add('REPORT_FORBIDDEN_STDERR')
  if (/\bbundle\.zip\b/i.test(text) || /(?:^|[\\/])exports(?:[\\/]|$)/i.test(text)) add('REPORT_FORBIDDEN_BUNDLE_PATH')
  if (/\bsnapshot_sha\b/i.test(text) || (sourceSnapshotSha && text.includes(sourceSnapshotSha))) add('REPORT_FORBIDDEN_SNAPSHOT_SHA')
  return problems
}

/** Validate raw UTF-8/LF report bytes before they can enter a snapshot. */
export function validateCaseReportBytes(reportBytes, { caseDir = null, sourceSnapshotSha = null } = {}) {
  const bytes = Buffer.isBuffer(reportBytes) ? reportBytes : Buffer.from(reportBytes || '')
  if (bytes.length === 0 || bytes.length > MAX_CASE_REPORT_BYTES) {
    return { ok: false, code: 'CASE_REPORT_SIZE_INVALID', size: bytes.length }
  }
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { ok: false, code: 'CASE_REPORT_NOT_UTF8' }
  if (text.includes('\r') || !text.endsWith('\n')) return { ok: false, code: 'CASE_REPORT_LINE_ENDING_INVALID' }
  if (!text.startsWith('# 设计 casefile 最终报告\n')) return { ok: false, code: 'CASE_REPORT_HEADER_INVALID' }
  const problems = reportForbiddenProblems(text, { caseDir, sourceSnapshotSha })
  if (problems.length) return { ok: false, code: problems[0], problems }
  return { ok: true, text, sha256: sha256hex(bytes) }
}

/**
 * case_content_id 派生（derivation v1）：
 *   doc = {policy_version, root_input_artifact_ids(set, 排序), canonical_params(扁平对象)}
 *   case_content_id = sha256(canonical(doc))（冻结 c14n）。
 * canonical_params 仅允许扁平 string/number/boolean（数组/嵌套对象需先归一为显式结构）。
 */
export function deriveCaseContentId({ rootInputArtifactIds, policyVersion, canonicalParams = {} } = {}) {
  const problems = []
  if (!Array.isArray(rootInputArtifactIds)) problems.push('rootInputArtifactIds must be an array')
  else {
    for (const v of rootInputArtifactIds) {
      if (typeof v !== 'string' || !H64.test(v)) problems.push('root input artifact id not sha256Hex: ' + String(v).slice(0, 24))
    }
  }
  if (typeof policyVersion !== 'string' || !policyVersion) problems.push('policyVersion required')
  if (!canonicalParams || typeof canonicalParams !== 'object' || Array.isArray(canonicalParams)) problems.push('canonicalParams must be a flat object')
  else {
    const keys = Object.keys(canonicalParams)
    if (keys.length > 64) problems.push('canonicalParams too many keys')
    for (const k of keys) {
      const v = canonicalParams[k]
      const t = typeof v
      if (t !== 'string' && t !== 'number' && t !== 'boolean') problems.push('canonicalParams value not flat scalar: ' + k)
      if (t === 'number' && !Number.isFinite(v)) problems.push('canonicalParams value not finite: ' + k)
    }
  }
  if (problems.length) return { ok: false, problems }
  const doc = {
    policy_version: policyVersion,
    root_input_artifact_ids: rootInputArtifactIds.slice(),
    canonical_params: { ...canonicalParams },
  }
  const canon = canonicalizeViaPacket(JSON.stringify(doc), { '$/root_input_artifact_ids': 'set' })
  if (!canon.ok) return { ok: false, problems: ['canonicalization failed: ' + canon.code] }
  return { ok: true, case_content_id: sha256hex(Buffer.from(canon.canonical, 'utf8')), canonical_text: canon.canonical }
}

/** snapshot_sha = sha256(canonical(manifest_without_snapshot_sha))。返回 {ok, snapshot_sha, canonical_without}。 */
export function computeSnapshotSha(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, problems: ['manifest must be an object'] }
  }
  const without = { ...manifest }
  delete without.snapshot_sha
  const ann = deriveAnnotationsForArtifact('case_manifest', without)
  if (ann === null) return { ok: false, problems: ['annotations derivation failed (packet unverified?)'] }
  const canon = canonicalizeViaPacket(JSON.stringify(without), ann)
  if (!canon.ok) return { ok: false, problems: ['canonicalization failed: ' + canon.code] }
  return { ok: true, snapshot_sha: sha256hex(Buffer.from(canon.canonical, 'utf8')), canonical_without: canon.canonical }
}

function atomicWriteBytes(path, bytes) {
  const tmp = path + '.tmp-' + process.pid + '-' + Math.random().toString(16).slice(2, 10)
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** 写快照文件（原子 + fsync）；同名非逐字节相同 → SNAPSHOT_HASH_COLLISION。 */
export function writeSnapshot({ snapshotsDir, manifest, validate = null } = {}) {
  const sha = computeSnapshotSha(manifest)
  if (!sha.ok) return { ok: false, code: 'SNAPSHOT_INVALID', problems: sha.problems }
  const full = { ...manifest, snapshot_sha: sha.snapshot_sha }
  if (typeof validate === 'function') {
    const v = validate(full)
    if (v && v.ok === false) return { ok: false, code: 'SNAPSHOT_INVALID', problems: (v.errors || []).map((e) => e.code + '@' + e.path) }
  }
  const ann = deriveAnnotationsForArtifact('case_manifest', full)
  if (ann === null) return { ok: false, code: 'PACKET_UNVERIFIED', problems: ['annotations derivation failed'] }
  const canon = canonicalizeViaPacket(JSON.stringify(full), ann)
  if (!canon.ok) return { ok: false, code: 'SNAPSHOT_INVALID', problems: ['canonicalization failed: ' + canon.code] }
  const bytes = Buffer.from(canon.canonical, 'utf8')
  const path = join(snapshotsDir, sha.snapshot_sha + '.json')
  if (existsSync(path)) {
    const existing = readFileSync(path)
    if (!existing.equals(bytes)) {
      return { ok: false, code: 'SNAPSHOT_HASH_COLLISION', snapshot_sha: sha.snapshot_sha, path }
    }
    return { ok: true, snapshot_sha: sha.snapshot_sha, path, existed: true }
  }
  atomicWriteBytes(path, bytes)
  return { ok: true, snapshot_sha: sha.snapshot_sha, path, existed: false }
}

/** 读 HEAD（缺省 → snapshot_sha: null）。 */
export function readHead(caseDir) {
  const p = join(caseDir, 'HEAD.json')
  if (!existsSync(p)) return { ok: true, snapshot_sha: null }
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    return { ok: true, snapshot_sha: typeof doc.snapshot_sha === 'string' ? doc.snapshot_sha : null }
  } catch (e) {
    return { ok: false, problems: ['HEAD unreadable: ' + String(e.message).slice(0, 120)] }
  }
}

/** CAS 原子替换 HEAD（expect 不符 → HEAD_CAS_MISMATCH，HEAD 不变）。 */
export function writeHeadAtomic(caseDir, snapshotSha, { expect } = {}) {
  if (typeof snapshotSha !== 'string' || !H64.test(snapshotSha)) {
    return { ok: false, code: 'BAD_SNAPSHOT_SHA' }
  }
  const cur = readHead(caseDir)
  if (!cur.ok) return { ok: false, code: 'HEAD_UNREADABLE', problems: cur.problems }
  if (expect !== undefined && cur.snapshot_sha !== expect) {
    return { ok: false, code: 'HEAD_CAS_MISMATCH', current: cur.snapshot_sha, expected: expect }
  }
  atomicWriteBytes(join(caseDir, 'HEAD.json'), Buffer.from(JSON.stringify({ snapshot_sha: snapshotSha }) + '\n', 'utf8'))
  return { ok: true, snapshot_sha: snapshotSha }
}

/** append-only receipt（JSONL + fsync；单行上限 = maxReceiptLineBytes）。 */
export function appendReceipt(caseDir, event, { limits = null } = {}) {
  const L = { ...CASE_LIMITS, ...(limits || {}) }
  const line = Buffer.from(JSON.stringify(event) + '\n', 'utf8')
  if (line.length > L.maxReceiptLineBytes) {
    return { ok: false, code: 'RECEIPT_TOO_LARGE', size: line.length }
  }
  const p = join(caseDir, 'run_receipt.jsonl')
  const fd = openSync(p, 'a')
  try {
    writeSync(fd, line)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return { ok: true, path: p }
}

/**
 * 打开/创建 case 目录（TS 唯一创建；containment + reparse 全检查）。
 * 返回 {ok, caseDir, objectsDir, snapshotsDir, headPath, receiptPath} 或 {ok:false, code, problems}。
 */
export function ensureCaseDir(workdir, caseInstanceId, { create = true } = {}) {
  if (typeof workdir !== 'string' || !workdir) return { ok: false, code: 'WORKDIR_INVALID' }
  const wd = resolve(workdir)
  if (!existsSync(wd) || !lstatSync(wd).isDirectory()) return { ok: false, code: 'WORKDIR_MISSING', workdir: wd }
  const idv = validateCaseInstanceId(caseInstanceId)
  if (!idv.ok) return { ok: false, code: 'CASE_INSTANCE_ID_UNSAFE', problems: idv.problems }

  const caseRoot = join(wd, 'result', 'design')
  if (create) {
    try {
      mkdirSync(caseRoot, { recursive: true })
    } catch (e) {
      return { ok: false, code: 'CASE_ROOT_MKDIR_FAILED', caseRoot, problems: [String(e.message).slice(0, 160)] }
    }
  }
  if (!existsSync(caseRoot)) return { ok: false, code: 'CASE_ROOT_MISSING', caseRoot }
  const crStat = lstatSync(caseRoot)
  if (!crStat.isDirectory()) return { ok: false, code: 'CASE_ROOT_NOT_DIR', caseRoot }
  const wdReal = realpathSync(wd)
  const crReal = realpathSync(caseRoot)
  if (!isContained(wdReal, crReal)) return { ok: false, code: 'CASE_ROOT_ESCAPE', caseRoot, real: crReal }

  // 大小写别名：同名不同大小写已存在 → 拒绝（Windows 大小写不敏感 → 别名旁路）
  const entries = readdirSync(caseRoot)
  for (const e of entries) {
    if (e !== caseInstanceId && e.toLowerCase() === caseInstanceId.toLowerCase()) {
      return { ok: false, code: 'CASE_ALIAS_CONFLICT', existing: e, requested: caseInstanceId }
    }
  }

  const caseDir = join(caseRoot, caseInstanceId)
  if (existsSync(caseDir)) {
    const st = lstatSync(caseDir)
    if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, code: 'CASE_TARGET_UNSAFE', caseDir }
    const cdReal = realpathSync(caseDir)
    if (!isContained(crReal, cdReal)) return { ok: false, code: 'CASE_TARGET_ESCAPE', caseDir, real: cdReal }
  } else {
    if (!create) return { ok: false, code: 'CASE_NOT_FOUND', caseDir }
    try {
      mkdirSync(caseDir)
    } catch (e) {
      return { ok: false, code: 'CASE_MKDIR_FAILED', caseDir, problems: [String(e.message).slice(0, 160)] }
    }
    const cdReal = realpathSync(caseDir)
    if (!isContained(crReal, cdReal)) return { ok: false, code: 'CASE_TARGET_ESCAPE', caseDir, real: cdReal }
  }

  const objectsDir = join(caseDir, 'objects')
  const snapshotsDir = join(caseDir, 'snapshots')
  for (const d of [objectsDir, snapshotsDir]) {
    if (!existsSync(d)) {
      try {
        mkdirSync(d)
      } catch (e) {
        return { ok: false, code: 'CASE_SUBDIR_MKDIR_FAILED', dir: d, problems: [String(e.message).slice(0, 160)] }
      }
    }
    const st = lstatSync(d)
    if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, code: 'CASE_SUBDIR_UNSAFE', dir: d }
  }
  return {
    ok: true,
    caseDir,
    objectsDir,
    snapshotsDir,
    headPath: join(caseDir, 'HEAD.json'),
    receiptPath: join(caseDir, 'run_receipt.jsonl'),
  }
}

// ════════════════════════════════════════════════════════════════════
// A2：casefile 库 — 每-case 锁 / 单事务六步（v0.4 §C2）/ 孤儿 GC / case 上下文
// ════════════════════════════════════════════════════════════════════

/** 大小/性能上限 v1（复核4 要求「定义 manifest / object / receipt 的上限」；可被调用方覆盖）。 */
export const CASE_LIMITS = {
  maxObjectBytes: 256 * 1024 * 1024,
  maxManifestBytes: 16 * 1024 * 1024,
  maxReceiptLineBytes: 64 * 1024,
  maxArtifactsPerSnapshot: 10000,
}

const STEM_RE = /@1$/
function stemOf(type) {
  return String(type).replace(STEM_RE, '')
}
function typeOf(type) {
  const s = stemOf(type)
  return s + '@1'
}

/** 读快照 manifest（内容寻址 <snapshotsDir>/<sha>.json）。 */
export function loadSnapshot(snapshotsDir, sha) {
  if (typeof sha !== 'string' || !H64.test(sha)) return { ok: false, detail: 'bad snapshot sha' }
  const p = join(snapshotsDir, sha + '.json')
  if (!existsSync(p)) return { ok: false, detail: 'snapshot missing' }
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    return { ok: true, manifest: doc, path: p }
  } catch (e) {
    return { ok: false, detail: String(e.message).slice(0, 120) }
  }
}

/** 读工件对象（内容寻址 <objectsDir>/<sha256>）。 */
export function loadArtifact(handle, artifactId) {
  if (typeof artifactId !== 'string' || !H64.test(artifactId)) return { ok: false, code: 'BAD_ARTIFACT_ID' }
  const p = join(handle.objectsDir, artifactId)
  if (!existsSync(p)) return { ok: false, code: 'OBJECT_NOT_FOUND' }
  try {
    const bytes = readFileSync(p)
    return { ok: true, value: JSON.parse(bytes.toString('utf8')), sha256: artifactId, bytes: bytes.length }
  } catch (e) {
    return { ok: false, code: 'OBJECT_UNREADABLE', detail: String(e.message).slice(0, 120) }
  }
}

/** 获取每-case 写锁（原子创建 case.lock；持锁进程已死 → 陈旧可抢占）。 */
export function acquireCaseLock(caseDir, { op = 'commit' } = {}) {
  const lockPath = join(caseDir, 'case.lock')
  const payload = JSON.stringify({ pid: process.pid, op, at: new Date().toISOString() })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, payload)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return { ok: true, lockPath }
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, code: 'LOCK_IO_ERROR', detail: String(e.message).slice(0, 160) }
      let holder = null
      try {
        holder = JSON.parse(readFileSync(lockPath, 'utf8'))
      } catch {
        holder = null
      }
      const pid = holder && Number(holder.pid)
      let alive = false
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0)
          alive = true
        } catch (err) {
          alive = err.code === 'EPERM' // 存在但无权限 → 视为存活
        }
      } else if (pid === process.pid) {
        alive = true
      }
      if (alive) return { ok: false, code: 'LOCK_HELD', holder: holder || null }
      try {
        unlinkSync(lockPath) // 陈旧：抢占后重试
      } catch { /* 竞争下可能已被他人处理 */ }
    }
  }
  return { ok: false, code: 'LOCK_CONTENDED' }
}

export function releaseCaseLock(caseDir) {
  const lockPath = join(caseDir, 'case.lock')
  let holder = null
  try {
    holder = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    return { ok: true, missing: true }
  }
  if (holder && Number(holder.pid) !== process.pid) return { ok: false, code: 'LOCK_NOT_OWNER' }
  try {
    unlinkSync(lockPath)
  } catch (e) {
    return { ok: false, code: 'LOCK_RELEASE_FAILED', detail: String(e.message).slice(0, 120) }
  }
  return { ok: true }
}

/** 持锁执行 fn；获取失败 → {ok:false, code:'LOCK_HELD'}；无论成败必释放。 */
export function withCaseLock(caseDir, fn, { op } = {}) {
  const acq = acquireCaseLock(caseDir, { op })
  if (!acq.ok) return { ok: false, code: acq.code, holder: acq.holder }
  try {
    return fn()
  } finally {
    releaseCaseLock(caseDir)
  }
}

/**
 * 单事务提交（v0.4 §C2 六步；all-or-none）：
 *   ① stage 全部新对象（写 <caseDir>/staging/<txid>/）→ ② canonical/schema 校验 →
 *   ③ 发布 objects（内容寻址）→ ④ 写 + fsync 快照 → ⑤ CAS 原子替换 HEAD → ⑥ committed receipt。
 * 任一步失败 → HEAD 不变、无 committed receipt；已发布对象/暂存文件 = 孤儿（GC 清理）。
 * 已存在的同名快照（existed=true）失败时不删除；本事务新建的快照在 ④/⑤ 失败时删除（从未被引用）。
 */
export function commitTransaction(handle, { caseContentId = null, policy = null, newArtifacts = [], txid = null, expectHead, limits = null } = {}) {
  const L = { ...CASE_LIMITS, ...(limits || {}) }
  const { caseDir, objectsDir, snapshotsDir } = handle
  const id = txid || randomUUID()
  return withCaseLock(caseDir, () => {
    const head = readHead(caseDir)
    if (!head.ok) return { ok: false, code: 'HEAD_UNREADABLE', step: 0, txid: id }
    const headSha = head.snapshot_sha
    if (expectHead !== undefined && headSha !== expectHead) {
      return { ok: false, code: 'HEAD_CAS_MISMATCH', step: 0, txid: id, current: headSha, expected: expectHead }
    }
    let baseArtifacts = []
    let contentId = caseContentId
    let policyDoc = policy
    if (headSha) {
      const snap = loadSnapshot(snapshotsDir, headSha)
      if (!snap.ok) return { ok: false, code: 'SNAPSHOT_UNREADABLE', step: 0, txid: id, detail: snap.detail }
      baseArtifacts = Array.isArray(snap.manifest.artifacts) ? snap.manifest.artifacts : []
      if (contentId && contentId !== snap.manifest.case_content_id) return { ok: false, code: 'CASE_CONTENT_MISMATCH', step: 0, txid: id }
      contentId = snap.manifest.case_content_id
      if (policyDoc && !jsonDeepEqual(policyDoc, snap.manifest.policy)) return { ok: false, code: 'POLICY_MISMATCH', step: 0, txid: id }
      policyDoc = snap.manifest.policy
    } else if (!contentId || !policyDoc) {
      return { ok: false, code: 'BASE_REQUIRED', step: 0, txid: id }
    }
    if (baseArtifacts.length + newArtifacts.length > L.maxArtifactsPerSnapshot) {
      return { ok: false, code: 'MANIFEST_TOO_MANY_ARTIFACTS', step: 0, txid: id }
    }
    // ① stage（canonicalize + 写 staging/<txid>/<sha>）
    const stagingDir = join(caseDir, 'staging', id)
    mkdirSync(stagingDir, { recursive: true })
    const staged = []
    for (const a of newArtifacts) {
      if (!a || typeof a.type !== 'string' || !a.value || typeof a.value !== 'object' || Array.isArray(a.value)) {
        return { ok: false, code: 'ARTIFACT_SHAPE_INVALID', step: 1, txid: id }
      }
      const stem = stemOf(a.type)
      const ann = deriveAnnotationsForArtifact(stem, a.value)
      if (ann === null) return { ok: false, code: 'PACKET_UNVERIFIED', step: 1, txid: id }
      const canon = canonicalizeViaPacket(JSON.stringify(a.value), ann)
      if (!canon.ok) return { ok: false, code: 'ARTIFACT_CANON_FAILED', step: 1, txid: id, detail: canon.code }
      const bytes = Buffer.from(canon.canonical, 'utf8')
      if (bytes.length > L.maxObjectBytes) return { ok: false, code: 'OBJECT_TOO_LARGE', step: 1, txid: id, size: bytes.length }
      const sha = sha256hex(bytes)
      writeFileSync(join(stagingDir, sha), bytes)
      staged.push({
        sha, bytes, stem,
        producer: typeof a.producer === 'string' && a.producer ? a.producer : 'bsp',
        inputs: Array.isArray(a.inputs) ? a.inputs : [],
        canonical_path: typeof a.canonical_path === 'string' && a.canonical_path ? a.canonical_path : stem + '.json',
        value: a.value,
      })
    }
    // ② schema/sem 校验（全过才继续）
    for (const s of staged) {
      const v = validateDesignArtifact(s.stem, s.value)
      if (!v.ok) {
        const first = (v.errors || [{}])[0]
        return { ok: false, code: 'ARTIFACT_INVALID', step: 2, txid: id, detail: s.stem + ':' + String(first.code) + '@' + String(first.path) }
      }
    }
    // 去重（同 artifact_id 已存在 → 首现优先；全部重复 → no_change）
    const existingIds = new Set(baseArtifacts.map((a) => a && a.artifact_id))
    const fresh = staged.filter((s) => !existingIds.has(s.sha))
    if (fresh.length === 0) {
      return { ok: true, no_change: true, txid: id, snapshot_sha: headSha }
    }
    // ③ 发布 objects（已存在必须逐字节相同）
    for (const s of fresh) {
      const target = join(objectsDir, s.sha)
      if (existsSync(target)) {
        const existing = readFileSync(target)
        if (!existing.equals(s.bytes)) return { ok: false, code: 'OBJECT_HASH_COLLISION', step: 3, txid: id, sha: s.sha }
      } else {
        atomicWriteBytes(target, s.bytes)
      }
    }
    // ④ 写 + fsync 快照
    const newEntries = fresh.map((s) => ({
      artifact_id: s.sha,
      type: typeOf(s.stem),
      inputs: s.inputs,
      producer: s.producer,
      schema_major: '1',
      canonical_path: s.canonical_path,
    }))
    const manifest = {
      schema_version: '1.0',
      case_content_id: contentId,
      artifacts: [...baseArtifacts, ...newEntries],
      policy: policyDoc,
    }
    const ws = writeSnapshot({ snapshotsDir, manifest, validate: (m) => validateDesignArtifact('case_manifest', m) })
    if (!ws.ok) return { ok: false, code: ws.code, step: 4, txid: id, problems: ws.problems }
    const manifestBytes = readFileSync(ws.path)
    if (manifestBytes.length > L.maxManifestBytes) {
      if (!ws.existed) {
        try { unlinkSync(ws.path) } catch { /* best effort */ }
      }
      return { ok: false, code: 'MANIFEST_TOO_LARGE', step: 4, txid: id, size: manifestBytes.length }
    }
    // ⑤ CAS 原子替换 HEAD
    const wh = writeHeadAtomic(caseDir, ws.snapshot_sha, { expect: headSha })
    if (!wh.ok) {
      if (!ws.existed) {
        try { unlinkSync(ws.path) } catch { /* best effort */ }
      }
      return { ok: false, code: wh.code, step: 5, txid: id }
    }
    // ⑥ committed receipt
    const rc = appendReceipt(caseDir, {
      event: 'committed',
      txid: id,
      snapshot_sha: ws.snapshot_sha,
      parent_snapshot_sha: headSha,
      at: new Date().toISOString(),
      artifacts: fresh.map((s) => ({ artifact_id: s.sha, type: typeOf(s.stem) })),
    }, { limits: L })
    if (!rc.ok) return { ok: false, code: rc.code, step: 6, txid: id }
    return { ok: true, snapshot_sha: ws.snapshot_sha, parent: headSha, txid: id, published: fresh.map((s) => s.sha) }
  }, { op: 'commit' })
}

/**
 * Commit the sole raw-byte scientific artifact admitted by B4.
 *
 * `case_report@1` is deliberately not routed through `commitTransaction`:
 * the frozen packet manifests reserve that type but do not provide a JSON
 * schema for Markdown.  This narrow transaction has the same lock/CAS/object/
 * snapshot/receipt ordering as the ordinary transaction and accepts exactly
 * one validated `report.md`; it is not a generic binary-artifact escape hatch.
 *
 * The report's inputs are always the complete ordered artifact-id set of the
 * immutable parent snapshot.  Callers may supply that set as a binding check,
 * but cannot substitute a subset or add receipt-derived values.
 */
export function commitReportFinalizeTransaction(handle, {
  reportBytes,
  expectHead,
  sourceArtifactIds = undefined,
  txid = null,
  limits = null,
} = {}) {
  const L = { ...CASE_LIMITS, ...(limits || {}) }
  const { caseDir, objectsDir, snapshotsDir } = handle || {}
  const id = txid || randomUUID()
  if (!caseDir || !objectsDir || !snapshotsDir) return { ok: false, code: 'CASE_HANDLE_INVALID', step: 0, txid: id }
  if (typeof expectHead !== 'string' || !H64.test(expectHead)) {
    return { ok: false, code: 'REPORT_PARENT_INVALID', step: 0, txid: id }
  }
  const bytes = Buffer.isBuffer(reportBytes) ? reportBytes : Buffer.from(reportBytes || '')
  return withCaseLock(caseDir, () => {
    const head = readHead(caseDir)
    if (!head.ok) return { ok: false, code: 'HEAD_UNREADABLE', step: 0, txid: id }
    if (head.snapshot_sha !== expectHead) {
      return { ok: false, code: 'HEAD_CAS_MISMATCH', step: 0, txid: id, current: head.snapshot_sha, expected: expectHead }
    }
    const snap = loadSnapshot(snapshotsDir, expectHead)
    if (!snap.ok) return { ok: false, code: 'SNAPSHOT_UNREADABLE', step: 0, txid: id, detail: snap.detail }
    const baseArtifacts = Array.isArray(snap.manifest.artifacts) ? snap.manifest.artifacts : []
    if (baseArtifacts.length + 1 > L.maxArtifactsPerSnapshot) {
      return { ok: false, code: 'MANIFEST_TOO_MANY_ARTIFACTS', step: 0, txid: id }
    }
    if (baseArtifacts.some((entry) => entry && entry.type === CASE_REPORT_TYPE)) {
      return { ok: false, code: 'REPORT_ALREADY_FINALIZED', step: 0, txid: id }
    }
    const parentIds = baseArtifacts.map((entry) => entry && entry.artifact_id).sort()
    if (parentIds.some((artifactId) => typeof artifactId !== 'string' || !H64.test(artifactId))) {
      return { ok: false, code: 'REPORT_PARENT_MANIFEST_INVALID', step: 0, txid: id }
    }
    if (sourceArtifactIds !== undefined) {
      if (!Array.isArray(sourceArtifactIds)
        || sourceArtifactIds.some((artifactId) => typeof artifactId !== 'string' || !H64.test(artifactId))) {
        return { ok: false, code: 'REPORT_INPUT_BINDING_INVALID', step: 0, txid: id }
      }
      const supplied = sourceArtifactIds.slice().sort()
      if (new Set(supplied).size !== supplied.length
        || supplied.length !== parentIds.length
        || supplied.some((artifactId, index) => artifactId !== parentIds[index])) {
        return { ok: false, code: 'REPORT_INPUT_BINDING_INVALID', step: 0, txid: id }
      }
    }
    const report = validateCaseReportBytes(bytes, { caseDir, sourceSnapshotSha: expectHead })
    if (!report.ok) return { ok: false, code: report.code, step: 2, txid: id, problems: report.problems }
    if (bytes.length > L.maxObjectBytes) {
      return { ok: false, code: 'OBJECT_TOO_LARGE', step: 1, txid: id, size: bytes.length }
    }
    const reportId = report.sha256
    if (baseArtifacts.some((entry) => entry && entry.artifact_id === reportId)) {
      return { ok: false, code: 'REPORT_ARTIFACT_ID_COLLISION', step: 2, txid: id, report_artifact_id: reportId }
    }

    // 1) stage the already TS-rechecked bytes in the transaction namespace.
    const stagingDir = join(caseDir, 'staging', id)
    mkdirSync(stagingDir, { recursive: true })
    writeFileSync(join(stagingDir, reportId), bytes)

    // 2) raw report validation above is the schema-equivalent narrow gate.
    // 3) publish content-addressed object, refusing a non-identical collision.
    const objectPath = join(objectsDir, reportId)
    if (existsSync(objectPath)) {
      if (!readFileSync(objectPath).equals(bytes)) {
        return { ok: false, code: 'OBJECT_HASH_COLLISION', step: 3, txid: id, sha: reportId }
      }
    } else {
      atomicWriteBytes(objectPath, bytes)
    }

    const reportEntry = {
      artifact_id: reportId,
      type: CASE_REPORT_TYPE,
      inputs: parentIds,
      producer: 'report-finalize',
      schema_major: '1',
      canonical_path: 'report.md',
    }
    const manifest = {
      schema_version: '1.0',
      case_content_id: snap.manifest.case_content_id,
      artifacts: [...baseArtifacts, reportEntry],
      policy: snap.manifest.policy,
    }
    // 4) immutable snapshot (the frozen manifest schema explicitly permits
    // case_report@1 even though its raw bytes use this local narrow validator).
    const ws = writeSnapshot({ snapshotsDir, manifest, validate: (m) => validateDesignArtifact('case_manifest', m) })
    if (!ws.ok) return { ok: false, code: ws.code, step: 4, txid: id, problems: ws.problems }
    const manifestBytes = readFileSync(ws.path)
    if (manifestBytes.length > L.maxManifestBytes) {
      if (!ws.existed) {
        try { unlinkSync(ws.path) } catch { /* best effort */ }
      }
      return { ok: false, code: 'MANIFEST_TOO_LARGE', step: 4, txid: id, size: manifestBytes.length }
    }
    // 5) CAS only after the complete target snapshot is durable.
    const wh = writeHeadAtomic(caseDir, ws.snapshot_sha, { expect: expectHead })
    if (!wh.ok) {
      if (!ws.existed) {
        try { unlinkSync(ws.path) } catch { /* best effort */ }
      }
      return { ok: false, code: wh.code, step: 5, txid: id }
    }
    // 6) receipt records the committed science transition.  Runtime fields
    // live only here and can never be rendered into report.md.
    const rc = appendReceipt(caseDir, {
      event: 'committed',
      txid: id,
      snapshot_sha: ws.snapshot_sha,
      parent_snapshot_sha: expectHead,
      at: new Date().toISOString(),
      artifacts: [{ artifact_id: reportId, type: CASE_REPORT_TYPE }],
      report_finalize: true,
    }, { limits: L })
    if (!rc.ok) return { ok: false, code: rc.code, step: 6, txid: id }
    return {
      ok: true,
      snapshot_sha: ws.snapshot_sha,
      parent: expectHead,
      txid: id,
      report_artifact_id: reportId,
      published: [reportId],
    }
  }, { op: 'report-finalize' })
}

/**
 * 孤儿 GC：**根 = 全部不可变快照**（非仅 HEAD，复核4 要求）——清理未被任何快照引用的
 * objects + 全部 staging 残留（持锁下任何 staging 均非在飞）+ 原子写残片（*.tmp-*）。
 * 不删除任何快照文件（不可变追加）。dryRun=true 仅报告。
 */
export function gcOrphans(handle, { dryRun = false } = {}) {
  const { caseDir, objectsDir, snapshotsDir } = handle
  return withCaseLock(caseDir, () => {
    const referenced = new Set()
    const snapFiles = existsSync(snapshotsDir) ? readdirSync(snapshotsDir) : []
    for (const f of snapFiles) {
      if (!f.endsWith('.json')) continue
      const sha = f.slice(0, -5)
      if (!H64.test(sha)) continue
      const snap = loadSnapshot(snapshotsDir, sha)
      if (!snap.ok) continue
      for (const a of (snap.manifest.artifacts || [])) {
        if (a && typeof a.artifact_id === 'string') referenced.add(a.artifact_id)
      }
    }
    const removed = []
    const failures = []
    const objectFiles = existsSync(objectsDir) ? readdirSync(objectsDir) : []
    for (const f of objectFiles) {
      if (f.includes('.tmp-')) {
        if (!dryRun) {
          try { unlinkSync(join(objectsDir, f)) } catch (e) { failures.push('tmp:' + f + ':' + String(e.code)) ; continue }
        }
        removed.push('tmp:' + f)
        continue
      }
      if (!H64.test(f)) continue
      if (referenced.has(f)) continue
      if (!dryRun) {
        try {
          unlinkSync(join(objectsDir, f))
        } catch (e) {
          failures.push('object:' + f + ':' + String(e.code))
          continue
        }
      }
      removed.push('object:' + f)
    }
    const stagingRoot = join(caseDir, 'staging')
    if (existsSync(stagingRoot)) {
      for (const d of readdirSync(stagingRoot)) {
        const p = join(stagingRoot, d)
        try {
          const st = lstatSync(p)
          if (st.isDirectory() && !st.isSymbolicLink()) {
            if (!dryRun) rmSync(p, { recursive: true, force: true })
            removed.push('staging:' + d)
          }
        } catch { /* best effort */ }
      }
    }
    return { ok: true, removed, failures, kept: referenced.size, dryRun }
  }, { op: 'gc' })
}

const GENOME = 'genome_ref@1'
const GEM = 'metabolic_model_ref@1'
const EVIDENCE = 'evidence_item@1'
const CONDITION = 'condition_card@1'
const COUPLING = 'coupling_profile@1'

/**
 * 从当前快照重算 case 上下文（不信调用方任何 tier 字段；v0.3 §3.1）。
 * input_state 推导 v1（保守；精化随 B1）：reference_complete / missing_condition /
 * user_calibrated_only / consequence_only / missing_annotation（兜底，含空 case）。
 */
export function resolveCaseContext(handle) {
  const head = readHead(handle.caseDir)
  if (!head.ok) return { ok: false, code: 'HEAD_UNREADABLE' }
  if (!head.snapshot_sha) {
    return {
      ok: true, snapshot_sha: null, case_content_id: null, artifacts_by_type: {},
      flags: { genome: false, annotated: false, gem: false, evidence: false, condition: false, coupling: false },
      coupling_mode: null, input_state: 'missing_annotation',
    }
  }
  const snap = loadSnapshot(handle.snapshotsDir, head.snapshot_sha)
  if (!snap.ok) return { ok: false, code: 'SNAPSHOT_UNREADABLE', detail: snap.detail }
  const byType = {}
  for (const a of (snap.manifest.artifacts || [])) {
    if (!a || typeof a.type !== 'string') continue
    ;(byType[a.type] = byType[a.type] || []).push(a.artifact_id)
  }
  const flags = {
    genome: (byType[GENOME] || []).length > 0,
    annotated: false,
    gem: (byType[GEM] || []).length > 0,
    evidence: (byType[EVIDENCE] || []).length > 0,
    condition: (byType[CONDITION] || []).length > 0,
    coupling: (byType[COUPLING] || []).length > 0,
  }
  if (flags.genome) {
    for (const id of byType[GENOME]) {
      const art = loadArtifact(handle, id)
      if (art.ok && Array.isArray(art.value.files) && art.value.files.some((f) => f && (f.format === 'gff3' || f.format === 'genbank'))) {
        flags.annotated = true
        break
      }
    }
  }
  let couplingMode = null
  if (flags.coupling) {
    for (const id of byType[COUPLING]) {
      const art = loadArtifact(handle, id)
      if (art.ok && typeof art.value.mode === 'string') {
        couplingMode = art.value.mode
        break
      }
    }
  }
  let inputState = 'missing_annotation'
  if (flags.genome && flags.annotated && flags.gem && flags.evidence && flags.condition) inputState = 'reference_complete'
  else if (flags.genome && flags.annotated && flags.gem && flags.evidence && !flags.condition) inputState = 'missing_condition'
  else if (flags.genome && flags.annotated && flags.gem && flags.condition && couplingMode === 'user_calibrated_bound') inputState = 'user_calibrated_only'
  else if (flags.genome && flags.annotated && flags.gem && flags.condition && flags.coupling) inputState = 'consequence_only'
  return {
    ok: true,
    snapshot_sha: head.snapshot_sha,
    case_content_id: snap.manifest.case_content_id,
    artifacts_by_type: byType,
    flags,
    coupling_mode: couplingMode,
    input_state: inputState,
  }
}

/** 上下文 + A9a policy → 逐 operation 判档（input_state/coupling_mode 缺省取自上下文）。 */
export function resolveCaseOperations(handle, queries, { policyDir } = {}) {
  const ctx = resolveCaseContext(handle)
  if (!ctx.ok) return ctx
  const loaded = policyDir ? loadCapabilityPolicy({ policyDir }) : loadCapabilityPolicy()
  if (!loaded.ok) return { ok: false, code: 'POLICY_UNVERIFIED', problems: loaded.problems }
  const results = []
  for (const q of queries) {
    results.push(resolveOperation(loaded.policy, {
      operation: q.operation,
      input_state: q.input_state || ctx.input_state,
      coupling_mode: q.coupling_mode || (ctx.coupling_mode || 'none'),
      claim_target: q.claim_target || 'none',
    }))
  }
  return { ok: true, context: ctx, policy_sha256: loaded.policy_sha256, results }
}
