// repair-verify（lab）单元测试：lab 入口的对抗场景（base 红/候选绿/假绿/策略越界/受信篡改）。
// 用法：node test/repair-verify-lab.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { newUuid, sha256Hex, validateReceipt } from '../src/repair-contract.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RUNNER = join(ROOT, 'scripts', 'repair-lab-verify.mjs')
const UUID = () => newUuid()

/** 合成树：math.js 于 value=2 时满足 checker（"修复"）。 */
function mkTree(value) {
  const dir = mkdtempSync(join(tmpdir(), 'dshbio-lab-tree-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'math.js'), `export const two = ${value}\n`)
  return dir
}

/** 合成受信目录：策略（allowlist=['src/math.js']）+ 冻结 checker + MANIFEST。 */
function mkTrusted() {
  const dir = mkdtempSync(join(tmpdir(), 'dshbio-lab-trusted-'))
  const policy = {
    schema: 'g-repair-policy/v1',
    plugin_id: 'dsh-bio-genie',
    mode: 'proposal-only',
    capture: { source_kinds: ['bio_python'], symptom_classes: ['PYTHON_TRACEBACK'], max_captures_per_hour: 20 },
    proposal: { enabled: false, allowed_files: ['src/math.js'], exact_deny: ['package.json'], prefix_deny: ['scripts/', 'test/'], suffix_deny: ['.exe'] },
    limits: { max_field_len: 512, max_incidents: 500, max_receipts: 500, max_lessons: 100, max_captures_per_hour: 20 },
  }
  const checker = [
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'const tree = process.argv[2]',
    "const text = readFileSync(join(tree, 'src', 'math.js'), 'utf8')",
    "process.exit(text.includes('two = 2') ? 0 : 1)",
    '',
  ].join('\n')
  writeFileSync(join(dir, 'repair-policy-v0.json'), JSON.stringify(policy, null, 2))
  writeFileSync(join(dir, 'checker.mjs'), checker)
  const manifest = {
    files: {
      'repair-policy-v0.json': sha256Hex(readFileSync(join(dir, 'repair-policy-v0.json'))),
      'checker.mjs': sha256Hex(readFileSync(join(dir, 'checker.mjs'))),
    },
  }
  writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))
  return dir
}

const mkOut = () => join(mkdtempSync(join(tmpdir(), 'dshbio-lab-out-')), 'receipt.json')
const run = (a) => spawnSync(process.execPath, [RUNNER, ...a], { encoding: 'utf8', timeout: 120_000 })

// ① 正常路径：base 必红 + 候选必绿 → READY，receipt 落盘
console.log('[lab] 正常路径')
{
  const r = run(['--trusted', mkTrusted(), '--base', mkTree(1), '--candidate', mkTree(2), '--proposal', UUID(), '--out', mkOut()])
  assert(r.status === 0, `exit 0（实际 ${r.status}；stderr=${String(r.stderr).slice(0, 140)}）`)
}

// ② 候选未修复（“假绿”不成立）→ VERIFY_FAILED + receipt
console.log('[lab] 对抗场景')
{
  const out = mkOut()
  const r = run(['--trusted', mkTrusted(), '--base', mkTree(1), '--candidate', mkTree(3), '--proposal', UUID(), '--out', out])
  assert(r.status === 1, `候选不绿 → exit 1（实际 ${r.status}）`)
  const receipt = JSON.parse(readFileSync(out, 'utf8'))
  assert(receipt.patch_green === false && receipt.result === 'VERIFY_FAILED', 'VERIFY_FAILED 落 receipt')
}
// ③ base 本已绿（checker 不能自证其红）→ VERIFY_FAILED
{
  const r = run(['--trusted', mkTrusted(), '--base', mkTree(2), '--candidate', mkTree(3), '--proposal', UUID(), '--out', mkOut()])
  assert(r.status === 1, `base 不红 → exit 1（实际 ${r.status}）`)
}
// ④ 策略越界：候选夹带 package.json → POLICY_REJECT，不产 receipt
{
  const cand = mkTree(2)
  writeFileSync(join(cand, 'package.json'), '{}\n')
  const out = mkOut()
  const r = run(['--trusted', mkTrusted(), '--base', mkTree(1), '--candidate', cand, '--proposal', UUID(), '--out', out])
  assert(r.status === 3 && String(r.stderr).includes('POLICY_REJECT'), `策略越界 → exit 3（实际 ${r.status}）`)
  let exists = true
  try { readFileSync(out) } catch { exists = false }
  assert(!exists, '策略拒绝不产出 receipt')
}
// ⑤ 受信篡改（checker 被改）→ TRUSTED_INTEGRITY
{
  const trusted = mkTrusted()
  writeFileSync(join(trusted, 'checker.mjs'), 'process.exit(0)\n')
  const r = run(['--trusted', trusted, '--base', mkTree(1), '--candidate', mkTree(2), '--proposal', UUID(), '--out', mkOut()])
  assert(r.status === 2 && String(r.stderr).includes('TRUSTED_INTEGRITY'), `受信篡改 → exit 2（实际 ${r.status}）`)
}
// ⑥ 空变更（候选与 base 相同）→ POLICY_REJECT
{
  const same = mkTree(1)
  const r = run(['--trusted', mkTrusted(), '--base', same, '--candidate', same, '--proposal', UUID(), '--out', mkOut()])
  assert(r.status === 3, `空变更 → exit 3（实际 ${r.status}）`)
}
// ⑦ receipt 闭集校验（从 ① 重跑一遍取点位）
{
  const out = mkOut()
  const pid = UUID()
  const r = run(['--trusted', mkTrusted(), '--base', mkTree(1), '--candidate', mkTree(2), '--proposal', pid, '--out', out])
  assert(r.status === 0, '重跑正常路径')
  const receipt = JSON.parse(readFileSync(out, 'utf8'))
  assert(validateReceipt(receipt).ok, 'receipt 通过 g-repair-receipt/v1 闭集校验')
  assert(receipt.proposal_id === pid && receipt.verifier.version === 'v0', 'proposal 绑定 + verifier 版本')
  assert(receipt.frozen_suite === 'PASS' && receipt.policy_check === 'PASS', 'frozen_suite/policy_check = PASS')
}

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
