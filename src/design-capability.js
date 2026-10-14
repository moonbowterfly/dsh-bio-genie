/**
 * dsh-bio-genie — capability policy resolver（A9a）
 *
 * hash-frozen 最小 capability policy bundle + default-deny resolver：
 *   - loadCapabilityPolicy：读取 policy + POLICY-HASH 冻结记录，每次全量核验 sha256（无缓存），
 *     不符即 fail-closed（POLICY_HASH_MISMATCH）。冻结模型与 packet gate 同款：记录自身
 *     不在本机制内自证——「内容 vs 冻结记录」一致性防意外/局部篡改；重新冻结须显式改两个文件。
 *   - resolveOperation：operation × input_state × coupling_mode × claim_target →
 *     {decision, max_tier, capabilities, classification_ceiling, reason_codes, required_artifacts}；
 *     规则按序首匹配（first-match-wins）；未匹配组合落 default（deny / UNKNOWN_COMBINATION）。
 *   - materializeTierDecision：一组解析结果 → tier_decision@1（policy_id/version/hash +
 *     input snapshot/artifact ids + per_operation[...] + gaps）。per_operation 按 operation 去重（首现优先）。
 * @module dsh-bio-genie/design-capability
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const POLICY_DIR = join(import.meta.dirname, '..', 'design', 'capability-policy')

const DIM_NAMES = ['operation', 'input_state', 'coupling_mode', 'claim_target']

/** 加载并核验 hash-frozen policy bundle。返回 {ok, policy, policy_sha256, policy_dir} 或 {ok:false, problems}。 */
export function loadCapabilityPolicy({ policyDir = POLICY_DIR } = {}) {
  const policyPath = join(policyDir, 'policy-v0.json')
  const hashPath = join(policyDir, 'POLICY-HASH.json')
  if (!existsSync(policyPath) || !existsSync(hashPath)) {
    return { ok: false, problems: ['policy files missing: ' + policyPath] }
  }
  const bytes = readFileSync(policyPath)
  const sha = createHash('sha256').update(bytes).digest('hex')
  let freeze
  try {
    freeze = JSON.parse(readFileSync(hashPath, 'utf8'))
  } catch (e) {
    return { ok: false, problems: ['POLICY-HASH unreadable: ' + String(e.message).slice(0, 80)] }
  }
  if (freeze.policy_sha256 !== sha) {
    return { ok: false, problems: ['POLICY_HASH_MISMATCH (disk=' + sha.slice(0, 16) + ' frozen=' + String(freeze.policy_sha256).slice(0, 16) + ')'] }
  }
  let policy
  try {
    policy = JSON.parse(bytes.toString('utf8'))
  } catch (e) {
    return { ok: false, problems: ['policy unreadable: ' + String(e.message).slice(0, 80)] }
  }
  if (!policy.dimensions || !Array.isArray(policy.rules) || !policy.default) {
    return { ok: false, problems: ['policy structure invalid'] }
  }
  return { ok: true, policy, policy_sha256: sha, policy_dir: policyDir }
}

function matches(rule, query) {
  for (const dim of DIM_NAMES) {
    const rv = rule[dim]
    if (rv === '*' || rv === undefined) continue
    if (rv !== query[dim]) return false
  }
  return true
}

/** 解析单个 operation 查询。未知组合 fail-closed（default deny）：
 *  任一维度值不在枚举内 → 不进入规则匹配，直接落 default（UNKNOWN_COMBINATION）。 */
export function resolveOperation(policy, query) {
  const q = {}
  for (const dim of DIM_NAMES) q[dim] = query[dim] === undefined ? 'none' : query[dim]
  const gates = []
  for (const dim of DIM_NAMES) {
    const enumVals = (policy.dimensions || {})[dim] || []
    const inEnum = enumVals.includes(q[dim])
    gates.push({ gate: dim, status: inEnum ? 'PASS' : 'FAIL', detail: String(q[dim]) })
  }
  let matched = -1
  let out = null
  const anyOutOfEnum = gates.some((g) => g.status === 'FAIL')
  if (!anyOutOfEnum) {
    for (let i = 0; i < policy.rules.length; i += 1) {
      if (matches(policy.rules[i], q)) {
        matched = i
        out = policy.rules[i]
        break
      }
    }
  }
  if (out === null) out = policy.default
  gates.push({ gate: 'policy_rule', status: out.decision === 'allow' ? 'PASS' : 'FAIL', detail: matched >= 0 ? 'rule[' + matched + ']' : 'default-deny' })
  return {
    operation: q.operation,
    input_state: q.input_state,
    coupling_mode: q.coupling_mode,
    claim_target: q.claim_target,
    decision: out.decision,
    max_tier: out.max_tier,
    capabilities: (out.capabilities || []).slice(),
    classification_ceiling: out.classification_ceiling || 'INFERENCE',
    reason_codes: (out.reason_codes || []).slice(),
    required_artifacts: (out.required_artifacts || []).slice(),
    matched_rule: matched,
    gates,
  }
}

/** 物化 tier_decision@1（schema 校验由调用方/validateDesignArtifact 负责）。 */
export function materializeTierDecision({ policy, policy_sha256, inputSnapshotId, inputArtifactIds = [], queries }) {
  const perOperation = []
  const seen = new Set()
  const gaps = []
  for (const query of queries) {
    const r = resolveOperation(policy, query)
    if (seen.has(r.operation)) continue
    seen.add(r.operation)
    perOperation.push({
      operation: r.operation,
      max_tier: r.max_tier,
      gates: r.gates,
      decision: r.decision,
      capabilities: r.capabilities,
      reason_codes: r.reason_codes,
    })
    if (r.decision !== 'allow') {
      for (const code of (r.reason_codes.length ? r.reason_codes : ['UNKNOWN_COMBINATION'])) {
        gaps.push('operation=' + r.operation + ': ' + code)
      }
    }
  }
  return {
    artifact_type: 'tier_decision@1',
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    policy_hash: policy_sha256,
    input_snapshot_id: inputSnapshotId,
    input_artifact_ids: inputArtifactIds.slice(),
    per_operation: perOperation,
    gaps,
  }
}
