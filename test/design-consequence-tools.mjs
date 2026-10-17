// dsh-bio-genie — B1 收口批次 TS 接线/负测（req G-LOOP-20261015-CQWIRE-001）
// 覆盖：
//  1) src/tools.js 注册 design_consequence（designTool 通道；六工具之四），
//     op ∈ DESIGN_OPS（design 通道白名单）+ DESIGN_TOOL_OPS ⊆ DESIGN_OPS；
//     params 照设计稿 §1（model_ref/coupling_profile/medium 必填、objective 默认 biomass、
//     scenarios 必填、casefile_dir 可选、strict 默认 true）；
//  2) 双向验收：TS opts.op ↔ python/bio_ops.py OPS（design 通道 dispatcher）；
//  3) 真实工具 execute（standalone，无 casefile）：扁平 C4 信封契约
//     {status, reason_code, artifact_refs[], detail}（先取 res 再回退 stdout，B1P2 修复同样生效）；
//     OK 态 consequence_run 落盘 <cwd>/.design-staging/design_consequence/consequence_run.json
//     + sha 引用（B1P1 artifacts 模式）；门禁负例：sbml 缺失 → BLOCKED / 哈希不符 → INVALID_INPUT /
//     场景 infeasible → NOT_RUN + SCENARIO_INDETERMINATE（禁止挑选剩余场景）；
//  4) unknown op 负例：design_consequence.py dispatcher 拒绝（exit 2 + INVALID_INPUT/UNKNOWN_OP）；
//  5) 确定性：同输入两跑输出一致（C4 键 + 落盘字节）；
//  6) B2 终态：全量六 op 双向断言（TS 六工具注册 ↔ dispatcher OPS 六项一一对应）。
// 外置资产：iML1515（reference bundle，不入仓）；不可用时 §3/§5 skip（fail-closed 语义，
// 照 test/test_design_consequence.py 现行口径），§1/§2/§4/§6 仍全量执行。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESIGN_TOOL_OPS, registerTools } from '../src/tools.js'
import { DESIGN_OPS } from '../src/design-ops.js'
import { cleanVenvEnv } from './clean-venv-env.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const home = process.env.USERPROFILE || process.env.HOME
const VENV = process.env.DSH_BIO_PYTHON || join(home, '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe')
const PY = join(ROOT, 'python')

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
function workdir() {
  const d = mkdtempSync(join(tmpdir(), 'design-consequence-tools-'))
  roots.push(d)
  return d
}
function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}
function pythonEval(code) {
  const r = spawnSync(VENV, ['-c', code], { encoding: 'utf8', cwd: ROOT, timeout: 120_000, env: cleanVenvEnv() })
  if (r.status !== 0) throw new Error('pythonEval failed: ' + (r.stderr || r.stdout))
  return r.stdout.trim()
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
// 照 test/test_design_consequence.py 的 _good_args（v0 核心链正路径）
function goodArgs(cardPath) {
  return {
    model_ref: { sbml_path: IML, expected_sbml_sha256: IML_SHA, card_path: cardPath },
    medium: [],
    coupling_profile: { rules: [{ rule_id: 'r1', reaction_id: 'EX_glc__D_e', operation: 'set_lower_bound', derived_bound: -5 }] },
    scenarios: [{ scenario_id: 'glc5', target_reaction: BIOMASS }],
  }
}
// raw worker 入口不吃 model_ref（TS 桥展平）；直接给顶层 sbml_path/card_path（照 pytest _good_args）
function flattenModelRef(args) {
  const { model_ref: mr, ...rest } = args
  return { ...rest, ...(mr || {}) }
}

const SIX_TOOLS = [
  { name: 'bio_chassis_profile', op: 'design_chassis_profile' },
  { name: 'bio_integration_candidates', op: 'design_integration_candidates' },
  { name: 'bio_circuit_contextualize', op: 'design_circuit_contextualize' },
  { name: 'design_consequence', op: 'design_consequence' },
  { name: 'design_casefile_validate', op: 'design_casefile_validate' },
  { name: 'design_casefile_export', op: 'design_casefile_export' },
]
const SIX_OPS = SIX_TOOLS.map((t) => t.op)

// ── 1) 注册与白名单 ─────────────────────────────────────────────────────
{
  const tools = register()
  check('design_consequence 已注册', typeof tools.design_consequence?.execute === 'function')
  check('op ∈ DESIGN_OPS（design 通道白名单）', DESIGN_OPS.has('design_consequence'))
  check('DESIGN_TOOL_OPS ⊆ DESIGN_OPS', DESIGN_TOOL_OPS.every((op) => DESIGN_OPS.has(op)))
  const p = tools.design_consequence?.parameters?.properties
  const req = tools.design_consequence?.parameters?.required
  check('参数照设计稿 §1（七参数声明）', Boolean(p?.model_ref && p?.coupling_profile && p?.medium
    && p?.objective && p?.scenarios && p?.casefile_dir && p?.strict))
  check('model_ref/coupling_profile/medium 必填 + scenarios 必填',
    ['model_ref', 'coupling_profile', 'medium', 'scenarios'].every((k) => Array.isArray(req) && req.includes(k)))
  check('objective 默认 biomass + strict 默认 true + casefile_dir 可选', p?.objective?.default === 'biomass'
    && p?.strict?.default === true && p?.casefile_dir?.required !== true)
  check('描述含触发词（设计后果/consequence/耦合后果推理/growth 方向预测）',
    ['设计后果', 'consequence', '耦合后果推理', 'growth 方向预测'].every((w) =>
      tools.design_consequence.description.includes(w)))
}

// ── 2) 双向验收：TS opts.op ↔ python dispatcher OPS（bio_ops.py）─────────
{
  const pyOps = pythonEval(
    'import sys; sys.path.insert(0, r"' + PY.replaceAll('\\', '\\\\') + '"); from bio_ops import OPS; ' +
    'print(",".join(sorted(k for k in OPS if k.startswith("design_"))))')
  const pyOpsSet = new Set(pyOps.split(','))
  check('python dispatcher OPS 含 design_consequence', pyOpsSet.has('design_consequence'))
  check('TS op ∈ dispatcher OPS（双向验收）', SIX_OPS.every((op) => pyOpsSet.has(op)))
  check('dispatcher OPS 无超出六 op 的 design 项（双向验收）',
    [...pyOpsSet].every((op) => SIX_OPS.includes(op) || op === 'design_stage_artifact'))
}

// ── 3) 真实 execute 路径：C4 信封契约（OK 态 + 门禁负例，standalone）───────
if (!IML_AVAILABLE) {
  skipNote('OK execute → 扁平 C4 信封（status OK）')
  skipNote('consequence_run 落盘 + sha 引用（B1P1 artifacts 模式）')
  skipNote('sbml 缺失 → BLOCKED（门禁负例）')
  skipNote('哈希不符 → INVALID_INPUT（门禁负例）')
  skipNote('场景 infeasible → NOT_RUN/SCENARIO_INDETERMINATE（禁止挑选剩余场景）')
} else {
  const wd = workdir()
  const cardPath = cardFile(wd)
  const tools = register()
  const r = await run(tools.design_consequence, goodArgs(cardPath), wd)
  check('OK execute → 不抛错且 status OK', r.threw === false && r.value.status === 'OK', r.message)
  const v = r.value
  check('扁平 C4 信封键齐备（OK 态）', ['status', 'reason_code', 'artifact_refs', 'detail'].every((k) => Object.hasOwn(v, k))
    && Array.isArray(v.artifact_refs) && v.artifact_refs.length === 1)
  check('信封提取「先取 res」（B1P2 修复同样生效）：top-level status 直取', r.threw === false && typeof v.status === 'string')
  const ref = v.artifact_refs[0]
  check('artifact_refs 为 B1P1 形态 {artifact_id, expected_sha256, relative_path}',
    ref && typeof ref.artifact_id === 'string' && ref.artifact_id.length === 64
    && ref.artifact_id === ref.expected_sha256 && ref.relative_path === 'consequence_run.json')
  const staged = join(wd, '.design-staging', 'design_consequence', 'consequence_run.json')
  check('consequence_run 已落盘 staging（B1P1 artifacts 模式）', existsSync(staged))
  check('落盘字节 sha 与引用一致（自报 sha 可复算）',
    existsSync(staged) && sha256File(staged) === ref.artifact_id)
  const runValue = JSON.parse(readFileSync(staged, 'utf8'))
  check('consequence_run@1 含 baseline 锚点（0.876997 冻结锚点）',
    Math.abs(runValue.baseline?.objective_value - 0.876997) < 1e-5)
  check('applied_rule_ids 正确（r1 已施加）', Array.isArray(runValue.applied_rule_ids) && runValue.applied_rule_ids.includes('r1'))
  check('provenance 已盖戳（OK 态）', v._provenance && typeof v._provenance === 'object')
  check('无 casefile → 无 case_context', v.case_context === undefined)

  // 门禁负例：BLOCKED / INVALID_INPUT / 场景 INDETERMINATE
  const rB = await run(tools.design_consequence, {
    ...goodArgs(cardPath),
    model_ref: { sbml_path: 'Z:/nope.xml', expected_sbml_sha256: IML_SHA, card_path: cardPath },
  }, wd)
  check('sbml 缺失 → BLOCKED（门禁负例，exit 0 非崩溃）', rB.threw && rB.status === 'BLOCKED', rB.message)
  const rI = await run(tools.design_consequence, {
    ...goodArgs(cardPath),
    model_ref: { sbml_path: IML, expected_sbml_sha256: '0'.repeat(64), card_path: cardPath },
  }, wd)
  check('哈希不符 → INVALID_INPUT（门禁负例）', rI.threw && rI.status === 'INVALID_INPUT', rI.message)
  const rN = await run(tools.design_consequence, {
    ...goodArgs(cardPath),
    scenarios: [{ scenario_id: 'forced-infeasible', modifications: [{ reaction_id: BIOMASS, lower_bound: 10.0, upper_bound: 10.0 }] }],
  }, wd)
  check('场景 infeasible → NOT_RUN + SCENARIO_INDETERMINATE（禁止挑选剩余场景）',
    rN.threw && rN.status === 'NOT_RUN' && rN.code === 'SCENARIO_INDETERMINATE', rN.message)
  check('FAIL 态信封挂 err.envelope（C4 键齐备）', rN.envelope && ['status', 'reason_code', 'artifact_refs', 'detail'].every((k) => Object.hasOwn(rN.envelope, k)))
}

// ── 4) unknown op 负例（dispatcher 层：design_consequence.py 独立 dispatcher）──
{
  const req = JSON.stringify({ op: 'design_bogus_op', args: {} })
  const r = spawnSync(VENV, ['-I', join(ROOT, 'python', 'design_consequence.py')], {
    input: req, encoding: 'utf8', timeout: 120_000, env: ENV_PACKET(),
  })
  const parsed = JSON.parse(r.stdout.trim() || '{}')
  check('unknown op → 非零退出（exit 2）', r.status === 2, `status=${r.status}`)
  check('unknown op → INVALID_INPUT + UNKNOWN_OP（扁平 C4 + ok:false）',
    parsed.status === 'INVALID_INPUT' && parsed.reason_code === 'UNKNOWN_OP' && parsed.ok === false, r.stdout)
}

// ── 5) 确定性：同输入两跑输出一致 ───────────────────────────────────────
if (!IML_AVAILABLE) {
  skipNote('确定性：同输入两跑输出一致（worker 双跑）')
} else {
  const wd = workdir()
  const cardPath = cardFile(wd)
  const st1 = join(wd, 'st1')
  const st2 = join(wd, 'st2')
  mkdirSync(st1)
  mkdirSync(st2)
  const payload = JSON.stringify({ op: 'design_consequence', args: flattenModelRef(goodArgs(cardPath)) })
  const r1 = spawnSync(VENV, ['-I', join(ROOT, 'python', 'design_consequence.py')], {
    input: payload, encoding: 'utf8', timeout: 240_000, env: { ...ENV_PACKET(), DSH_DESIGN_STAGING: st1 },
  })
  const r2 = spawnSync(VENV, ['-I', join(ROOT, 'python', 'design_consequence.py')], {
    input: payload, encoding: 'utf8', timeout: 240_000, env: { ...ENV_PACKET(), DSH_DESIGN_STAGING: st2 },
  })
  const o1 = JSON.parse(r1.stdout.trim() || '{}')
  const o2 = JSON.parse(r2.stdout.trim() || '{}')
  check('确定性：两跑 exit 0 + ok:true', r1.status === 0 && r2.status === 0 && o1.ok === true && o2.ok === true,
    `s1=${r1.status} s2=${r2.status}`)
  check('确定性：两跑完整 stdout 一致（同输入同输出，逐字节）', r1.stdout === r2.stdout)
  check('确定性：两跑落盘字节一致 + sha 引用可复算',
    readFileSync(join(st1, 'consequence_run.json')).equals(readFileSync(join(st2, 'consequence_run.json')))
    && o1.envelope.artifact_refs[0].artifact_id === sha256File(join(st1, 'consequence_run.json')))
  check('确定性：两跑 baseline 锚点一致（0.876997 冻结锚点）',
    o1.consequence_run.baseline.objective_value === o2.consequence_run.baseline.objective_value
    && Math.abs(o1.consequence_run.baseline.objective_value - 0.876997) < 1e-5)
}

// ── 6) B2 终态：全量六 op 双向断言（TS 注册 ↔ dispatcher OPS）────────────
{
  const tools = register()
  const pyOps = pythonEval(
    'import sys; sys.path.insert(0, r"' + PY.replaceAll('\\', '\\\\') + '"); from bio_ops import OPS; ' +
    'print(",".join(sorted(k for k in OPS if k.startswith("design_"))))')
  const pyOpsSet = new Set(pyOps.split(','))
  check('B2 终态：TS 六工具全部注册', SIX_TOOLS.every((t) => typeof tools[t.name]?.execute === 'function'))
  check('B2 终态：六 op ∈ DESIGN_OPS', SIX_OPS.every((op) => DESIGN_OPS.has(op)))
  check('B2 终态：六 op ∈ dispatcher OPS（一一对应）', SIX_OPS.every((op) => pyOpsSet.has(op)))
  check('B2 终态：dispatcher OPS 六项与 TS 完全一致（无多余 design op）',
    [...pyOpsSet].every((op) => op === 'design_stage_artifact' || SIX_OPS.includes(op)))
}

for (const root of roots) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* cleanup does not change verdict */ }
}
console.log(`design-consequence-tools: ${pass} passed, ${skip} skipped, ${fail} failed`)
if (fail) process.exit(1)
