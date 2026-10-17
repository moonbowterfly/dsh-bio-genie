// design-validation.mjs — v4 §A0.3：双端等价性（99 例 vs packet 冻结结果）+ 三阶段接线 E2E + 定向变异
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatchDesignOp, verifyStagedCandidate } from '../src/design-dispatch.js'
import { validateDesignArtifact } from '../src/design-validate.js'
import { cleanVenvEnv } from './clean-venv-env.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKET = join(ROOT, 'design', 'packet')
const CORPUS = join(PACKET, 'schema-corpus', 'schema_cases.json')
const home = process.env.USERPROFILE || process.env.HOME
const VENV = process.env.DSH_BIO_PYTHON || join(home, '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe')

// venv python 须隔离宿主 PYTHONPATH（Hermes agent shell 会注入其工具 venv 的
// site-packages 影子化同名包）：统一走 test/clean-venv-env.mjs（含背景说明）。
const venvEnv = cleanVenvEnv()

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS', name) }
  else { fail += 1; console.log('  FAIL', name, extra ?? '') }
}

const work = mkdtempSync(join(tmpdir(), 'design-val-'))

// ── 1) 双端等价性（99 例；vs 彼此 + vs 语料期望 + vs packet 冻结结果）──────
{
  const tsOut = join(work, 'ts.json')
  const pyOut = join(work, 'py.json')
  const r1 = spawnSync(process.execPath, [join(ROOT, 'src', 'design-validate.js'), '--batch', CORPUS, '--out', tsOut], { encoding: 'utf8', timeout: 300000 })
  check('TS 批跑 exit 0', r1.status === 0, (r1.stderr || '').slice(-200))
  const r2 = spawnSync(VENV, [join(ROOT, 'python', 'design_validate.py'), '--batch', CORPUS, '--out', pyOut], { encoding: 'utf8', timeout: 300000, env: venvEnv })
  check('PY 批跑 exit 0', r2.status === 0, (r2.stderr || '').slice(-200))
  const cases = JSON.parse(readFileSync(CORPUS, 'utf8')).cases
  const ts = new Map(JSON.parse(readFileSync(tsOut, 'utf8')).results.map((x) => [x.id, x]))
  const py = new Map(JSON.parse(readFileSync(pyOut, 'utf8')).results.map((x) => [x.id, x]))
  const fpy = new Map(JSON.parse(readFileSync(join(PACKET, 'schema-corpus', 'results_schema_python.json'), 'utf8')).results.map((x) => [x.id, x]))
  const fnd = new Map(JSON.parse(readFileSync(join(PACKET, 'schema-corpus', 'results_schema_node.json'), 'utf8')).results.map((x) => [x.id, x]))
  let semMM = 0
  let verMM = 0
  let expMM = 0
  let froMM = 0
  let c14nNE = 0
  for (const c of cases) {
    const a = ts.get(c.id)
    const b = py.get(c.id)
    if (!a || !b) { verMM += 1; continue }
    if (JSON.stringify(a.sem) !== JSON.stringify(b.sem)) semMM += 1
    if (a.core_valid !== b.core_valid) verMM += 1
    if (a.core_valid !== (c.expect === 'valid')) expMM += 1
    for (const f of [fpy.get(c.id), fnd.get(c.id)]) {
      if (f && (a.core_valid !== f.valid || JSON.stringify(a.sem) !== JSON.stringify(f.sem))) froMM += 1
    }
    if ((a.c14n || []).length) c14nNE += 1
  }
  check('等价性：TS↔PY sem 全等（99）', semMM === 0, 'mismatch=' + semMM)
  check('等价性：TS↔PY verdict 全等', verMM === 0, 'mismatch=' + verMM)
  check('等价性：vs 语料期望全等', expMM === 0, 'mismatch=' + expMM)
  check('等价性：vs packet 冻结结果全等', froMM === 0, 'mismatch=' + froMM)
  check('c14n 层语料零告警', c14nNE === 0, 'nonEmpty=' + c14nNE)
}

