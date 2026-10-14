// design-mutation-runner.mjs — A0/D1 变异执行器测试
// 运行：node test/design-mutation-runner.mjs
// 覆盖（任务书三条必测）：
//   ① 已知可杀变异被杀（真实 M1：packet hash 篡改 → design-gate 门）；
//   ② 还原成功（注入文件字节与注入前逐字节一致 + git 无 packet/policy/acceptance 改动）；
//   ③ 泛化错误不算击杀（构造 parse-error 场景：门红但无期望失败类别 → killed=false）。
// 另附：not_yet_runnable 条目被显式跳过（skipped + exit 0）。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PY = process.env.DSH_BIO_PYTHON || 'python'
const RUNNER = join(ROOT, 'scripts', 'design_mutation_runner.py')
const MATRIX = join(ROOT, 'design', 'mutation-matrix.json')

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

function runRunner(args) {
  const r = spawnSync(PY, [RUNNER, ...args], { encoding: 'utf8', timeout: 240000 })
  let json = null
  try { json = JSON.parse(r.stdout) } catch { /* asserted below */ }
  return { status: r.status, json, stderr: String(r.stderr || '') }
}

// ── ① 已知可杀变异被杀（真实 M1）───────────────────────────────────
{
  const before = readFileSync(join(ROOT, 'design', 'packet', 'schemas', 'claim.json'))
  const { status, json, stderr } = runRunner(['--matrix', MATRIX, '--id', 'M1'])
  const r = json?.results?.[0]
  check('A1 runner exit 0 (killed)', status === 0, 'status=' + status + ' stderr=' + stderr.slice(-200))
  check('A2 killed=true', r?.killed === true, JSON.stringify(r))
  check('A3 observed==expected (CONTRACT_PACKET_UNREVIEWED)',
    r?.observed_failure_class === 'CONTRACT_PACKET_UNREVIEWED' && r?.expected_failure_class === 'CONTRACT_PACKET_UNREVIEWED',
    JSON.stringify(r))
  check('A4 injection_precondition_passed + target_gate_reached',
    r?.injection_precondition_passed === true && r?.target_gate_reached === true, JSON.stringify(r))
  check('A5 gate 确实红了（exit code != 0）', r?.gate_exit_code !== undefined && r?.gate_exit_code !== 0, 'exit=' + r?.gate_exit_code)
  check('A6 restore_verified=true', r?.restore_verified === true, JSON.stringify(r))

  // ── ② 还原成功（字节一致 + git 干净）──────────────────────────────
  const after = readFileSync(join(ROOT, 'design', 'packet', 'schemas', 'claim.json'))
  check('B1 claim.json 字节与注入前逐字节一致', before.equals(after), 'len before=' + before.length + ' after=' + after.length)
  const git = spawnSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' })
  const dirty = (git.stdout || '').split('\n').filter((l) => /design\/packet|design\/capability-policy|design\/acceptance/.test(l))
  check('B2 git 无 packet/policy/acceptance 路径改动', dirty.length === 0, dirty.join('|'))
}

// ── ③ 泛化错误不算击杀（parse-error 场景）──────────────────────────
{
  const work = mkdtempSync(join(tmpdir(), 'design-mut-'))
  try {
    const target = join(work, 'victim.txt')
    writeFileSync(target, 'ORIGINAL-BYTES')
    const matrix = join(work, 'matrix.json')
    writeFileSync(matrix, JSON.stringify({
      matrix_id: 'test-parse-error@1',
      mutations: [{
        mutation_id: 'T-PARSE',
        name: 'generic-parse-error',
        owner: 'P0b-fixture',
        summary: 'test only: gate dies with a generic parse error, no expected failure class',
        injection: { kind: 'append_bytes', target, delta: 'x' },
        target_gate: { command: ['node', '-e', 'this is not valid javascript !!!'], timeout_ms: 30000 },
        expected_status: 'deny',
        expected_reason: 'CONTRACT_PACKET_UNREVIEWED',
        expected_failure_class: 'CONTRACT_PACKET_UNREVIEWED',
        check_id: 'test',
        not_yet_runnable: false,
      }],
    }))
    const { status, json } = runRunner(['--matrix', matrix, '--id', 'T-PARSE'])
    const r = json?.results?.[0]
    check('C1 门确实红了（parse error → exit != 0）', r?.gate_exit_code !== 0 && r?.gate_exit_code !== undefined, 'exit=' + r?.gate_exit_code)
    check('C2 killed=false（泛化错误不计击杀）', r?.killed === false, JSON.stringify(r))
    check('C3 observed=GENERIC_FAILURE（期望类别未出现）', r?.observed_failure_class === 'GENERIC_FAILURE', JSON.stringify(r))
    check('C4 survivor_reason 明确说明期望类别未观察到', /expected failure class/.test(r?.survivor_reason || ''), r?.survivor_reason)
    check('C5 runner exit 1（survivor 非零）', status === 1, 'status=' + status)
    check('C6 临时注入文件已还原', readFileSync(target, 'utf8') === 'ORIGINAL-BYTES')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ── 附：not_yet_runnable 条目显式跳过 ──────────────────────────────
{
  const { status, json } = runRunner(['--matrix', MATRIX, '--id', 'M0'])
  const r = json?.results?.[0]
  check('D1 M0 skipped=true executed=false', r?.skipped === true && r?.executed === false, JSON.stringify(r))
  check('D2 M0 exit 0（跳过非错误）', status === 0, 'status=' + status)
}

console.log('design-mutation-runner: %d passed, %d failed', pass, fail)
process.exit(fail === 0 ? 0 : 1)
