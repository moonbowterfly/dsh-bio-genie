// repair-tools 单元测试：normal profile 三工具注册 / 无 propose·verify·apply / 静态约束 / 运行时行为。
// 用法：node test/repair-tools.mjs
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME（bioRoot() 在调用时读取 env；必须在任何 store 调用前设置）
const dshHome = mkdtempSync(join(tmpdir(), 'dshbio-tools-home-'))
process.env.DSH_HOME = dshHome

const { registerTools } = await import('../src/tools.js')
const { issueObservationToken, computeFingerprint } = await import('../src/repair-capture.js')

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

function collect(cfg) {
  const defs = []
  const ctx = { tools: { register: (t) => { defs.push(t); return () => {} } } }
  registerTools(ctx, { enableLog: false, defaultTimeoutMs: 1000, ...cfg })
  return defs
}

// ① normal：恰好三件 repair 工具 + 无 propose/verify/apply + 名称唯一 + 总数
console.log('[tools] normal profile 注册面')
const normalDefs = collect({ repairMode: 'normal' })
const names = normalDefs.map((d) => d.name)
const repairNames = names.filter((n) => n.startsWith('bio_repair_')).sort()
check(
  JSON.stringify(repairNames) === JSON.stringify(['bio_repair_capture', 'bio_repair_ledger_verify', 'bio_repair_status']),
  `repair 工具恰为三件（${repairNames.join(', ')}）`,
)
for (const forbidden of ['bio_repair_propose', 'bio_repair_verify', 'bio_repair_apply', 'bio_repair_edit', 'bio_repair_publish']) {
  check(!names.includes(forbidden), `不注册 ${forbidden}`)
}
check(new Set(names).size === names.length, '工具名全局唯一')

// ② off：无任何 repair 工具；且 normal = off + 3（工具总数不写死——工具集随版本演进，
//    与 off 模式自对照，杜绝"改数字"式假绿）
console.log('[tools] repairMode=off')
const offDefs = collect({ repairMode: 'off' })
check(!offDefs.some((d) => d.name.startsWith('bio_repair_')), 'off 模式不注册任何 repair 工具')
check(normalDefs.length === offDefs.length + 3, `normal = off + 3 个 repair 工具（${normalDefs.length} = ${offDefs.length} + 3）`)

// ③ 静态约束：repair 模块不触 shell / Git / npm；L2 直写已断
console.log('[tools] 静态约束')
for (const f of ['repair-contract.js', 'repair-capture.js', 'repair-store.js', 'repair-ledger.js']) {
  const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
  check(!/child_process|execSync|spawnSync|\bspawn\s*\(|\bexec\s*\(/.test(src), `${f} 无子进程调用`)
  check(!/['"\u0060]git['"\u0060]|\bgit\s+(push|commit)|["\u0060]npm\s+publish/.test(src), `${f} 无 git/npm 命令字面量`)
}
{
  const toolsSrc = readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8')
  check(!/\brememberLesson\s*\(/.test(toolsSrc), 'tools.js 无 rememberLesson 调用（L2 直写已断）')
}

// ④ 运行时行为（隔离 DSH_HOME）
console.log('[tools] 运行时行为')
const captureTool = normalDefs.find((d) => d.name === 'bio_repair_capture')
const statusTool = normalDefs.find((d) => d.name === 'bio_repair_status')
const ledgerTool = normalDefs.find((d) => d.name === 'bio_repair_ledger_verify')
const incDir = join(dshHome, 'dsh-bio-genie', 'repair', 'incidents')
{
  const rBad = await captureTool.execute({ token: '11111111-2222-3333-4444-555555555555' })
  check(rBad.ok === false && rBad.code === 'TOKEN_UNKNOWN', '未知 token → TOKEN_UNKNOWN')
  check(!existsSync(incDir) || readdirSync(incDir).filter((f) => f.endsWith('.json')).length === 0, '失败 capture 未产生记录')
}
{
  const token = issueObservationToken()
  check(typeof token === 'string', 'issueObservationToken 可用（默认 root）')
  const rOk = await captureTool.execute({ token })
  check(rOk.ok === true && rOk.state === 'OBSERVED', `capture ok（${JSON.stringify(rOk)}）`)
  const rec = JSON.parse(readFileSync(join(incDir, `${rOk.incident_id}.json`), 'utf8'))
  const fp = computeFingerprint()
  check(rec.package_fingerprint.sources_sha256 === fp.sources_sha256, '记录指纹 = 当前安装指纹')
  check(rec.attribution === 'UNVERIFIED' && rec.privacy === 'SANITIZED', '语义固定（UNVERIFIED/SANITIZED）')
  const rReplay = await captureTool.execute({ token })
  check(rReplay.ok === false && rReplay.code === 'TOKEN_ALREADY_USED', '重放拒绝')
}
{
  const st = await statusTool.execute({})
  check(st.mode === 'proposal-only' && st.counts.incidents === 1 && st.integrity_ok === true, `status 摘要正确（incidents=${st.counts.incidents}）`)
  const lv = await ledgerTool.execute({})
  check(lv.ok === true && lv.checked === 1, `ledger_verify 通过（checked=${lv.checked}）`)
}

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
