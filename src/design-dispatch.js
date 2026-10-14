/**
 * dsh-bio-genie — designTool 提交路径（独立 dispatch 骨架；v3 §B0）
 *
 * 六个 design op 的**唯一合法执行通道**。骨架不变量（本批已落实）：
 *   1. 仅接受 DESIGN_OPS 集合内 op（否则 NOT_A_DESIGN_OP）
 *   2. enable gate 先行：verifyDesignPacket() 全量核验——失败即
 *      CONTRACT_PACKET_UNREVIEWED，绝不进入 spawn（v3 §A0.2）
 *   3. staging 隔离：reservation 生成 dispatch_id，Python 只写
 *      staging/<dispatch_id>/（v0.6 §E1 worker-output protocol 的落点）
 *   4. 只经本通道 spawn（注入 DSH_DESIGN_STAGING / DSH_DESIGN_DISPATCH_ID）
 * 完整状态机（RESERVED→COMMITTED/FAILED_CONSUMED、TS 侧 verify+commit、
 * ticket/HMAC）随 A3/B1 落地。
 * @module dsh-bio-genie/design-dispatch
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DESIGN_OPS } from './design-ops.js'
import { verifyDesignPacket, PACKET_DIR } from './design-gate.js'
import { deriveAnnotationsForArtifact, validateDesignArtifact } from './design-validate.js'
import { spawnPython } from './python.js'

const OPS_PATH = join(import.meta.dirname, '..', 'python', 'bio_ops.py')

function writeDispatchState(stagingDir, payload) {
  try {
    writeFileSync(join(stagingDir, 'dispatch.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8')
  } catch {
    /* staging 状态写入失败不阻断主流程；状态机完整版在 A3 收口 */
  }
}

/** stage② 前置：把 staged 文本经**冻结 c14n**（packet impl CLI，子进程）复核——
 *  必须 lossless 通过且 canonical serialization 与磁盘 bytes 逐字节一致。 */
function canonicalCheckViaPacket(artifactType, text) {
  let value
  try {
    value = JSON.parse(text)
  } catch (e) {
    return { ok: false, code: 'STAGED_UNREADABLE', detail: String(e.message).slice(0, 120) }
  }
  const ann = deriveAnnotationsForArtifact(artifactType, value)
  if (ann === null) return { ok: false, code: 'PACKET_UNVERIFIED', detail: 'annotations derivation failed' }
  const work = mkdtempSync(join(tmpdir(), 'design-c14n-'))
  const casePath = join(work, 'case.json')
  const outPath = join(work, 'out.json')
  writeFileSync(casePath, JSON.stringify({ cases: [{ id: 'staged', input: text, annotations: ann }] }), 'utf8')
  const r = spawnSync(process.execPath, [join(PACKET_DIR, 'impl', 'c14n.mjs'), '--batch', casePath, '--out', outPath], { encoding: 'utf8', timeout: 120000 })
  if (r.status !== 0) return { ok: false, code: 'C14N_RUNNER_FAILED', detail: String(r.stderr || '').slice(0, 160) }
  let res
  try {
    res = JSON.parse(readFileSync(outPath, 'utf8')).results[0]
  } catch (e) {
    return { ok: false, code: 'C14N_OUTPUT_UNREADABLE', detail: String(e.message).slice(0, 120) }
  }
  if (res.status !== 'accept') return { ok: false, code: res.code || 'C14N_REJECT', detail: String(res.detail || '').slice(0, 160) }
  return { ok: true, canonical: res.canonical }
}

/** stage②（v5）：staged 文本 → 冻结 c14n 复核（lossless + canonical==磁盘 bytes）→
 *  值层重验 → 仅全部 OK 才写 content-addressed object（<sha256>.json）。 */
