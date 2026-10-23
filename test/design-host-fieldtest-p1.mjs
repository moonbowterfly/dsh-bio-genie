// dsh-bio-genie — fieldtest P1 回归（TS 接线层）：P1-3 条件产物 / P1-4 CRN 登记入口 / P1-2 截断重解析
//
// 背景：FIELDTEST-REPORT-20261016 §3
//   P1-2 host_profile.annotation.detail 2048 上限 → integration 在真实基因组上 fail-closed 不可用；
//   P1-3 bio_circuit_contextualize 声明 3 产物、Python 仅在有 CRN 时产第 3 个 → 无 CRN 报 MISSING_OUTPUT；
//   P1-4 kinetic_crn_ref 无登记入口（crn_sbml_ref 只能指向已登记对象）→ CRN_REF_UNRESOLVED。
//
// 每条断言在旧实现下为红（红/绿判别见提交说明）：
//   - 旧 wrapper 把 allowedOutputs 全量当必需 → 无 CRN 的 OK 信封被判 MISSING_OUTPUT；
//   - 旧 ingress 无视 crn_sbml_file → SBML 无法登记 → 第 3 产物恒缺；
//   - 旧 python 在 detail 截断时一律 NOT_RUN/ANNOTATION_TRUNCATED。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerTools, requiredOutputNames } from '../src/tools.js'
import { cleanVenvEnv } from './clean-venv-env.mjs'

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
  if (actual) { pass += 1; console.log('  PASS ' + name) } else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 400) : '')) }
}
function workdir() {
  const d = mkdtempSync(join(tmpdir(), 'design-host-fieldtest-'))
  roots.push(d)
  return d
}
function sha256Bytes(buf) { return createHash('sha256').update(buf).digest('hex') }
function sha256File(p) { return sha256Bytes(readFileSync(p)) }
function register() {
  const tools = {}
  const ctx = { tools: { register: (t) => { tools[t.name] = t; return () => {} } } }
  registerTools(ctx, { enableLog: false, pythonPath: VENV })
  return tools
}
const execCtx = (cwd) => ({ signal: new AbortController().signal, agent: { session: { header: { cwd } } } })
const run = async (tool, args, cwd) => {
  try {
    return { threw: false, value: await tool.execute(args, execCtx(cwd)) }
  } catch (e) {
    return { threw: true, status: e.status, code: e.code, envelope: e.envelope, message: String(e.message) }
  }
}
const readObject = (wd, sha) => JSON.parse(readFileSync(join(wd, 'objects', sha + '.json'), 'utf8'))

// ── 1) 默认严格：未标注 requiredWhen 的声明输出一律必需（fail-closed 基线）────────────
{
  const declared = [{ logical_name: 'a.json' }, { logical_name: 'b.json' }]
  check('requiredOutputNames 默认 = 全部声明输出（不允许缺省放宽）',
    JSON.stringify(requiredOutputNames(declared, {})) === '["a.json","b.json"]', requiredOutputNames(declared, {}))
  const conditional = [
    { logical_name: 'a.json' },
    { logical_name: 'b.json', requiredWhen: (args) => Boolean(args && args.present) },
  ]
  check('requiredWhen=false → 条件产物不计入必需',
    JSON.stringify(requiredOutputNames(conditional, {})) === '["a.json"]', requiredOutputNames(conditional, {}))
  check('requiredWhen=true → 条件产物计入必需（缺则 MISSING_OUTPUT）',
    JSON.stringify(requiredOutputNames(conditional, { present: true })) === '["a.json","b.json"]',
    requiredOutputNames(conditional, { present: true }))
}

