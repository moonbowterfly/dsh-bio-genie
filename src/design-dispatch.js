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
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESIGN_OPS } from './design-ops.js'
import { verifyDesignPacket } from './design-gate.js'
import { spawnPython } from './python.js'

const OPS_PATH = join(import.meta.dirname, '..', 'python', 'bio_ops.py')

function writeDispatchState(stagingDir, payload) {
  try {
    writeFileSync(join(stagingDir, 'dispatch.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8')
  } catch {
    /* staging 状态写入失败不阻断主流程；状态机完整版在 A3 收口 */
  }
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
    env: { DSH_DESIGN_STAGING: stagingDir, DSH_DESIGN_DISPATCH_ID: dispatchId },
  })
  writeDispatchState(stagingDir, {
    dispatch_id: dispatchId, op,
    state: res.ok ? 'CANDIDATE_RETURNED' : 'FAILED',
    created_at: new Date().toISOString(),
  })
  return { ...res, dispatch_id: dispatchId, staging_dir: stagingDir }
}
