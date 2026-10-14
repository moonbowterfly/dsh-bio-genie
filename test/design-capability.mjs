// dsh-bio-genie — capability policy 测试（A9a）
// 运行：node test/design-capability.mjs
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCapabilityPolicy, materializeTierDecision, resolveOperation } from '../src/design-capability.js'
import { validateDesignArtifact } from '../src/design-validate.js'

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log('  PASS ' + name)
  } else {
    fail += 1
    console.log('  FAIL ' + name + ' ' + detail)
  }
}

const loaded = loadCapabilityPolicy()
check('policy 加载 + hash 冻结核验', loaded.ok === true, JSON.stringify(loaded.problems || []))
if (!loaded.ok) {
  console.log('design-capability: %d passed, %d failed', pass, fail)
  process.exit(1)
}
const { policy, policy_sha256 } = loaded

const R = (q) => resolveOperation(policy, q)
const Q = (operation, input_state, coupling_mode = 'none', claim_target = 'none') => ({ operation, input_state, coupling_mode, claim_target })

// ── 1) 真值表行（v0.3 §3.1 五行语义）────────────────────────────────
let r = R(Q('sequence_qc', 'reference_complete'))
check('T1 reference_complete × sequence_qc -> allow / reference_profile / FACT',
  r.decision === 'allow' && r.max_tier === 'reference_profile' && r.classification_ceiling === 'FACT', JSON.stringify(r))

r = R(Q('site_screening', 'missing_condition'))
check('T2 missing_condition × site_screening -> allow / structural_only',
  r.decision === 'allow' && r.max_tier === 'structural_only' && r.capabilities.includes('site_screening:structural'), JSON.stringify(r))

r = R(Q('expression', 'missing_condition'))
check('T3 missing_condition × expression -> proxy 仅（ASSUMPTION）',
  r.decision === 'allow' && r.capabilities.includes('expression_proxy') && r.classification_ceiling === 'ASSUMPTION' && r.reason_codes.includes('PROXY_ONLY'), JSON.stringify(r))

r = R(Q('consequence_quantitative', 'missing_condition', 'evidence_calibrated_bound', 'growth'))
check('T4 missing_condition × consequence_quantitative -> deny CONDITION_MISSING',
  r.decision === 'deny' && r.reason_codes.includes('CONDITION_MISSING'), JSON.stringify(r))

r = R(Q('consequence_quantitative', 'user_calibrated_only', 'user_calibrated_bound', 'product'))
check('T5 user_calibrated_only × consequence_quantitative -> allow（ceiling=ASSUMPTION）',
  r.decision === 'allow' && r.classification_ceiling === 'ASSUMPTION' && r.capabilities.includes('consequence_quantitative:user_calibrated'), JSON.stringify(r))

r = R(Q('consequence_quantitative', 'consequence_only', 'evidence_calibrated_bound', 'reaction'))
check('T6 consequence_only × consequence_quantitative -> allow（reference_profile）',
  r.decision === 'allow' && r.max_tier === 'reference_profile', JSON.stringify(r))

r = R(Q('sequence_qc', 'consequence_only'))
check('T7 consequence_only × sequence_qc -> deny INPUT_STATE_MISMATCH',
  r.decision === 'deny' && r.reason_codes.includes('INPUT_STATE_MISMATCH'), JSON.stringify(r))

r = R(Q('site_screening', 'missing_annotation'))
check('T8 missing_annotation × site_screening -> deny ANNOTATION_MISSING',
  r.decision === 'deny' && r.reason_codes.includes('ANNOTATION_MISSING'), JSON.stringify(r))

// ── 2) 红线与守卫 ────────────────────────────────────────────────────
r = R(Q('consequence_quantitative', 'reference_complete', 'qualitative_direction', 'growth'))
check('T9 qualitative_direction × quantitative -> deny COUPLING_MODE_NOT_QUANTITATIVE',
  r.decision === 'deny' && r.reason_codes.includes('COUPLING_MODE_NOT_QUANTITATIVE'), JSON.stringify(r))

r = R(Q('consequence_quantitative', 'reference_complete', 'evidence_calibrated_bound', 'none'))
check('T10 consequence × claim_target=none -> deny CLAIM_TARGET_REQUIRED',
  r.decision === 'deny' && r.reason_codes.includes('CLAIM_TARGET_REQUIRED'), JSON.stringify(r))

