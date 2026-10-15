// dsh-bio-genie — A5 failure matrix 验收（req G-LOOP-20261015-D5-001）
// 覆盖：
//  1) design/failure-matrix.json 结构验收：schema_version / matrix_id / fields /
//     branches[] 10 分支齐全（v0.2 §9 A5 全列，不得遗漏）；每分支 expected_status /
//     expected_reason / check_id 已填（v0.3 §9 强化，不只类别）；not_yet_runnable 一致性；
//  2) runnable 分支真实执行并断言 expected status/reason/check_id：
//     F01 malformed（consequence coupling_profile 非对象 → INVALID_INPUT）
//     F02 冲突输入（builder r1 → validate → R1_MODEL_REF_INVALID）
//     F03 ambiguous/unmapped（coupling rule 全 miss → NOT_RUN）
//     F04 solver infeasible（场景 biomass {10,10} → NOT_RUN/SCENARIO_INDETERMINATE）
//     F08 OSTIR unavailable（contextualize + ostir_request → DEPENDENCY_UNAVAILABLE/OSTIR_UNAVAILABLE）
//     F09 validate 后工件被改（tamper → INVALID_INPUT/OBJECT_HASH_MISMATCH）
//     F10 export-validate TOCTOU（validate 后篡改窗口 → INVALID_INPUT/VALIDATE_GATE_FAILED）
//  3) not_yet_runnable 分支（F05/F06/F07）登记完整性断言（planned + note 原因）。
// 复用优先：既有覆盖分支（F02/F03/F04）test_ref 指向既有执行位置，本测试仍复跑以自包含。
// 外置资产：iML1515（reference bundle）；不可用时 F01/F03/F04 skip（fail-closed 口径，
// 照 test/test_design_consequence.py / design-consequence-tools.mjs 现行语义）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerTools } from '../src/tools.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUILDER = join(ROOT, 'test', 'design-casefile-builder.mjs')
const MATRIX_PATH = join(ROOT, 'design', 'failure-matrix.json')
const home = process.env.USERPROFILE || process.env.HOME
const VENV = process.env.DSH_BIO_PYTHON || join(home, '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe')

const IML = process.env.DESIGN_TEST_IML1515
  || 'D:\\Program\\dsh-plug-develop\\genie-synbio-design-20261012\\reference\\iML1515.xml'
const IML_SHA = '9c772d44ca43350e40dc7ee86c7aa148796856be1eea45e5406c6df8f7dcde28'
const BIOMASS = 'BIOMASS_Ec_iML1515_core_75p37M'
const IML_AVAILABLE = existsSync(IML)

let pass = 0
let fail = 0
let skip = 0
const roots = []
function check(name, actual, detail = '') {
  if (actual) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
function skipNote(name) {
  skip += 1
  console.log('  SKIP ' + name + '（iML1515 外置资产不可用）')
}
function workdir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix || 'design-failure-matrix-'))
  roots.push(d)
  return d
}
function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}
function readdirSafe(dir) {
  return readdirSync(dir).filter((n) => !n.startsWith('.'))
}
function buildCase(mode, outDir) {
  const r = spawnSync(process.execPath, [BUILDER, outDir, mode], { encoding: 'utf8', timeout: 300_000 })
  if (r.status !== 0) throw new Error('builder failed: ' + (r.stderr || r.stdout))
  return JSON.parse(r.stdout.trim())
}
function register() {
  const tools = {}
  const ctx = { tools: { register: (t) => { tools[t.name] = t; return () => {} } } }
  registerTools(ctx, { enableLog: false, pythonPath: VENV })
  return tools
}
const exec = (cwd) => ({ signal: new AbortController().signal, agent: { session: { header: { cwd } } } })
const run = async (tool, args, cwd) => {
  try {
    const v = await tool.execute(args, exec(cwd))
    return { threw: false, value: v }
  } catch (e) {
    return { threw: true, status: e.status, code: e.code, envelope: e.envelope, message: String(e.message) }
  }
}
const ENV_PACKET = () => ({
  ...process.env,
  DSH_DESIGN_PACKET: '',
  DSH_DESIGN_PACKET_FIXED: join(ROOT, 'design', 'packet'),
})
function cardFile(dir) {
  const p = join(dir, 'card.json')
  writeFileSync(p, JSON.stringify({ schema_version: 'v0-test', model_sha256: IML_SHA }), 'utf8')
  return p
}
function flattenModelRef(args) {
  const { model_ref: mr, ...rest } = args
  return { ...rest, ...(mr || {}) }
}
function spawnWorker(worker, payload, opts = {}) {
  return spawnSync(VENV, ['-I', join(ROOT, 'python', worker)], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: opts.timeout || 240_000,
    env: opts.env || ENV_PACKET(),
  })
}

