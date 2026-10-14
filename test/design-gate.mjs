// design-gate mutation fixtures（v4：acceptance 链矩阵 + packet/绑定/缓存对抗全量）
// 覆盖：baseline / 字节篡改 / index 自篡改 / manifest / 多余与缺失文件 / mtime 保持 /
//       原子替换 / 绑定漂移 / decision / —— acceptance 链矩阵 ——
//       skeleton successor（旧记录被替代→无 active）/ 完整 successor（唯一 active→放行）/
//       不相关撤销不阻断 / 撤销 active→拒 / dangling 撤销→拒 / fork→拒 /
//       dangling supersedes→拒 / multiple active→拒 / 未知记录→拒 / malformed supersedes→拒。
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyDesignPacket, DESIGN_DIR } from '../src/design-gate.js'

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS', name) }
  else { fail += 1; console.log('  FAIL', name, extra ?? '') }
}

const GATE = 'CONTRACT_PACKET_UNREVIEWED'
const fails = (r) => r.ok === false && r.code === GATE
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const work = mkdtempSync(join(tmpdir(), 'design-gate-'))
let seq = 0
function freshCase() {
  seq += 1
  const dir = join(work, 'case-' + seq)
  cpSync(DESIGN_DIR, dir, { recursive: true })
  return { dir, packet: join(dir, 'packet'), design: dir }
}
const run = (c) => verifyDesignPacket({ packetDir: c.packet, designDir: c.design })
const curId = (c) => sha(join(c.design, 'acceptance.json'))

// ── A. baseline ──────────────────────────────────────────────────────
{
  const r = verifyDesignPacket()
  check('baseline ok (checked_files=79, active=acceptance.json)',
    r.ok === true && r.checked_files === 79 && r.acceptance_file === 'acceptance.json' && r.acceptance_id === sha(join(DESIGN_DIR, 'acceptance.json')),
    JSON.stringify(r))
}

// ── B. packet / 绑定 / 缓存对抗（原矩阵保留）──────────────────────────
{
  const c = freshCase()
  const f = join(c.packet, 'schemas', 'claim.json')
  writeFileSync(f, readFileSync(f, 'utf8') + ' ')
  check('schema byte tamper -> fail-closed', fails(run(c)), JSON.stringify(run(c)))
}
{
  const c = freshCase()
  const f = join(c.packet, 'meta', 'unicode-domain-table.json')
  writeFileSync(f, readFileSync(f, 'utf8') + ' ')
  check('unicode table tamper -> fail-closed', fails(run(c)))
}
{
  const c = freshCase()
  const f = join(c.packet, 'SHA256SUMS-packet.txt')
  const s = readFileSync(f, 'utf8')
  writeFileSync(f, (s[0] === '0' ? '1' : '0') + s.slice(1))
  check('index self-tamper -> fail-closed', fails(run(c)))
}
{
  const c = freshCase()
  const f = join(c.packet, 'bundle.manifest.json')
  writeFileSync(f, readFileSync(f, 'utf8') + ' ')
  check('manifest tamper -> fail-closed', fails(run(c)))
}
{
  const c = freshCase()
  writeFileSync(join(c.packet, 'UNREGISTERED.txt'), 'x')
  check('unregistered extra file -> fail-closed', fails(run(c)))
}
{
  const c = freshCase()
  rmSync(join(c.packet, 'schemas', 'claim.json'), { force: true })
  check('missing listed file -> fail-closed', fails(run(c)))
}
{
  const c = freshCase()
  const f = join(c.packet, 'meta', 'common.defs.json')
  const st = statSync(f)
  writeFileSync(f, readFileSync(f, 'utf8') + ' ')
  utimesSync(f, st.atime, st.mtime)
  check('mtime-preserved replacement -> fail-closed (no cache)', fails(run(c)))
}
{
  const c = freshCase()
  const f = join(c.packet, 'SHA256SUMS-packet.txt')
  const tmp = f + '.new'
  writeFileSync(tmp, readFileSync(f, 'utf8') + '\n')
  renameSync(tmp, f)
  check('atomic index replace -> fail-closed', fails(run(c)))
}
{
  const c = freshCase()
  const a = JSON.parse(readFileSync(join(c.design, 'acceptance.json'), 'utf8'))
  a.bindings.pattern_library_sha256 = '0'.repeat(64)
  writeFileSync(join(c.design, 'acceptance.json'), JSON.stringify(a, null, 2) + '\n')
  const r = run(c)
  check('acceptance binding drift -> fail-closed (no active)', fails(r) && String(r.detail).includes('no active'), JSON.stringify(r))
}
{
  const c = freshCase()
  const a = JSON.parse(readFileSync(join(c.design, 'acceptance.json'), 'utf8'))
  a.review.decision = 'rejected'
  writeFileSync(join(c.design, 'acceptance.json'), JSON.stringify(a, null, 2) + '\n')
  const r = run(c)
  check('acceptance not approved -> fail-closed', fails(r) && String(r.detail).includes('decision'), JSON.stringify(r))
}