r = R(Q('consequence_quantitative', 'reference_complete', 'none', 'growth'))
check('T11 consequence × mode=none -> deny COUPLING_MODE_REQUIRED',
  r.decision === 'deny' && r.reason_codes.includes('COUPLING_MODE_REQUIRED'), JSON.stringify(r))

// ── 3) 未知组合 fail-closed ─────────────────────────────────────────
r = R(Q('bogus_operation', 'reference_complete'))
check('T12 未知 operation -> default deny UNKNOWN_COMBINATION',
  r.decision === 'deny' && r.reason_codes.includes('UNKNOWN_COMBINATION') && r.matched_rule === -1, JSON.stringify(r))

r = R(Q('sequence_qc', 'weird_state'))
check('T13 未知 input_state -> default deny', r.decision === 'deny' && r.matched_rule === -1, JSON.stringify(r))

r = R(Q('consequence_qualitative', 'reference_complete', 'bogus_mode', 'growth'))
check('T14 未知 coupling_mode -> default deny', r.decision === 'deny' && r.matched_rule === -1, JSON.stringify(r))

// ── 4) 穷尽不变量 sweep（全枚举组合）────────────────────────────────
{
  const ops = policy.dimensions.operation
  const states = policy.dimensions.input_state
  const modes = policy.dimensions.coupling_mode
  const targets = policy.dimensions.claim_target
  let n = 0
  let bad = 0
  for (const o of ops) {
    for (const s of states) {
      for (const m of modes) {
        for (const t of targets) {
          n += 1
          const rr = R({ operation: o, input_state: s, coupling_mode: m, claim_target: t })
          const okDecision = rr.decision === 'allow' || rr.decision === 'deny'
          const okReason = rr.decision !== 'deny' || rr.reason_codes.length > 0
          const okCaps = rr.decision !== 'allow' || rr.capabilities.length > 0
          const okCeiling = ['FACT', 'ASSUMPTION', 'INFERENCE'].includes(rr.classification_ceiling)
          const okTier = policy.tiers.includes(rr.max_tier)
          const okGates = rr.gates.length === 5
          if (!(okDecision && okReason && okCaps && okCeiling && okTier && okGates)) bad += 1
        }
      }
    }
  }
  check('T15 穷尽 sweep（' + n + ' 组合）不变量全过', bad === 0, 'bad=' + bad)
}

// ── 5) tier_decision@1 物化 + schema 校验 + 确定性 ──────────────────
{
  const mk = () => materializeTierDecision({
    policy,
    policy_sha256,
    inputSnapshotId: 'a'.repeat(64),
    inputArtifactIds: ['b'.repeat(64), 'c'.repeat(64)],
    queries: [
      { operation: 'sequence_qc', input_state: 'reference_complete', coupling_mode: 'none', claim_target: 'none' },
      { operation: 'consequence_quantitative', input_state: 'missing_condition', coupling_mode: 'evidence_calibrated_bound', claim_target: 'growth' },
    ],
  })
  const td = mk()
  const v = validateDesignArtifact('tier_decision', td)
  check('T16 tier_decision 物化 -> packet schema 校验通过', v.ok === true, JSON.stringify(v.errors || []).slice(0, 300))
  check('T17 policy_hash 与冻结 hash 一致', td.policy_hash === policy_sha256)
  check('T18 deny 进入 gaps', td.gaps.some((g) => g.includes('CONDITION_MISSING')), JSON.stringify(td.gaps))
  check('T19 确定性：两次物化逐字节一致', JSON.stringify(td) === JSON.stringify(mk()))
}

// ── 6) hash 冻结负测（篡改 -> fail-closed）──────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'cap-policy-'))
  cpSync(join(import.meta.dirname, '..', 'design', 'capability-policy'), dir, { recursive: true })
  const p = join(dir, 'policy-v0.json')
  const s = readFileSync(p, 'utf8')
  writeFileSync(p, s.replace('"policy_version": "0"', '"policy_version": "X"'), 'utf8')
  const l1 = loadCapabilityPolicy({ policyDir: dir })
  check('T20 policy 篡改 -> POLICY_HASH_MISMATCH fail-closed',
    l1.ok === false && String(l1.problems[0]).includes('POLICY_HASH_MISMATCH'), JSON.stringify(l1.problems))
  rmSync(dir, { recursive: true, force: true })
}

console.log('design-capability: %d passed, %d failed', pass, fail)
process.exit(fail === 0 ? 0 : 1)