// ── 1) matrix.json 结构验收 ─────────────────────────────────────────────
{
  const m = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'))
  check('matrix schema_version/matrix_id 齐备', m.schema_version === '1.0' && m.matrix_id === 'design-failure-matrix@1')
  const requiredFields = ['branch_id', 'category', 'injection', 'expected_status', 'expected_reason', 'check_id', 'test_ref', 'not_yet_runnable', 'note']
  check('fields 含全部必需字段', requiredFields.every((f) => m.fields.includes(f)))
  check('branches 为数组且恰 10 分支（v0.2 §9 A5 全列）', Array.isArray(m.branches) && m.branches.length === 10)
  const cats = new Set(m.branches.map((b) => b.category))
  check('10 类别齐全（malformed/冲突/ambiguous/solver×4/OSTIR/篡改/TOCTOU）',
    ['malformed-input', 'conflicting-input', 'ambiguous-unmapped', 'solver-infeasible',
      'solver-unbounded', 'solver-non-optimal', 'solver-timeout', 'ostir-unavailable',
      'validate-after-tamper', 'export-validate-toctou'].every((c) => cats.has(c)))
  check('expected_status ∈ 状态词表', m.branches.every((b) => m.expected_status_vocab.includes(b.expected_status)))
  check('每分支 expected_status/expected_reason/check_id/test_ref 非空（v0.3 强化）',
    m.branches.every((b) => b.expected_status && b.expected_reason && b.check_id && b.test_ref))
  check('not_yet_runnable 与 injection.kind 一致', m.branches.every((b) =>
    (b.not_yet_runnable === true) === (b.injection?.kind === 'not_yet_runnable')))
  check('not_yet_runnable 分支带 planned + note（F05/F06/F07）',
    m.branches.filter((b) => b.not_yet_runnable).every((b) => b.target_gate?.planned && b.note))
}

// ── 2) runnable 分支真实执行 ────────────────────────────────────────────
// F02 冲突输入：builder r1 → validate → INVALID_INPUT/R1_MODEL_REF_INVALID
{
  const wd = workdir('fm-f02-')
  const r1 = buildCase('r1', join(wd, 'case'))
  const r = spawnWorker('design_casefile.py', { op: 'design_casefile_validate', args: { casefile_dir: r1.case_dir } })
  const envl = JSON.parse(r.stdout.trim() || '{}')
  check('F02 冲突输入 → INVALID_INPUT（红线 R1 拒绝）', envl.status === 'INVALID_INPUT', r.stdout.slice(0, 160))
  check('F02 reason=R1_MODEL_REF_INVALID（check_id R1_CRN_NEQ_GEM）',
    envl.reason_code === 'R1_MODEL_REF_INVALID'
    && Array.isArray(envl.checks) && envl.checks.some((c) => c.check_id === 'R1_CRN_NEQ_GEM' && c.status === 'FAIL'),
    r.stdout.slice(0, 160))
}

// F08 OSTIR unavailable：real designTool 通道（chassis → host_profile_ref → contextualize + ostir_request）
{
  const wd = workdir('fm-f08-')
  const tools = register()
  const fixture = join(ROOT, 'test', 'fixtures', 'design')
  const chassisArgs = {
    genome_files: [
      { path: join(fixture, 'fixture_circular.fna'), format: 'fasta', sha256: sha256File(join(fixture, 'fixture_circular.fna')) },
      { path: join(fixture, 'fixture_features.tsv'), format: 'segments_tsv', sha256: sha256File(join(fixture, 'fixture_features.tsv')) },
    ],
    coord_convention: '0-based-half-open',
    contig_topology: { synth_circ_4200: 'circular' },
  }
  const c = await run(tools.bio_chassis_profile, chassisArgs, wd)
  const hpRef = c.threw === false ? c.value.artifact_refs.find((ref) => ref.relative_path === 'host_profile.json') : null
  check('F08 前置：chassis 产出 host_profile ref（真实对象）', Boolean(hpRef), c.message)
  if (hpRef) {
    const o = await run(tools.bio_circuit_contextualize, {
      circuit: { components: [{ component_id: 'P1', kind: 'promoter' }] },
      host_profile_ref: hpRef,
      ostir_request: { sequence: 'AGCU' },
    }, wd)
    check('F08 OSTIR unavailable → DEPENDENCY_UNAVAILABLE/OSTIR_UNAVAILABLE（preflight 不静默降级）',
      o.threw && o.status === 'DEPENDENCY_UNAVAILABLE' && o.code === 'OSTIR_UNAVAILABLE', o.message)
    check('F08 FAIL 信封挂 err.envelope（C4 键齐备）', o.envelope && ['status', 'reason_code', 'artifact_refs', 'detail'].every((k) => Object.hasOwn(o.envelope, k)))
  }
}

