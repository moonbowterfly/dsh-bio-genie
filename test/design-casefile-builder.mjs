// design-casefile-builder.mjs — B1-part-2 测试基建：用 A1/A2（design-casefile.js 生产路径）
// 构建真实 casefile + 不可变快照，供 pytest 与 TS 接线测试做 validate/export 门禁负例。
// 用法：node test/design-casefile-builder.mjs <workdir> <mode>
//   mode: clean | lite | r1 | r2 | r3 | r3b | r3c | dag_cycle
// 输出（stdout JSON）：{ workdir, case_dir, snapshot_sha, ids: {...} }
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  commitTransaction, deriveCaseContentId, ensureCaseDir, canonicalizeViaPacket,
} from '../src/design-casefile.js'
import { deriveAnnotationsForArtifact } from '../src/design-validate.js'

const CORPUS = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'design', 'packet', 'schema-corpus', 'schema_cases.json'), 'utf8'))
function findCase(id) {
  const c = CORPUS.cases.find((x) => x.id === id)
  if (!c) throw new Error('corpus case not found: ' + id)
  return c
}

const H64 = /^[0-9a-f]{64}$/
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const AR = (id) => ({ artifact_id: id, expected_sha256: id, relative_path: 'objects/' + id })

// 计算工件 id：与 A2 commitTransaction 同一 c14n 语义（id = sha256(canonical bytes)）
function computeId(stem, value) {
  const text = JSON.stringify(value)
  const ann = deriveAnnotationsForArtifact(stem, value)
  const out = canonicalizeViaPacket(text, ann)
  if (!out || out.ok !== true) throw new Error('c14n failed: ' + stem + ' ' + JSON.stringify(out).slice(0, 120))
  const id = sha256(Buffer.from(out.canonical, 'utf8'))
  if (!H64.test(id)) throw new Error('id not h64: ' + stem)
  return id
}

function clone(x) {
  return JSON.parse(JSON.stringify(x))
}

const MODES = new Set(['clean', 'lite', 'r1', 'r2', 'r3', 'r3b', 'r3c', 'dag_cycle'])

