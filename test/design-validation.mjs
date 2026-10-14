// design-validation.mjs — v4 §A0.3：双端等价性（99 例 vs packet 冻结结果）+ 三阶段接线 E2E + 定向变异
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatchDesignOp, verifyStagedCandidate } from '../src/design-dispatch.js'
import { validateDesignArtifact } from '../src/design-validate.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKET = join(ROOT, 'design', 'packet')
const CORPUS = join(PACKET, 'schema-corpus', 'schema_cases.json')
const home = process.env.USERPROFILE || process.env.HOME
const VENV = process.env.DSH_BIO_PYTHON || join(home, '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe')

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
  const r2 = spawnSync(VENV, [join(ROOT, 'python', 'design_validate.py'), '--batch', CORPUS, '--out', pyOut], { encoding: 'utf8', timeout: 300000 })
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
  const res = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: c1.schema, value: c1.doc }, { cwd: dir1, timeoutMs: 180000 })
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
  const res2 = await dispatchDesignOp(VENV, 'design_stage_artifact', { artifact_type: c2.schema, value: c2.doc }, { cwd: dir2, timeoutMs: 180000 })
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
}

console.log('design-validation: %d passed, %d failed', pass, fail)
rmSync(work, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
