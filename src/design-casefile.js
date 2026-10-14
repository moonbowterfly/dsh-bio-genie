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
import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PACKET_DIR } from './design-gate.js'
import { deriveAnnotationsForArtifact } from './design-validate.js'

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

/** 经冻结 c14n（packet impl CLI 子进程）做 canonical 序列化。 */
export function canonicalizeViaPacket(text, annotations) {
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

/** append-only receipt（JSONL + fsync）。 */
export function appendReceipt(caseDir, event) {
  const p = join(caseDir, 'run_receipt.jsonl')
  const line = Buffer.from(JSON.stringify(event) + '\n', 'utf8')
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