function build(mode, workdir) {
  if (!MODES.has(mode)) throw new Error('unknown mode: ' + mode)
  const cs = ensureCaseDir(workdir, 'validate-case')
  if (!cs.ok) throw new Error('ensureCaseDir failed: ' + JSON.stringify(cs))

  // ── 依赖序构造（先算无依赖工件 id，再回填引用）────────────────────
  const inputGenome = clone(findCase('ins-01').doc) // role=genome_sequence
  const inputSbml = clone(findCase('ins-01').doc)
  inputSbml.role = 'gem_card'
  inputSbml.format = 'sbml'
  inputSbml.consumer_compatibility = ['bio_circuit_contextualize', 'bio_consequence_run']
  const inputGenomeId = computeId('input_snapshot', inputGenome)
  const inputSbmlId = computeId('input_snapshot', inputSbml)

  const hostProfile = clone(findCase('hpf-01').doc)
  hostProfile.genome_ref = AR(inputGenomeId)
  const hostProfileId = computeId('host_profile', hostProfile)

  const conditionCard = clone(findCase('ccd-01').doc)
  const conditionCardId = computeId('condition_card', conditionCard)

  const evidenceItem = clone(findCase('evi-01').doc)
  const evidenceItemId = computeId('evidence_item', evidenceItem)

  const numericPolicy = clone(findCase('npo-01').doc)
  const numericPolicyId = computeId('numeric_policy', numericPolicy)

  const hostModelBinding = clone(findCase('hmb-01').doc)
  const hostModelBindingId = computeId('host_model_binding', hostModelBinding)

  const gemCardRaw = clone(findCase('gcr-01').doc)
  gemCardRaw.raw_bytes_ref = AR(inputSbmlId)
  const gemCardRawId = computeId('gem_card_raw', gemCardRaw)

  const kineticCrn = clone(findCase('kcr-01').doc)
  kineticCrn.sbml_ref = AR(inputSbmlId)
  const kineticCrnId = computeId('kinetic_crn_ref', kineticCrn)

  const metabolicModel = clone(findCase('mmr-01').doc)
  metabolicModel.sbml_ref = AR(gemCardRawId)
  metabolicModel.card.card_ref = AR(gemCardRawId)
  const metabolicModelId = computeId('metabolic_model_ref', metabolicModel)

  const gprProof = clone(findCase('gpr-01').doc)
  const gprProofId = computeId('gpr_proof', gprProof)

  // coupling_profile：规则回填全部真实引用
  const couplingProfile = clone(findCase('cpl-01').doc)
  for (const rule of couplingProfile.rules) {
    rule.model_ref = AR(metabolicModelId)
    rule.host_profile = AR(hostProfileId)
    rule.host_model_binding_ref = AR(hostModelBindingId)
    if (mode === 'r3') {
      rule.gpr_proof_ref = AR('f'.repeat(64)) // 断链：GPR mapping proof 缺失
    } else {
      rule.gpr_proof_ref = AR(gprProofId)
    }
    rule.condition_card_ref = AR(conditionCardId)
    rule.evidence_refs = mode === 'r3b' ? ['f'.repeat(64)] : [evidenceItemId]
    rule.assumption_refs = mode === 'r3c' ? ['f'.repeat(64)] : [conditionCardId]
  }
  const couplingProfileId = computeId('coupling_profile', couplingProfile)

  // consequence_run：回填引用；r1 用 kinetic_crn_ref 冒充 constraint_gem
  const consequenceRun = clone(findCase('csq-01').doc)
  consequenceRun.model_ref = AR(mode === 'r1' ? kineticCrnId : metabolicModelId)
  consequenceRun.coupling_ref = AR(couplingProfileId)
  consequenceRun.numeric_policy_ref = AR(numericPolicyId)
  consequenceRun.medium_ref = AR(conditionCardId)
  for (const sc of consequenceRun.scenarios) {
    if (mode === 'r2') sc.diffs[0].rule_id = 'rule-not-authorized' // 未授权 bound
    sc.medium_artifact_id = conditionCardId
    sc.mapping_proof_ids = [gprProofId]
  }
  const consequenceRunId = computeId('consequence_run', consequenceRun)

  // provenance_dag：dag_cycle 模式注入自环
  const dag = clone(findCase('pvd-01').doc)
  if (mode === 'dag_cycle') {
    const n1 = dag.nodes[0].id
    dag.edges.push({ from: n1, to: n1, kind: 'supports' })
    dag.dag_hash = 'e'.repeat(64)
  }
  const dagId = computeId('provenance_dag', dag)

  const ids = {
    input_genome: inputGenomeId,
    input_sbml: inputSbmlId,
    host_profile: hostProfileId,
    condition_card: conditionCardId,
    evidence_item: evidenceItemId,
    numeric_policy: numericPolicyId,
    host_model_binding: hostModelBindingId,
    gem_card_raw: gemCardRawId,
    kinetic_crn_ref: kineticCrnId,
    metabolic_model_ref: metabolicModelId,
    gpr_proof: gprProofId,
    coupling_profile: couplingProfileId,
    consequence_run: consequenceRunId,
    provenance_dag: dagId,
  }

  // ── 工件清单（lite 模式无 consequence/coupling/dag → R 检查 SKIP）──
  const artifacts = [
    { type: 'input_snapshot', value: inputGenome, producer: 'test', canonical_path: 'input-genome.json' },
    { type: 'input_snapshot', value: inputSbml, producer: 'test', canonical_path: 'input-sbml.json' },
    { type: 'host_profile', value: hostProfile, producer: 'test', canonical_path: 'host.json' },
    { type: 'condition_card', value: conditionCard, producer: 'test', canonical_path: 'medium.json' },
    { type: 'evidence_item', value: evidenceItem, producer: 'test', canonical_path: 'evidence.json' },
    { type: 'numeric_policy', value: numericPolicy, producer: 'test', canonical_path: 'numeric-policy.json' },
    { type: 'host_model_binding', value: hostModelBinding, producer: 'test', canonical_path: 'binding.json' },
    { type: 'gem_card_raw', value: gemCardRaw, producer: 'test', canonical_path: 'gem-card.json' },
    { type: 'kinetic_crn_ref', value: kineticCrn, producer: 'test', canonical_path: 'crn.json' },
    { type: 'metabolic_model_ref', value: metabolicModel, producer: 'test', canonical_path: 'gem-model.json' },
    { type: 'gpr_proof', value: gprProof, producer: 'test', canonical_path: 'gpr.json' },
  ]
  if (mode !== 'lite') {
    artifacts.push({ type: 'coupling_profile', value: couplingProfile, producer: 'test', canonical_path: 'coupling.json' })
    artifacts.push({ type: 'consequence_run', value: consequenceRun, producer: 'test', canonical_path: 'consequence.json' })
    artifacts.push({ type: 'provenance_dag', value: dag, producer: 'test', canonical_path: 'dag.json' })
  }

  const content = deriveCaseContentId({
    rootInputArtifactIds: [inputGenomeId, inputSbmlId],
    policyVersion: '0',
    canonicalParams: {},
  })
  if (!content.ok) throw new Error('deriveCaseContentId failed: ' + JSON.stringify(content))
  const policy = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: 'b'.repeat(64) }
  const tx = commitTransaction(cs, { caseContentId: content.case_content_id, policy, newArtifacts: artifacts })
  if (!tx.ok) throw new Error('commitTransaction failed: ' + JSON.stringify(tx).slice(0, 500))

  return { workdir, case_dir: cs.caseDir, snapshot_sha: tx.snapshot_sha, ids }
}

// ── CLI ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const outRoot = args[0] || mkdtempSync(join(tmpdir(), 'design-builder-'))
const mode = args[1] || 'clean'
mkdirSync(outRoot, { recursive: true })
const wd = join(outRoot, 'workdir')
mkdirSync(wd, { recursive: true })
try {
  const result = build(mode, wd)
  process.stdout.write(JSON.stringify(result) + '\n')
} catch (err) {
  process.stderr.write('builder error: ' + err.message + '\n')
  process.exit(1)
}