// F09 validate 后工件被改：validate OK → tamper → validate → INVALID_INPUT/OBJECT_HASH_MISMATCH
{
  const wd = workdir('fm-f09-')
  const clean = buildCase('clean', join(wd, 'case'))
  const v1 = spawnWorker('design_casefile.py', { op: 'design_casefile_validate', args: { casefile_dir: clean.case_dir } })
  const e1 = JSON.parse(v1.stdout.trim() || '{}')
  check('F09 前置：clean case validate OK', e1.status === 'OK', v1.stdout.slice(0, 160))
  const objectsDir = join(clean.case_dir, 'objects')
  const target = readdirSafe(objectsDir)[0]
  const orig = readFileSync(join(objectsDir, target))
  writeFileSync(join(objectsDir, target), Buffer.concat([orig, Buffer.from(' ', 'utf8')]))
  const v2 = spawnWorker('design_casefile.py', { op: 'design_casefile_validate', args: { casefile_dir: clean.case_dir } })
  const e2 = JSON.parse(v2.stdout.trim() || '{}')
  check('F09 validate 后工件被改 → INVALID_INPUT（MANIFEST_DISK_HASH 重校验）', e2.status === 'INVALID_INPUT', v2.stdout.slice(0, 160))
  check('F09 reason=OBJECT_HASH_MISMATCH（check_id MANIFEST_DISK_HASH）',
    e2.reason_code === 'OBJECT_HASH_MISMATCH'
    && Array.isArray(e2.checks) && e2.checks.some((c) => c.check_id === 'MANIFEST_DISK_HASH' && c.status === 'FAIL'),
    v2.stdout.slice(0, 160))
  check('F09 恢复后 validate 复绿（篡改被检出，无缓存）', (() => {
    writeFileSync(join(objectsDir, target), orig)
    const v3 = spawnWorker('design_casefile.py', { op: 'design_casefile_validate', args: { casefile_dir: clean.case_dir } })
    return JSON.parse(v3.stdout.trim() || '{}').status === 'OK'
  })())
}

// F10 export-validate TOCTOU：validate OK → 篡改窗口 → export → VALIDATE_GATE_FAILED
{
  const wd = workdir('fm-f10-')
  const clean = buildCase('clean', join(wd, 'case'))
  const v1 = spawnWorker('design_casefile.py', { op: 'design_casefile_validate', args: { casefile_dir: clean.case_dir } })
  check('F10 前置：clean case validate OK', JSON.parse(v1.stdout.trim() || '{}').status === 'OK', v1.stdout.slice(0, 160))
  const objectsDir = join(clean.case_dir, 'objects')
  const target = readdirSafe(objectsDir)[0]
  const orig = readFileSync(join(objectsDir, target))
  writeFileSync(join(objectsDir, target), Buffer.concat([orig, Buffer.from(' ', 'utf8')]))
  const x = spawnWorker('design_casefile.py', { op: 'design_casefile_export', args: { casefile_dir: clean.case_dir, format: 'both' } })
  const xe = JSON.parse(x.stdout.trim() || '{}')
  check('F10 TOCTOU → INVALID_INPUT/VALIDATE_GATE_FAILED（export 重跑门闭合）',
    xe.status === 'INVALID_INPUT' && xe.reason_code === 'VALIDATE_GATE_FAILED', x.stdout.slice(0, 160))
  check('F10 无产物（artifact_refs 为空，不产出部分结果）', Array.isArray(xe.artifact_refs) && xe.artifact_refs.length === 0, x.stdout.slice(0, 160))
  check('F10 科学快照未变（HEAD 仍指向原快照）',
    JSON.parse(readFileSync(join(clean.case_dir, 'HEAD.json'), 'utf8')).snapshot_sha === clean.snapshot_sha)
}

