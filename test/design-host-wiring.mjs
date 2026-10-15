// dsh-bio-genie — B1-part-1 TS 接线/负测（req G-LOOP-20261015-B1P1-DB-001）
// 覆盖：
//  1) src/tools.js 注册三个 designHostTool（bio_chassis_profile / bio_integration_candidates /
//     bio_circuit_contextualize），op ∈ DESIGN_OPS（design 通道白名单）；
//  2) 双向验收：TS opts.op ↔ python/design_host.py OPS / TOOL_OP_NAMES 一一对应；
//  3) 真实工具 execute 路径（standalone，无 casefile）：C4 信封契约
//     {status, reason_code, artifact_refs[], detail}；OK 态 refs 可在 <cwd>/objects/<sha>.json 解析；
//     artifacts[] 产物元数据；_provenance 登记；
//  4) refs-only 负例：host_profile_ref / crn_sbml_ref 不可解析 → INVALID_INPUT（TS 层拦截）；
//  5) unknown op 负例：bio_ops.py dispatcher 拒绝未知 op（exit 0 + ok:false/UNKNOWN_OP）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerTools } from '../src/tools.js'
import { DESIGN_OPS } from '../src/design-ops.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const home = process.env.USERPROFILE || process.env.HOME
const VENV = process.env.DSH_BIO_PYTHON || join(home, '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe')

const FIX = join(ROOT, 'test', 'fixtures', 'design')
const FIX_CIRCULAR = join(FIX, 'fixture_circular.fna')
const FIX_FEATURES = join(FIX, 'fixture_features.tsv')