export function verifyStagedCandidate({ stagingFile, expectedSha256, artifactType, objectsDir } = {}) {
  if (!stagingFile || !existsSync(stagingFile)) {
    return { ok: false, errors: [{ code: 'STAGED_MISSING', path: String(stagingFile) }] }
  }
  const bytes = readFileSync(stagingFile)
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (expectedSha256 && sha !== expectedSha256) {
    return { ok: false, errors: [{ code: 'STAGED_HASH_MISMATCH', path: String(stagingFile), detail: 'disk=' + sha.slice(0, 16) + ' expected=' + String(expectedSha256).slice(0, 16) }] }
  }
  const text = bytes.toString('utf8')
  const canon = canonicalCheckViaPacket(artifactType, text)
  if (!canon.ok) {
    return { ok: false, errors: [{ code: canon.code, path: String(stagingFile), detail: canon.detail }] }
  }
  if (canon.canonical !== text) {
    return { ok: false, errors: [{ code: 'NONCANONICAL_BYTES', path: String(stagingFile), detail: 'staged bytes != canonical serialization' }] }
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [{ code: 'STAGED_UNREADABLE', path: String(stagingFile), detail: String(e.message).slice(0, 120) }] }
  }
  const v = validateDesignArtifact(artifactType, value)
  if (!v.ok) return { ok: false, errors: v.errors }
  const dir = objectsDir || join(dirname(stagingFile), '..', '..', 'objects')
  mkdirSync(dir, { recursive: true })
  const objPath = join(dir, sha + '.json')
  writeFileSync(objPath, bytes)
  return { ok: true, object_path: objPath, sha256: sha }
}

export async function dispatchDesignOp(pythonPath, op, args = {}, { cwd, timeoutMs = 300_000, signal } = {}) {
  if (!DESIGN_OPS.has(op)) {
    return { ok: false, code: 'NOT_A_DESIGN_OP', error: `不是 design op：${op}（本通道仅接受 DESIGN_OPS 集合）` }
  }
  const gate = verifyDesignPacket()
  if (!gate.ok) {
    return { ok: false, code: gate.code, error: `design gate 拒绝：${gate.detail}` }
  }
  const workdir = cwd || process.cwd()
  const dispatchId = randomUUID()
  const stagingDir = join(workdir, 'staging', dispatchId)
  mkdirSync(stagingDir, { recursive: true })
  writeDispatchState(stagingDir, {
    dispatch_id: dispatchId, op, state: 'RESERVED', created_at: new Date().toISOString(),
  })
  const res = await spawnPython(pythonPath, OPS_PATH, { op, args }, {
    cwd, timeoutMs, signal,
    env: {
      DSH_DESIGN_STAGING: stagingDir,
      DSH_DESIGN_DISPATCH_ID: dispatchId,
      // 身份绑定（v5）：清除调用方继承的 packet 根，只传递 TS 约束的绝对身份（split-packet 防线）
      DSH_DESIGN_PACKET: '',
      DSH_DESIGN_PACKET_FIXED: PACKET_DIR,
      DSH_DESIGN_EXPECT_INDEX_SHA: gate.index_sha256 || '',
      DSH_DESIGN_EXPECT_MANIFEST_SHA: gate.manifest_sha256 || '',
      DSH_DESIGN_ACCEPTANCE_ID: gate.acceptance_id || '',
    },
  })
  // stage②：TS 复核 staged candidate（重新哈希 + 重新验证）→ 仅 OK 才写 content-addressed object
  let committed = null
  const stagedInfo = res.ok && res.result && res.result.staged ? res.result : null
  if (stagedInfo) {
    committed = verifyStagedCandidate({
      stagingFile: stagedInfo.staged,
      expectedSha256: stagedInfo.sha256,
      artifactType: stagedInfo.artifact_type,
    })
    writeDispatchState(stagingDir, {
      dispatch_id: dispatchId, op,
      state: committed.ok ? 'CANDIDATE_COMMITTED' : 'CANDIDATE_REJECTED',
      object: committed.ok ? committed.object_path : null,
      sha256: committed.ok ? committed.sha256 : null,
      errors: committed.ok ? null : committed.errors.slice(0, 5),
      created_at: new Date().toISOString(),
    })
  } else {
    writeDispatchState(stagingDir, {
      dispatch_id: dispatchId, op,
      state: res.ok ? 'CANDIDATE_RETURNED' : 'FAILED',
      created_at: new Date().toISOString(),
    })
  }
  return { ...res, dispatch_id: dispatchId, staging_dir: stagingDir, committed }
}
