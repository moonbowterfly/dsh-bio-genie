// dsh-bio-genie — B1-part-2 TS 接线/负测（req G-LOOP-20261015-B1P2-001）
// 覆盖：
//  1) src/tools.js 注册两个 designTool（design_casefile_validate / export），
//     DESIGN_TOOL_OPS ⊆ DESIGN_OPS（design 通道白名单）；
//  2) 双向验收：TS DESIGN_TOOL_OPS ↔ python/design_casefile.py OPS（bio_ops.OPS 同源）；
//  3) 真实工具 execute 路径：C4 信封契约 {status, reason_code, artifact_refs[], detail}（OK 与 FAIL 两态）；
//  4) unknown op 负例：dispatcher 拒绝未知 op（exit 非零 + INVALID_INPUT/UNKNOWN_OP）；
//  5) export 门禁：validate 未过 → 拒绝导出（INVALID_INPUT/VALIDATE_GATE_FAILED，无产物）。
// 用例由 A1/A2 生产路径（test/design-casefile-builder.mjs）构建真实 case + 不可变快照。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESIGN_TOOL_OPS, registerTools } from '../src/tools.js'
import { DESIGN_OPS } from '../src/design-ops.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUILDER = join(ROOT, 'test', 'design-casefile-builder.mjs')
const home = process.env.USERPROFILE || process.env.HOME
const VENV = process.env.DSH_BIO_PYTHON || join(home, '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe')