let pass = 0
let fail = 0
const roots = []
function check(name, actual, detail = '') {
  if (actual) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
function workdir() {
  const d = mkdtempSync(join(tmpdir(), 'design-host-wiring-'))
  roots.push(d)
  return d
}
function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}
function pythonEval(code) {
  const r = spawnSync(VENV, ['-c', code], { encoding: 'utf8', cwd: ROOT, timeout: 120_000 })
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

const HOST_OPS = ['design_chassis_profile', 'design_integration_candidates', 'design_circuit_contextualize']

// ── 1) 注册与白名单 ─────────────────────────────────────────────────────
{
  const tools = register()
  check('bio_chassis_profile 已注册', typeof tools.bio_chassis_profile?.execute === 'function')
  check('bio_integration_candidates 已注册', typeof tools.bio_integration_candidates?.execute === 'function')
  check('bio_circuit_contextualize 已注册', typeof tools.bio_circuit_contextualize?.execute === 'function')
  check('三工具 op ∈ DESIGN_OPS（design 通道白名单）', HOST_OPS.every((op) => DESIGN_OPS.has(op)))
  check('三工具参数：genome_files/cassette/circuit 声明', tools.bio_chassis_profile.parameters?.properties?.genome_files
    && tools.bio_integration_candidates.parameters?.properties?.cassette
    && tools.bio_circuit_contextualize.parameters?.properties?.circuit)
  check('integration top_n 上限 → wrapper 强制（≤16）', true) // 行为断言移至 §4 负例
}

// ── 2) 双向验收：TS opts.op ↔ python OPS / TOOL_OP_NAMES ─────────────────
{
  const py = pythonEval(
    'import sys; sys.path.insert(0, r"D:/Program/Github/dsh-bio-genie/python"); import design_host; ' +
    'print(",".join(sorted(design_host.OPS)) + "|" + ",".join(k + ":" + v for k, v in sorted(design_host.TOOL_OP_NAMES.items())))')
  const [ops, toolNames] = py.split('|')
  const opsSet = new Set(ops.split(','))
  check('python OPS 含三 op 且与 TS 一一对应', HOST_OPS.every((op) => opsSet.has(op))
    && [...opsSet].every((op) => HOST_OPS.includes(op)))
  check('TOOL_OP_NAMES ↔ TS 工具名映射齐全', toolNames.includes('bio_chassis_profile:design_chassis_profile')
    && toolNames.includes('bio_integration_candidates:design_integration_candidates')
    && toolNames.includes('bio_circuit_contextualize:design_circuit_contextualize'))
}

// ── 3) 真实 execute 路径：C4 信封契约（OK 态，standalone）────────────────
{
  const wd = workdir()
  const tools = register()
  const chassisArgs = {
    genome_files: [
      { path: FIX_CIRCULAR, format: 'fasta', sha256: sha256File(FIX_CIRCULAR) },
      { path: FIX_FEATURES, format: 'segments_tsv', sha256: sha256File(FIX_FEATURES) },
    ],
    coord_convention: '0-based-half-open',
    contig_topology: { synth_circ_4200: 'circular' },
  }
  const r = await run(tools.bio_chassis_profile, chassisArgs, wd)
  check('chassis execute → 不抛错且 status OK', r.threw === false && r.value.status === 'OK', r.message)
  const v = r.value
  check('C4 信封键齐备（OK 态）', ['status', 'reason_code', 'artifact_refs', 'detail'].every((k) => Object.hasOwn(v, k))
    && Array.isArray(v.artifact_refs) && v.artifact_refs.length === 2)
  check('产物元数据 artifacts[]（genome_ref + host_profile）', Array.isArray(v.artifacts) && v.artifacts.length === 2
    && new Set(v.artifacts.map((a) => a.logical_name)).size === 2
    && v.artifacts.every((a) => typeof a.sha256 === 'string' && a.sha256.length === 64))
  check('refs 全部可解析（<cwd>/objects/<sha>.json）', v.artifact_refs.every((ref) =>
    ref.artifact_id === ref.expected_sha256 && existsSync(join(wd, 'objects', ref.artifact_id + '.json'))))
  check('provenance 已盖戳（OK 态）', v._provenance && typeof v._provenance === 'object')
  check('无 casefile → 无 case_context', v.case_context === undefined)
}

// ── 4) refs-only 负例：host_profile_ref / crn_sbml_ref 不可解析 ─────────
{
  const wd = workdir()
  const tools = register()
  const badRef = { artifact_id: '0'.repeat(64), expected_sha256: '0'.repeat(64), relative_path: 'host_profile.json' }
  const r1 = await run(tools.bio_integration_candidates, {
    host_profile_ref: badRef,
    genome_files: [{ path: FIX_CIRCULAR, format: 'fasta', sha256: sha256File(FIX_CIRCULAR) }],
    cassette: { payload_length: 40 },
  }, wd)
  check('host_profile_ref 不可解析 → INVALID_INPUT/HOST_PROFILE_REF_UNRESOLVED',
    r1.threw && r1.status === 'INVALID_INPUT' && r1.code === 'HOST_PROFILE_REF_UNRESOLVED', r1.message)
  const r1b = await run(tools.bio_integration_candidates, {
    host_profile_ref: badRef,
    genome_files: [{ path: FIX_CIRCULAR, format: 'fasta', sha256: sha256File(FIX_CIRCULAR) }],
    cassette: { payload_length: 40 },
    top_n: 17,
  }, wd)
  check('top_n=17（>16）→ INVALID_INPUT/TOP_N_LIMIT（先于 ref 校验）',
    r1b.threw && r1b.status === 'INVALID_INPUT' && r1b.code === 'TOP_N_LIMIT', r1b.message)
  const r2 = await run(tools.bio_circuit_contextualize, {
    circuit: { components: [{ component_id: 'P1', kind: 'promoter' }] },
    crn_sbml_ref: { artifact_id: '0'.repeat(64), expected_sha256: '0'.repeat(64), relative_path: 'crn.json' },
  }, wd)
  check('缺 host_profile → INVALID_INPUT/HOST_PROFILE_REQUIRED（先于 crn 校验）',
    r2.threw && r2.status === 'INVALID_INPUT' && r2.code === 'HOST_PROFILE_REQUIRED', r2.message)
  check('FAIL 态信封挂 err.envelope（C4 键齐备）', r2.envelope && ['status', 'reason_code', 'artifact_refs', 'detail'].every((k) => Object.hasOwn(r2.envelope, k)))
}

// ── 5) unknown op 负例（dispatcher 层：bio_ops.py 全 exit-0 契约）─────────
{
  const req = JSON.stringify({ op: 'design_bogus_op', args: {} })
  const r = spawnSync(VENV, ['-I', join(ROOT, 'python', 'bio_ops.py')], {
    input: req, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, DSH_DESIGN_PACKET: '', DSH_DESIGN_PACKET_FIXED: join(ROOT, 'design', 'packet') },
  })
  const parsed = JSON.parse(r.stdout.trim() || '{}')
  check('unknown op → exit 0（P2-1 全 exit-0 契约）', r.status === 0, `status=${r.status}`)
  check('unknown op → ok:false + UNKNOWN_OP', parsed.ok === false && String(parsed.error).includes('unknown op'), r.stdout)
}

for (const root of roots) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* cleanup does not change verdict */ }
}
console.log(`design-host-wiring: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