// ── C. acceptance 链矩阵（v4 新增）───────────────────────────────────
// C1 skeleton successor（同审阅方手法）：旧记录被 supersedes 替代 → 无 active
{
  const c = freshCase()
  writeFileSync(join(c.design, 'acceptance-successor.json'),
    JSON.stringify({ record_type: 'packet_acceptance@1', supersedes: curId(c) }) + '\n')
  const r = run(c)
  check('C1 skeleton successor -> no active (fail-closed)', fails(r) && String(r.detail).includes('superseded'), JSON.stringify(r))
}
// C2 完整 successor（逐项与当前 packet 匹配）：旧被替代、新为唯一 active → 放行
{
  const c = freshCase()
  const doc = JSON.parse(readFileSync(join(c.design, 'acceptance.json'), 'utf8'))
  doc.supersedes = curId(c)
  writeFileSync(join(c.design, 'acceptance-successor.json'), JSON.stringify(doc, null, 2) + '\n')
  const newId = sha(join(c.design, 'acceptance-successor.json'))
  const r = run(c)
  check('C2 proper successor -> ok, successor is sole active',
    r.ok === true && r.acceptance_file === 'acceptance-successor.json' && r.acceptance_id === newId, JSON.stringify(r))
}
// C3 不相关撤销（撤销已被替代的旧记录）不阻断当前 active
{
  const c = freshCase()
  const oldId = curId(c)
  const doc = JSON.parse(readFileSync(join(c.design, 'acceptance.json'), 'utf8'))
  doc.supersedes = oldId
  writeFileSync(join(c.design, 'acceptance-successor.json'), JSON.stringify(doc, null, 2) + '\n')
  writeFileSync(join(c.design, 'acceptance-revoked.json'),
    JSON.stringify({ record_type: 'packet_acceptance_revocation@1', revokes: oldId }) + '\n')
  const r = run(c)
  check('C3 irrelevant revocation (old record) does not block active', r.ok === true && r.acceptance_file === 'acceptance-successor.json', JSON.stringify(r))
}
// C4 撤销 active → 拒
{
  const c = freshCase()
  const doc = JSON.parse(readFileSync(join(c.design, 'acceptance.json'), 'utf8'))
  doc.supersedes = curId(c)
  writeFileSync(join(c.design, 'acceptance-successor.json'), JSON.stringify(doc, null, 2) + '\n')
  const newId = sha(join(c.design, 'acceptance-successor.json'))
  writeFileSync(join(c.design, 'acceptance-revoked.json'),
    JSON.stringify({ record_type: 'packet_acceptance_revocation@1', revokes: newId }) + '\n')
  const r = run(c)
  check('C4 revocation of active -> fail-closed', fails(r) && String(r.detail).includes('revoked'), JSON.stringify(r))
}
// C5 dangling 撤销（target 不存在）→ 拒
{
  const c = freshCase()
  writeFileSync(join(c.design, 'acceptance-revoked.json'),
    JSON.stringify({ record_type: 'packet_acceptance_revocation@1', revokes: 'deadbeef'.padEnd(64, '0') }) + '\n')
  const r = run(c)
  check('C5 dangling revocation target -> fail-closed', fails(r) && String(r.detail).includes('revocation target mismatch'), JSON.stringify(r))
}
// C6 fork（同一 target 两个 successor）→ 拒
{
  const c = freshCase()
  const id = curId(c)
  writeFileSync(join(c.design, 'acceptance-successor-a.json'),
    JSON.stringify({ record_type: 'packet_acceptance@1', supersedes: id }) + '\n')
  writeFileSync(join(c.design, 'acceptance-successor-b.json'),
    JSON.stringify({ record_type: 'packet_acceptance@1', supersedes: id }) + '\n')
  const r = run(c)
  check('C6 supersedes fork -> fail-closed', fails(r) && String(r.detail).includes('fork'), JSON.stringify(r))
}
// C7 dangling supersedes（target 不存在）→ 拒
{
  const c = freshCase()
  writeFileSync(join(c.design, 'acceptance-successor.json'),
    JSON.stringify({ record_type: 'packet_acceptance@1', supersedes: 'deadbeef'.padEnd(64, '0') }) + '\n')
  const r = run(c)
  check('C7 dangling supersedes -> fail-closed', fails(r) && String(r.detail).includes('dangling supersedes'), JSON.stringify(r))
}
// C8 multiple active（第二份完整记录、无 supersedes 关系）→ 拒
{
  const c = freshCase()
  const doc = JSON.parse(readFileSync(join(c.design, 'acceptance.json'), 'utf8'))
  doc.supersedes = null
  writeFileSync(join(c.design, 'acceptance-second.json'), JSON.stringify(doc, null, 2) + '\n')
  const r = run(c)
  check('C8 multiple active -> fail-closed', fails(r) && String(r.detail).includes('multiple active'), JSON.stringify(r))
}
// C9 未知记录（record_type 不符）→ 拒
{
  const c = freshCase()
  writeFileSync(join(c.design, 'acceptance-weird.json'), JSON.stringify({ record_type: 'something_else' }) + '\n')
  const r = run(c)
  check('C9 unknown registry record -> fail-closed', fails(r) && String(r.detail).includes('unknown acceptance registry record'), JSON.stringify(r))
}
// C10 malformed supersedes → 拒
{
  const c = freshCase()
  writeFileSync(join(c.design, 'acceptance-successor.json'),
    JSON.stringify({ record_type: 'packet_acceptance@1', supersedes: 'not-a-hash' }) + '\n')
  const r = run(c)
  check('C10 malformed supersedes -> fail-closed', fails(r) && String(r.detail).includes('malformed supersedes'), JSON.stringify(r))
}