let pass = 0
let fail = 0
const roots = []
function check(name, actual, detail = '') {
  if (actual) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
function workdir() {
  const d = mkdtempSync(join(tmpdir(), 'design-casefile-tools-'))
  roots.push(d)
  return d
}
function buildCase(mode, outDir) {
  const r = spawnSync(process.execPath, [BUILDER, outDir, mode], { encoding: 'utf8', timeout: 300_000 })
  if (r.status !== 0) throw new Error('builder failed: ' + (r.stderr || r.stdout))
  return JSON.parse(r.stdout.trim())
}
function pythonEval(code, cwd = ROOT) {
  const r = spawnSync(VENV, ['-c', code], { encoding: 'utf8', cwd, timeout: 120_000 })
  if (r.status !== 0) throw new Error('pythonEval failed: ' + (r.stderr || r.stdout))
  return r.stdout.trim()
}

// ── 1) 注册与白名单 ─────────────────────────────────────────────────────
{
  const tools = {}
  const ctx = { tools: { register: (t) => { tools[t.name] = t; return () => {} } } }
  registerTools(ctx, { enableLog: false })
  check('design_casefile_validate 已注册', typeof tools.design_casefile_validate?.execute === 'function')
  check('design_casefile_export 已注册', typeof tools.design_casefile_export?.execute === 'function')
  const vp = tools.design_casefile_validate?.parameters ?? {}
  const ep = tools.design_casefile_export?.parameters ?? {}
  const vProps = vp.properties ?? {}
  const eProps = ep.properties ?? {}
  check('validate 参数：casefile_dir required', (vp.required ?? []).includes('casefile_dir') && vProps.casefile_dir?.type === 'string')
  check('validate 参数：strict 默认 true', vProps.strict?.default === true)
  check('export 参数：format 枚举 + canonical audit_view_id', JSON.stringify(eProps.format?.enum) === JSON.stringify(['zip', 'report', 'both']) && eProps.format?.default === 'both' && eProps.audit_view_id?.type === 'array' && JSON.stringify(eProps.audit_view_id?.default) === JSON.stringify([]))
  check('DESIGN_TOOL_OPS 冻结且恰两 op', Object.isFrozen(DESIGN_TOOL_OPS) && DESIGN_TOOL_OPS.length === 2)
  check('DESIGN_TOOL_OPS ⊆ DESIGN_OPS（design 通道白名单）', DESIGN_TOOL_OPS.every((op) => DESIGN_OPS.has(op)))
}

// ── 2) 双向验收：TS opts.op ↔ python OPS ─────────────────────────────────
{
  const pyOps = pythonEval('import sys; sys.path.insert(0, r"D:/Program/Github/dsh-bio-genie/python"); from design_casefile import OPS; print(",".join(sorted(OPS)))')
  const pyOpsSet = new Set(pyOps.split(','))
  check('python OPS 含两 op 且与 TS 一致', pyOpsSet.has('design_casefile_validate') && pyOpsSet.has('design_casefile_export') && DESIGN_TOOL_OPS.every((op) => pyOpsSet.has(op)))
  check('TS DESIGN_TOOL_OPS ⊆ python OPS（双向验收）', [...pyOpsSet].every((op) => op === '' || DESIGN_TOOL_OPS.includes(op)))
}

// ── 3) 真实 execute 路径：C4 信封契约（OK 与 FAIL 两态）──────────────────
{
  const wd = workdir()
  const clean = buildCase('clean', join(wd, 'b-clean'))
  const r1 = buildCase('r1', join(wd, 'b-r1'))
  const tools = {}
  const ctx = { tools: { register: (t) => { tools[t.name] = t; return () => {} } } }
  registerTools(ctx, { enableLog: false })
  const exec = (cwd) => ({ signal: new AbortController().signal, agent: { session: { header: { cwd } } } })
  const run = async (tool, args, cwd) => {
    try {
      const v = await tool.execute(args, exec(cwd))
      return { threw: false, value: v }
    } catch (e) {
      return { threw: true, status: e.status, code: e.code, envelope: e.envelope, message: String(e.message) }
    }
  }
  // validate OK 态：clean case
  const vOk = await run(tools.design_casefile_validate, { casefile_dir: clean.case_dir }, wd)
  check('validate clean → 不抛错且 status OK', vOk.threw === false && vOk.value.status === 'OK', vOk.message)
  check('C4 信封键齐备（OK 态）', ['status', 'reason_code', 'artifact_refs', 'detail'].every((k) => Object.hasOwn(vOk.value, k)) && Array.isArray(vOk.value.artifact_refs))
  check('checks[] 8 项全 PASS', Array.isArray(vOk.value.checks) && vOk.value.checks.length === 8 && vOk.value.checks.every((c) => c.status === 'PASS'))
  // validate FAIL 态：R1 注入 case → err.status INVALID_INPUT + err.code R1_MODEL_REF_INVALID
  const vFail = await run(tools.design_casefile_validate, { casefile_dir: r1.case_dir }, wd)
  check('validate r1 → 抛错 INVALID_INPUT/R1_MODEL_REF_INVALID', vFail.threw && vFail.status === 'INVALID_INPUT' && vFail.code === 'R1_MODEL_REF_INVALID', vFail.message)
  check('C4 信封键齐备（FAIL 态，挂 err.envelope）', vFail.envelope && ['status', 'reason_code', 'artifact_refs', 'detail'].every((k) => Object.hasOwn(vFail.envelope, k)))
  check('FAIL 信封 checks 含 R1 FAIL', Array.isArray(vFail.envelope.checks) && vFail.envelope.checks.some((c) => c.check_id === 'R1_CRN_NEQ_GEM' && c.status === 'FAIL'))
  // export 门禁：validate 未过 → 拒绝
  const xGate = await run(tools.design_casefile_export, { casefile_dir: r1.case_dir }, wd)
  check('export r1（validate 未过）→ INVALID_INPUT/VALIDATE_GATE_FAILED 且无产物', xGate.threw && xGate.status === 'INVALID_INPUT' && xGate.code === 'VALIDATE_GATE_FAILED' && xGate.envelope?.artifact_refs?.length === 0, xGate.message)
  // export B4：clean S_n → finalize S_(n+1) → validate → export
  const xOk = await run(tools.design_casefile_export, { casefile_dir: clean.case_dir }, wd)
  check('export clean → B4 finalized OK、2 产物、S_(n+1)', xOk.threw === false && xOk.value.status === 'OK' && xOk.value.artifact_refs.length === 2 && xOk.value.report_finalized === true && xOk.value.snapshot_sha !== clean.snapshot_sha && /^[0-9a-f]{64}$/.test(xOk.value.report_artifact_id || ''), xOk.message)
  const finalized = JSON.parse(readFileSync(join(clean.case_dir, 'snapshots', xOk.value.snapshot_sha + '.json'), 'utf8'))
  const reportEntry = finalized.artifacts.filter((entry) => entry.type === 'case_report@1')
  const reportBytes = readFileSync(xOk.value.artifact_refs[0])
  check('产物绑定已提交 raw report.md 工件', xOk.value.artifact_refs.every((p) => existsSync(p)) && xOk.value.artifact_refs[0].endsWith('report.md') && xOk.value.artifact_refs[1].endsWith('bundle.zip') && reportEntry.length === 1 && reportEntry[0].artifact_id === xOk.value.report_artifact_id && reportEntry[0].canonical_path === 'report.md' && readFileSync(join(clean.case_dir, 'objects', reportEntry[0].artifact_id)).equals(reportBytes))
  // A second pure export is allowed only from S_(n+1), and must not create a
  // further science snapshot/object.  The report-finalize receipt binds parent.
  const beforePure = { objects: readdirSync(join(clean.case_dir, 'objects')).sort(), snapshots: readdirSync(join(clean.case_dir, 'snapshots')).sort() }
  const pure = await run(tools.design_casefile_export, { casefile_dir: clean.case_dir }, wd)
  const afterPure = { objects: readdirSync(join(clean.case_dir, 'objects')).sort(), snapshots: readdirSync(join(clean.case_dir, 'snapshots')).sort() }
  const receipts = readFileSync(join(clean.case_dir, 'run_receipt.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const finalizeReceipt = receipts.find((event) => event.event === 'committed' && event.report_finalize === true)
  const head = JSON.parse(readFileSync(join(clean.case_dir, 'HEAD.json'), 'utf8'))
  check('pure export 不改科学快照，finalize parent = S_n', pure.threw === false && pure.value.status === 'OK' && pure.value.report_finalized === false && head.snapshot_sha === xOk.value.snapshot_sha && JSON.stringify(beforePure) === JSON.stringify(afterPure) && finalizeReceipt?.parent_snapshot_sha === clean.snapshot_sha)
}

// ── 4) unknown op 负例（dispatcher 层，独立于注册路径）────────────────────
{
  const wd = workdir()
  const clean = buildCase('clean', join(wd, 'b-clean'))
  const req = JSON.stringify({ op: 'design_bogus_op', args: { casefile_dir: clean.case_dir } })
  const r = spawnSync(VENV, ['-I', join(ROOT, 'python', 'design_casefile.py')], {
    input: req, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, DSH_DESIGN_PACKET: '', DSH_DESIGN_PACKET_FIXED: join(ROOT, 'design', 'packet') },
  })
  const envl = JSON.parse(r.stdout.trim() || '{}')
  check('unknown op → 非零退出', r.status !== 0, `status=${r.status}`)
  check('unknown op → INVALID_INPUT/UNKNOWN_OP 信封', envl.status === 'INVALID_INPUT' && envl.reason_code === 'UNKNOWN_OP', r.stdout)
}

// ── 5) 守卫回归（P0 现场修复，2026-10-16 实战测试发现）：正斜杠 header.cwd 不得误拒 ──
{
  const wd = workdir()
  const clean = buildCase('clean', join(wd, 'b-clean'))
  const tools = {}
  const ctx = { tools: { register: (t) => { tools[t.name] = t; return () => {} } } }
  registerTools(ctx, { enableLog: false })
  const exec = (cwd) => ({ signal: new AbortController().signal, agent: { session: { header: { cwd } } } })
  const run = async (tool, args, cwd) => {
    try {
      const v = await tool.execute(args, exec(cwd))
      return { threw: false, value: v }
    } catch (e) {
      return { threw: true, status: e.status, code: e.code, envelope: e.envelope, message: String(e.message) }
    }
  }
  const wdFwd = wd.replace(/\\/g, '/') // 模拟 API 创建会话时 header.cwd 的正斜杠形态
  const vFwd = await run(tools.design_casefile_validate, { casefile_dir: clean.case_dir }, wdFwd)
  check('正斜杠 cwd + 工作区内 casefile_dir → 不误拒（守卫修复回归）', vFwd.threw === false && vFwd.value.status === 'OK', vFwd.message)
  const vBack = await run(tools.design_casefile_validate, { casefile_dir: clean.case_dir }, wd)
  check('反斜杠 cwd 对照 → 同样通过', vBack.threw === false && vBack.value.status === 'OK', vBack.message)
  const vRel = await run(tools.design_casefile_validate, { casefile_dir: relative(wd, clean.case_dir) }, wdFwd)
  check('正斜杠 cwd + 相对 casefile_dir → 不误拒', vRel.threw === false && vRel.value.status === 'OK', vRel.message)
  const outside = workdir()
  const vOut = await run(tools.design_casefile_validate, { casefile_dir: outside }, wdFwd)
  check('工作区外 casefile_dir → 仍拒绝 OUT_OF_DOMAIN（containment 不放松）', vOut.threw === true && vOut.code === 'OUT_OF_DOMAIN', vOut.message)
  const vOutRel = await run(tools.design_casefile_validate, { casefile_dir: '../outside' }, wdFwd)
  check('正斜杠 cwd + 越界相对路径 → 仍拒绝', vOutRel.threw === true && vOutRel.code === 'OUT_OF_DOMAIN', vOutRel.message)
}

for (const root of roots) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* cleanup does not change verdict */ }
}
console.log(`design-casefile-tools: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