// ── 2) 三阶段接线 E2E（真 venv + 真 packet）─────────────────────────────
{
  check('venv python 存在', existsSync(VENV), VENV)
  const cases = JSON.parse(readFileSync(CORPUS, 'utf8')).cases
  const findCase = (id) => cases.find((c) => c.id === id)

  // 正路径：gvr-01（minimal valid genome_ref）
  const c1 = findCase('gvr-01')
  const dir1 = join(work, 'stage-ok')
  mkdirSync(dir1, { recursive: true })
  const res = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: c1.schema, raw_json: JSON.stringify(c1.doc) }, { cwd: dir1, timeoutMs: 180000 })
  check('stage① 有效工件 -> staged + sha256', res.ok === true && !!res.result?.staged && !!res.result?.sha256, JSON.stringify(res).slice(0, 260))
  check('stage② committed（object content-addressed）',
    res.committed?.ok === true && existsSync(res.committed.object_path) && res.committed.object_path.endsWith(res.result.sha256 + '.json'),
    JSON.stringify(res.committed || {}).slice(0, 260))
  if (res.committed?.ok) {
    check('object 字节与 staged 逐字节一致', readFileSync(res.committed.object_path).equals(readFileSync(res.result.staged)))
  }
  const r3 = await dispatchDesignOp(VENV, 'design_casefile_validate', { object_path: res.committed.object_path, artifact_type: c1.schema }, { cwd: dir1, timeoutMs: 180000 })
  check('stage③ 从不可变对象重校验 PASS', r3.ok === true && r3.result?.verdict === 'PASS', JSON.stringify(r3).slice(0, 260))

  // stage① 无效工件（gvr-02 缺 required）→ VALIDATION_FAILED + 零工件落盘
  const c2 = findCase('gvr-02')
  const dir2 = join(work, 'stage-bad')
  mkdirSync(dir2, { recursive: true })
  const res2 = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: c2.schema, raw_json: JSON.stringify(c2.doc) }, { cwd: dir2, timeoutMs: 180000 })
  check('stage① 无效工件 -> VALIDATION_FAILED', res2.ok === false && res2.code === 'VALIDATION_FAILED', JSON.stringify(res2).slice(0, 260))
  const badFiles = []
  const badStageRoot = join(dir2, 'staging')
  if (existsSync(badStageRoot)) {
    for (const d of readdirSync(badStageRoot)) {
      for (const f of readdirSync(join(badStageRoot, d))) {
        if (f.endsWith('.json') && f !== 'dispatch.json') badFiles.push(f)
      }
    }
  }
  check('stage① 无效工件 -> 零工件落盘', badFiles.length === 0, badFiles.join(','))

  // 定向变异码（按门区分）
  const c3 = findCase('gvr-07')
  const v3 = validateDesignArtifact(c3.schema, c3.doc)
  check('变异码：PATTERN_DOMAIN_VIOLATION（pattern 门）', v3.sem.some((x) => x.startsWith('PATTERN_DOMAIN_VIOLATION')), JSON.stringify(v3.sem))
  const c4 = findCase('evi-03')
  const v4 = validateDesignArtifact(c4.schema, c4.doc)
  check('变异码：DECIMAL_STRING_NONCANONICAL（decimal 门）', v4.sem.some((x) => x.startsWith('DECIMAL_STRING_NONCANONICAL')), JSON.stringify(v4.sem))
  const lone = validateDesignArtifact('genome_ref', { artifact_type: 'genome_ref@1', files: [{ path: 'x', sha256: '\uD800' + 'a'.repeat(63) }] })
  check('变异码：LONE_SURROGATE（c14n 门）', lone.c14n.some((x) => x.startsWith('LONE_SURROGATE')), JSON.stringify(lone.c14n))
  const schemaV = validateDesignArtifact('genome_ref', { artifact_type: 'genome_ref@1' })
  check('变异码：SCHEMA_VIOLATION（schema 门）', schemaV.errors.some((e) => e.code === 'SCHEMA_VIOLATION'), JSON.stringify(schemaV.errors).slice(0, 200))

  // stage② 直接负测：sha 不符 / 不可读
  const neg1 = verifyStagedCandidate({ stagingFile: res.result.staged, expectedSha256: '0'.repeat(64), artifactType: c1.schema })
  check('stage② sha 不符 -> STAGED_HASH_MISMATCH', neg1.ok === false && neg1.errors[0].code === 'STAGED_HASH_MISMATCH', JSON.stringify(neg1.errors))
  const badFile = join(work, 'unreadable.json')
  writeFileSync(badFile, '{not json')
  const neg2 = verifyStagedCandidate({ stagingFile: badFile, artifactType: c1.schema })
  check('stage② 不可读 -> STAGED_UNREADABLE', neg2.ok === false && neg2.errors[0].code === 'STAGED_UNREADABLE', JSON.stringify(neg2.errors))

  // stage③ 负测：错名对象 / 内容无效对象
  const objDir = join(dir1, 'objects')
  const wrongNamed = join(objDir, 'deadbeef' + '0'.repeat(56) + '.json')
  writeFileSync(wrongNamed, readFileSync(res.committed.object_path))
  const r3n = await dispatchDesignOp(VENV, 'design_casefile_validate', { object_path: wrongNamed, artifact_type: c1.schema }, { cwd: dir1, timeoutMs: 180000 })
  check('stage③ 错名对象 -> OBJECT_HASH_MISMATCH', r3n.ok === false && r3n.code === 'OBJECT_HASH_MISMATCH', JSON.stringify(r3n).slice(0, 200))
  const badValBytes = Buffer.from(JSON.stringify({ artifact_type: 'genome_ref@1' }) + '\n', 'utf8')
  const badSha = createHash('sha256').update(badValBytes).digest('hex')
  const badObj = join(objDir, badSha + '.json')
  writeFileSync(badObj, badValBytes)
  const r3b = await dispatchDesignOp(VENV, 'design_casefile_validate', { object_path: badObj, artifact_type: 'genome_ref' }, { cwd: dir1, timeoutMs: 180000 })
  check('stage③ 内容无效 -> verdict FAIL', r3b.ok === true && r3b.result?.verdict === 'FAIL', JSON.stringify(r3b).slice(0, 260))
  // ── 3) canonical-byte 定向变异（v5）─────────────────────────────────
  const dirE = join(work, 'stage-canon')
  mkdirSync(dirE, { recursive: true })
  const pretty = JSON.stringify(c1.doc, null, 2)
  const compact = JSON.stringify(c1.doc)
  const rP = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: c1.schema, raw_json: pretty }, { cwd: dirE, timeoutMs: 180000 })
  const rC = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: c1.schema, raw_json: compact }, { cwd: dirE, timeoutMs: 180000 })
  check('E1 pretty 输入 -> 落盘为 canonical（与 compact 输入同 sha）',
    rP.ok === true && rC.ok === true && rP.result?.sha256 === rC.result?.sha256, JSON.stringify({ p: rP.result?.sha256, c: rC.result?.sha256 }))
  if (rP.ok) {
    const stagedText = readFileSync(rP.result.staged, 'utf8')
    check('E1b staged bytes 无空白/无尾换行（canonical 形态）', !stagedText.includes('\n') && stagedText === stagedText.trim(), stagedText.slice(0, 60))
  }
  // E2 raw duplicate key -> DUP_KEY（在任何普通 JSON parse 之前）
  const dupRaw = '{"artifact_type":"genome_ref@1","artifact_type":"genome_ref@1","files":[],"source":"s"}'
  const rD = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: 'genome_ref', raw_json: dupRaw }, { cwd: dirE, timeoutMs: 180000 })
  check('E2 raw duplicate key -> DUP_KEY 拒', rD.ok === false && String(rD.error || '').includes('DUP_KEY'), JSON.stringify(rD).slice(0, 220))
  // E3/E4 set 语义（claim.evidence_refs: x-canonical set）
  const clm = findCase('clm-01')
  const H1 = 'a'.repeat(64)
  const H2 = 'b'.repeat(64)
  const mkClaim = (refs) => {
    const d = JSON.parse(JSON.stringify(clm.doc))
    d.evidence_refs = refs
    return JSON.stringify(d)
  }
  const rSet = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: 'claim', raw_json: mkClaim([H2, H1]) }, { cwd: dirE, timeoutMs: 180000 })
  check('E3 未排序 set -> canonical 排序后接受', rSet.ok === true, JSON.stringify(rSet).slice(0, 200))
  if (rSet.ok) {
    const st = readFileSync(rSet.result.staged, 'utf8')
    check('E3b staged 中 set 已排序（H1 在 H2 前）', st.includes(H1) && st.indexOf(H1) < st.indexOf(H2))
  }
  const rDup = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: 'claim', raw_json: mkClaim([H1, H1]) }, { cwd: dirE, timeoutMs: 180000 })
  check('E4 重复 set 元素 -> SET_DUPLICATE 拒', rDup.ok === false && String(rDup.error || '').includes('SET_DUPLICATE'), JSON.stringify(rDup).slice(0, 220))
  // E5 NFD 字符串 -> NFC 归一（bytes 变化；method_ref 为无 pattern 自由文本字段）
  const nfdRaw = (() => {
    const d = JSON.parse(JSON.stringify(clm.doc))
    d.method_ref = 'cafe' + '\u0301'
    return JSON.stringify(d)
  })()
  const rNfd = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: 'claim', raw_json: nfdRaw }, { cwd: dirE, timeoutMs: 180000 })
  check('E5 NFD 字符串 -> NFC 归一接受', rNfd.ok === true, JSON.stringify(rNfd).slice(0, 200))
  if (rNfd.ok) {
    const st = readFileSync(rNfd.result.staged, 'utf8')
    check('E5b staged 为 NFC 形态', st.includes('caf\u00e9') && !st.includes('cafe\u0301'))
  }
  // E6 数值边界（>2^53 整数）
  const bigRaw = (() => {
    const d = JSON.parse(JSON.stringify(clm.doc))
    d.extra_big = 9007199254740992
    return JSON.stringify(d)
  })()
  const rBig = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: 'claim', raw_json: bigRaw }, { cwd: dirE, timeoutMs: 180000 })
  check('E6 数值边界（>2^53）-> NUMBER_OUT_OF_RANGE 拒', rBig.ok === false && String(rBig.error || '').includes('NUMBER_OUT_OF_RANGE'), JSON.stringify(rBig).slice(0, 220))
  // E7 split-packet 防线
  const savedEnv = process.env.DSH_DESIGN_PACKET
  process.env.DSH_DESIGN_PACKET = 'D:/nonexistent-packet'
  const rEnv = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: c1.schema, raw_json: compact }, { cwd: dirE, timeoutMs: 180000 })
  if (savedEnv === undefined) delete process.env.DSH_DESIGN_PACKET
  else process.env.DSH_DESIGN_PACKET = savedEnv
  check('E7a 继承的 DSH_DESIGN_PACKET 被清除（仍走 TS 固定身份）', rEnv.ok === true, JSON.stringify(rEnv).slice(0, 200))
  const idScript = join(work, 'id_probe.py')
  writeFileSync(idScript, [
    'import json, os, sys',
    "sys.path.insert(0, r'" + join(ROOT, 'python') + "')",
    'import design_ops as ops',
    "os.environ['DSH_DESIGN_STAGING'] = r'" + join(dirE, 'idprobe-staging') + "'",
    "os.makedirs(os.environ['DSH_DESIGN_STAGING'], exist_ok=True)",
    "os.environ['DSH_DESIGN_PACKET_FIXED'] = r'" + join(ROOT, 'design', 'packet') + "'",
    "os.environ['DSH_DESIGN_EXPECT_INDEX_SHA'] = '0' * 64",
    "print(json.dumps(ops.op_design_stage_artifact({'artifact_type': 'genome_ref', 'raw_json': '{}'})))",
  ].join('\n'), 'utf8')
  const idr = spawnSync(VENV, [idScript], { encoding: 'utf8', timeout: 120000, env: venvEnv })
  check('E7b 期望身份不符 -> PACKET_IDENTITY_MISMATCH（split-packet 防线）',
    String(idr.stdout || '').includes('PACKET_IDENTITY_MISMATCH'), (idr.stdout || idr.stderr || '').slice(0, 220))
  // E8 非 canonical staged bytes（stage② 层直接复核）。
  // 注：冻结 c14n.mjs 扫描器不接受 `": "` 与数组 `[1, 2]` 内空格（58 例语料未覆盖的
  // 潜在不对称：PY 侧 json.loads 接受、JS 侧手写扫描器拒 INVALID_JSON）——stage②
  // 以冻结行为为准 fail-closed；生产管线中 stage① 已 canonicalize，正常路径不触此分支。
  const noncanon = join(work, 'noncanon.json')
  const prettyBytes = Buffer.from(JSON.stringify(c1.doc, null, 2), 'utf8')
  writeFileSync(noncanon, prettyBytes)
  const ncSha = createHash('sha256').update(prettyBytes).digest('hex')
  const rNc = verifyStagedCandidate({ stagingFile: noncanon, expectedSha256: ncSha, artifactType: c1.schema })
  check('E8 非 canonical bytes -> 拒绝（冻结 c14n：INVALID_JSON）', rNc.ok === false && rNc.errors[0].code === 'INVALID_JSON', JSON.stringify(rNc.errors).slice(0, 200))
}

console.log('design-validation: %d passed, %d failed', pass, fail)
rmSync(work, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