// ── D. successor 削减矩阵（v5 严格契约；全部应无 active）──────────────
{
  const reductions = [
    ['D1 successor 缺 locks', (d) => { delete d.bindings.locks }],
    ['D2 successor 空 spec_chain', (d) => { d.bindings.spec_chain = {} }],
    ['D3 successor 缺 report_sha256', (d) => { delete d.review.report_sha256 }],
    ['D4 successor 缺 policy_id', (d) => { delete d.review.policy_id }],
    ['D5 successor profile_rev 不符', (d) => { d.bindings.profile_rev = 'mismatch' }],
    ['D6 successor 未知 binding key', (d) => { d.bindings.extra_key = 'x' }],
    ['D7 successor 缺 reviewer', (d) => { delete d.review.reviewer }],
    ['D8 successor locks 值不符', (d) => { d.bindings.locks.npm_package_lock_sha256 = '0'.repeat(64) }],
  ]
  for (const [name, reduce] of reductions) {
    const c = freshCase()
    const doc = JSON.parse(readFileSync(join(c.design, 'acceptance.json'), 'utf8'))
    doc.supersedes = curId(c)
    reduce(doc)
    writeFileSync(join(c.design, 'acceptance-successor.json'), JSON.stringify(doc, null, 2) + '\n')
    const r = run(c)
    check(name + ' -> fail-closed（no active）', fails(r) && String(r.detail).includes('no active'), JSON.stringify(r))
  }
}

console.log('design-gate: %d passed, %d failed', pass, fail)
rmSync(work, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