// ── 2) 前置：真实 chassis_profile → host_profile/genome_ref（standalone objects）──
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
const chassis = await run(tools.bio_chassis_profile, chassisArgs, wd)
check('chassis 前置 OK', chassis.threw === false && chassis.value.status === 'OK', chassis.message || JSON.stringify(chassis.value))
const hpRef = (chassis.value?.artifact_refs || []).find((r) => r.relative_path === 'host_profile.json')
const CIRCUIT = { components: [{ component_id: 'P1', kind: 'promoter' }, { component_id: 'P2', kind: 'rbs' }] }
const PARTS = [{ part_id: 'P1', evidence_level: 'E2', source_id: 'SP1' }]
const circuitBase = { host_profile_ref: hpRef, circuit: CIRCUIT, parts_evidence: PARTS }

// ── 3) P1-3：无 CRN → OK 且只产 2 产物（旧实现 → EXECUTION_ERROR/MISSING_OUTPUT）──────
{
  const r = await run(tools.bio_circuit_contextualize, { ...circuitBase }, wd)
  check('P1-3 无 CRN → 不抛错且 status OK（旧实现 MISSING_OUTPUT）',
    r.threw === false && r.value.status === 'OK', r.message || JSON.stringify(r.value))
  const names = (r.value?.artifacts || []).map((a) => a.logical_name).sort()
  check('P1-3 无 CRN → 产物恰为 circuit_design + expression_scenario',
    JSON.stringify(names) === '["circuit_design.json","expression_scenario.json"]', names)
  check('P1-3 无 CRN → 不产 kinetic_crn_ref（条件产物未触发）',
    !names.includes('kinetic_crn_ref.json'), names)
  const scRef = (r.value?.artifacts || []).find((a) => a.logical_name === 'expression_scenario.json')
  check('P1-3 expression_scenario 无 model_or_dataset_ref（未提供 CRN）',
    scRef !== undefined && readObject(wd, scRef.sha256).model_or_dataset_ref === undefined, scRef && scRef.sha256)
}

// ── 4) P1-4：crn_sbml_file 登记入口 → 第 3 产物 kinetic_crn_ref@1 ─────────────────
const SBML_TEXT = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<sbml xmlns="http://www.sbml.org/sbml/level3/version1/core" level="3" version="1">\n'
  + '  <model id="crn_probe" name="crn_probe">\n'
  + '    <listOfCompartments><compartment id="cell" size="1" constant="true"/></listOfCompartments>\n'
  + '  </model>\n'
  + '</sbml>\n'
{
  const sbmlPath = join(wd, 'crn_probe.sbml')
  writeFileSync(sbmlPath, SBML_TEXT, 'utf8')
  const sbmlSha = sha256File(sbmlPath)
  const r = await run(tools.bio_circuit_contextualize,
    { ...circuitBase, crn_sbml_file: { path: sbmlPath, sha256: sbmlSha } }, wd)
  check('P1-4 crn_sbml_file → 不抛 CRN_REF_UNRESOLVED 且 OK',
    r.threw === false && r.value.status === 'OK', r.message || JSON.stringify(r.value))
  const names = (r.value?.artifacts || []).map((a) => a.logical_name).sort()
  check('P1-4 登记入口 → 3 产物齐备（含 kinetic_crn_ref.json）',
    JSON.stringify(names) === '["circuit_design.json","expression_scenario.json","kinetic_crn_ref.json"]', names)
  if (names.includes('kinetic_crn_ref.json')) {
    const kc = readObject(wd, r.value.artifacts.find((a) => a.logical_name === 'kinetic_crn_ref.json').sha256)
    check('P1-4 kinetic_crn_ref@1 绑定 SBML 文件字节 sha256',
      kc.artifact_type === 'kinetic_crn_ref@1' && kc.model_kind === 'kinetic_crn'
      && kc.sbml_ref.artifact_id === sbmlSha && kc.sbml_ref.expected_sha256 === sbmlSha, JSON.stringify(kc))
    check('P1-4 sbml_ref.relative_path 为单段逻辑名（无宿主路径泄漏）',
      typeof kc.sbml_ref.relative_path === 'string' && !/[\\/]/.test(kc.sbml_ref.relative_path), kc.sbml_ref.relative_path)
    const scRef4 = (r.value?.artifacts || []).find((a) => a.logical_name === 'expression_scenario.json')
    const scenario4 = scRef4 ? readObject(wd, scRef4.sha256) : null
    check('P1-4 expression_scenario 经 model_or_dataset_ref 挂接 kinetic_crn_ref',
      scenario4?.model_or_dataset_ref?.relative_path === 'kinetic_crn_ref.json',
      JSON.stringify(scenario4?.model_or_dataset_ref))
  }
  // 登记入口的复制件已落盘（ingress 拥有副本，不依赖原路径存活）
  check('P1-4 ingress 已为 SBML 落副本（.design-inputs/<op>/<sha>）',
    existsSync(join(wd, '.design-inputs', 'design_circuit_contextualize', sbmlSha)), sbmlSha)

  // 负例：冲突（ref + file 互斥）
  const conflict = await run(tools.bio_circuit_contextualize,
    { ...circuitBase, crn_sbml_ref: hpRef, crn_sbml_file: { path: sbmlPath } }, wd)
  check('P1-4 crn_sbml_ref + crn_sbml_file 同时给 → INVALID_INPUT/CRN_INPUT_CONFLICT',
    conflict.threw && conflict.status === 'INVALID_INPUT' && conflict.code === 'CRN_INPUT_CONFLICT',
    conflict.message)
  // 负例：声明 sha256 与磁盘不符 → fail-closed（不放行）
  const mismatch = await run(tools.bio_circuit_contextualize,
    { ...circuitBase, crn_sbml_file: { path: sbmlPath, sha256: '0'.repeat(64) } }, wd)
  check('P1-4 crn_sbml_file.sha256 与磁盘不符 → INVALID_INPUT/INGRESS_HASH_MISMATCH',
    mismatch.threw && mismatch.status === 'INVALID_INPUT' && mismatch.code === 'INGRESS_HASH_MISMATCH',
    mismatch.message)
  // 负例：文件不存在 → 不放行
  const missing = await run(tools.bio_circuit_contextualize,
    { ...circuitBase, crn_sbml_file: { path: join(wd, 'nope.sbml') } }, wd)
  check('P1-4 crn_sbml_file 路径不存在 → INVALID_INPUT/INPUT_FILE_MISSING',
    missing.threw && missing.status === 'INVALID_INPUT' && missing.code === 'INPUT_FILE_MISSING',
    missing.message)
}