// F01 malformed 输入（schema/c14n 级）——consequence coupling_profile 非对象
// F03 ambiguous/unmapped ——coupling rule 全 miss → NOT_RUN
// F04 solver infeasible ——场景 biomass {10,10} → NOT_RUN/SCENARIO_INDETERMINATE
if (!IML_AVAILABLE) {
  skipNote('F01 malformed 输入（consequence 分支）')
  skipNote('F03 ambiguous/unmapped（consequence 分支）')
  skipNote('F04 solver infeasible（consequence 分支）')
} else {
  {
    const wd = workdir('fm-f01-')
    const card = cardFile(wd)
    const base = flattenModelRef({ model_ref: { sbml_path: IML, expected_sbml_sha256: IML_SHA, card_path: card }, medium: [], coupling_profile: { rules: [{ rule_id: 'r1', reaction_id: 'EX_glc__D_e', operation: 'set_lower_bound', derived_bound: -5 }] }, scenarios: [{ scenario_id: 's1', target_reaction: BIOMASS }] })
    const r = spawnWorker('design_consequence.py', { op: 'design_consequence', args: { ...base, coupling_profile: 'not-an-object' } })
    const e = JSON.parse(r.stdout.trim() || '{}')
    check('F01 malformed 输入 → exit 0 + ok:false + INVALID_INPUT（门禁拒绝非崩溃）', r.status === 0 && e.ok === false && e.status === 'INVALID_INPUT', r.stdout.slice(0, 160))
    check('F01 reason=INVALID_INPUT（coupling_profile 类型门，detail 无前缀回落 status）', e.reason_code === 'INVALID_INPUT', r.stdout.slice(0, 160))
  }
  {
    const wd = workdir('fm-f03-')
    const card = cardFile(wd)
    const base = flattenModelRef({ model_ref: { sbml_path: IML, expected_sbml_sha256: IML_SHA, card_path: card }, medium: [], coupling_profile: { rules: [{ rule_id: 'r1', reaction_id: 'EX_NOT_IN_MODEL', operation: 'set_lower_bound', derived_bound: -5 }] }, scenarios: [{ scenario_id: 's1', target_reaction: BIOMASS }] })
    const r = spawnWorker('design_consequence.py', { op: 'design_consequence', args: base })
    const e = JSON.parse(r.stdout.trim() || '{}')
    check('F03 unmapped → NOT_RUN（rule 全 miss，禁猜映射）', r.status === 0 && e.status === 'NOT_RUN', r.stdout.slice(0, 160))
    check('F03 reason=NOT_RUN + 无 applied rules（无映射证据不产出）',
      e.reason_code === 'NOT_RUN' && (!e.consequence_run?.applied_rule_ids || e.consequence_run.applied_rule_ids.length === 0), r.stdout.slice(0, 160))
  }
  {
    const wd = workdir('fm-f04-')
    const card = cardFile(wd)
    const base = flattenModelRef({ model_ref: { sbml_path: IML, expected_sbml_sha256: IML_SHA, card_path: card }, medium: [], coupling_profile: { rules: [{ rule_id: 'r1', reaction_id: 'EX_glc__D_e', operation: 'set_lower_bound', derived_bound: -5 }] }, scenarios: [{ scenario_id: 's1', target_reaction: BIOMASS, modifications: [{ reaction_id: BIOMASS, lower_bound: 10.0, upper_bound: 10.0 }] }] })
    const r = spawnWorker('design_consequence.py', { op: 'design_consequence', args: base })
    const e = JSON.parse(r.stdout.trim() || '{}')
    check('F04 solver infeasible → NOT_RUN + SCENARIO_INDETERMINATE（禁止挑选剩余场景）',
      r.status === 0 && e.status === 'NOT_RUN' && e.reason_code === 'SCENARIO_INDETERMINATE', r.stdout.slice(0, 160))
    check('F04 相关 claim INDETERMINATE（不得 ROBUST_DIRECTION）',
      Array.isArray(e.consequence_run?.claims) && e.consequence_run.claims.every((c) => c.status === 'INDETERMINATE'), r.stdout.slice(0, 160))
  }
}

// ── 3) not_yet_runnable 分支登记完整性（F05/F06/F07）────────────────────
{
  const m = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'))
  const ny = m.branches.filter((b) => b.not_yet_runnable).map((b) => b.branch_id)
  check('not_yet_runnable 恰为 F05/F06/F07（unbounded/non-optimal/timeout）',
    JSON.stringify(ny.sort()) === JSON.stringify(['F05', 'F06', 'F07']))
  check('F05 登记：expected NOT_RUN + 实测证据 note（cobra inf 归一化）',
    m.branches.find((b) => b.branch_id === 'F05')?.expected_status === 'NOT_RUN'
    && /inf|归一/.test(m.branches.find((b) => b.branch_id === 'F05').note))
  check('F07 登记：expected NOT_RUN + 实测证据 note（无 time_limit 透传）',
    m.branches.find((b) => b.branch_id === 'F07')?.expected_status === 'NOT_RUN'
    && /time_limit|透传/.test(m.branches.find((b) => b.branch_id === 'F07').note))
}

for (const root of roots) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* cleanup does not change verdict */ }
}
console.log(`design-failure-matrix: ${pass} passed, ${skip} skipped, ${fail} failed`)
if (fail) process.exit(1)