// ── 5) P1-2（接线层）：detail 截断 → 入参注释重解析后 OK；候选数 < 16 不再误判 ────────
{
  const wd2 = workdir()
  const L = 120000
  // 确定性伪随机序列（LCG；不依赖宿主随机源）
  let state = 20261016
  const bases = 'ACGT'
  let seq = ''
  for (let i = 0; i < L; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648
    seq += bases[state % 4]
  }
  const fasta = join(wd2, 'genome.fna')
  writeFileSync(fasta, '>synth_linear_120000\n' + seq.replace(/(.{70})/g, '$1\n') + '\n', 'utf8')
  const gff = join(wd2, 'genome.gff3')
  const lines = ['##gff-version 3']
  for (let i = 0; i < 60; i += 1) {
    const s = i * 1500
    lines.push(`synth_linear_120000\tgenie\tCDS\t${s + 1}\t${s + 900}\t.\t${i % 2 === 0 ? '+' : '-'}\t.\tID=gene-b${String(i).padStart(4, '0')};locus_tag=b${String(i).padStart(4, '0')}`)
  }
  writeFileSync(gff, lines.join('\n') + '\n', 'utf8')
  const inputs = [
    { path: fasta, format: 'fasta', sha256: sha256File(fasta) },
    { path: gff, format: 'gff3', sha256: sha256File(gff) },
  ]
  const ch = await run(tools.bio_chassis_profile, {
    genome_files: inputs, coord_convention: '0-based-half-open', contig_topology: { synth_linear_120000: 'linear' },
  }, wd2)
  check('P1-2 chassis 前置 OK（真实规模注释）', ch.threw === false && ch.value.status === 'OK', ch.message)
  const hpRef2 = (ch.value?.artifact_refs || []).find((r) => r.relative_path === 'host_profile.json')
  const grRef2 = (ch.value?.artifact_refs || []).find((r) => r.relative_path === 'genome_ref.json')
  if (!hpRef2 || !grRef2) {
    check('P1-2 chassis 前置产物可解析（阻断后续断言）', false, ch.message)
    for (const root of roots) { try { rmSync(root, { recursive: true, force: true }) } catch { /* noop */ } }
    console.log(`design-host-fieldtest-p1: ${pass} passed, ${fail} failed`)
    process.exit(1)
  }
  const hp = readObject(wd2, hpRef2.artifact_id)
  const gr = readObject(wd2, grRef2.artifact_id)
  const detail = hp.evidence_state.annotation.detail
  check('P1-2 annotation.detail 已截断（truncated=true，≤2048）',
    detail.includes('"truncated":true') && detail.length <= 2048, detail.length)
  const targetStart = 50 * 1500 + 100
  const integArgs = {
    host_profile: hp, genome_ref_value: gr, genome_files: inputs,
    cassette: { payload_length: 200 },
    candidates: [{ contig: 'synth_linear_120000', start: targetStart, end: targetStart + 200 }],
    exclude_rules: ['repeat', 'neighborhood', 'motif'],
  }
  const integ = await run(tools.bio_integration_candidates, integArgs, wd2)
  check('P1-2 截断 + 同一份注释 → OK（旧实现 NOT_RUN/ANNOTATION_TRUNCATED）',
    integ.threw === false && integ.value.status === 'OK', integ.message || JSON.stringify(integ.value))
  check('P1-2 候选数 1 < 16 不再被误判 MISSING_OUTPUT（条件产物语义）',
    (integ.value?.artifacts || []).length === 1, (integ.value?.artifacts || []).length)
  if ((integ.value?.artifacts || []).length === 1) {
    const cand = readObject(wd2, integ.value.artifacts[0].sha256)
    const overlap = (cand.reasons || []).find((x) => x.rule_id === 'feature_overlap')
    check('P1-2 feature_overlap 命中 gene-b0050（detail 保留段之外，证明完整重解析）',
      overlap && overlap.code === 'EXCLUDE' && String(overlap.detail).includes('gene-b0050'), JSON.stringify(overlap))
  }
  // 负例：不给注释文件 → 保持 NOT_RUN/ANNOTATION_TRUNCATED（fail-closed 不放松）
  const noAnn = await run(tools.bio_integration_candidates, { ...integArgs, genome_files: [inputs[0]] }, wd2)
  check('P1-2 截断 + 未提供注释文件 → NOT_RUN/ANNOTATION_TRUNCATED',
    noAnn.threw && noAnn.status === 'NOT_RUN' && noAnn.code === 'ANNOTATION_TRUNCATED', noAnn.message)
}

// ── 6) P2 附加守卫：消费者提示串必须是真实注册工具名；condition 识别字段须在参数文档中 ──
{
  check('P2 消费者提示串为已注册工具名（design_consequence / bio_circuit_contextualize）',
    ['design_consequence', 'bio_circuit_contextualize'].every((n) => typeof tools[n]?.execute === 'function'))
  const condDoc = String(tools.bio_chassis_profile.parameters?.properties?.condition?.description || '')
  check('P2 condition 参数文档声明已识别字段（medium/temperature/oxygen/phase）',
    ['medium', 'temperature', 'oxygen', 'phase'].every((k) => condDoc.includes(k)), condDoc)
  check('P1-2 integration 描述声明「截断 → 同一份注释重解析」契约（禁止缩表绕过）',
    /重解析/.test(String(tools.bio_integration_candidates.description))
    && /ANNOTATION_UNVERIFIABLE/.test(String(tools.bio_integration_candidates.description)),
    String(tools.bio_integration_candidates.description).slice(0, 200))
}

for (const root of roots) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* cleanup does not change verdict */ }
}
console.log(`design-host-fieldtest-p1: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
