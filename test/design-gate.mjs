// design-gate mutation fixtures — acceptance 绑定核验 fail-closed 负测（v3 §A0.2 / §P0 证明③）
// 覆盖：字节篡改 / index 自篡改 / manifest / 绑定值漂移 / decision / 撤销记录 /
//       多余与缺失文件 / mtime 保持替换（缓存对抗）/ 原子替换。
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

const work = mkdtempSync(join(tmpdir(), 'design-gate-'))
let seq = 0
function freshCase() {
  seq += 1
  const dir = join(work, 'case-' + seq)
  cpSync(DESIGN_DIR, dir, { recursive: true })
  return { dir, packet: join(dir, 'packet'), acceptance: join(dir, 'acceptance.json') }
}

// 1) baseline：真树全绿
{
  const r = verifyDesignPacket()
  check('baseline ok (checked_files=79)', r.ok === true && r.checked_files === 79, JSON.stringify(r))
}

// 2) packet 字节篡改（schema）
{
  const c = freshCase()
  const f = join(c.packet, 'schemas', 'claim.json')
  writeFileSync(f, readFileSync(f, 'utf8') + ' ')
  const r = verifyDesignPacket({ packetDir: c.packet, acceptancePath: c.acceptance })
  check('schema byte tamper -> fail-closed', fails(r), JSON.stringify(r))
}

// 3) unicode 域表篡改
{
  const c = freshCase()
  const f = join(c.packet, 'meta', 'unicode-domain-table.json')
  writeFileSync(f, readFileSync(f, 'utf8') + ' ')
  const r = verifyDesignPacket({ packetDir: c.packet, acceptancePath: c.acceptance })
  check('unicode table tamper -> fail-closed', fails(r), JSON.stringify(r))
}

// 4) index 自身篡改（改首字符）→ index 自哈希不符
{
  const c = freshCase()
  const f = join(c.packet, 'SHA256SUMS-packet.txt')
  const s = readFileSync(f, 'utf8')
  writeFileSync(f, (s[0] === '0' ? '1' : '0') + s.slice(1))
  const r = verifyDesignPacket({ packetDir: c.packet, acceptancePath: c.acceptance })
  check('index self-tamper -> fail-closed', fails(r), JSON.stringify(r))
}

// 5) manifest 篡改
{
  const c = freshCase()
  const f = join(c.packet, 'bundle.manifest.json')
  writeFileSync(f, readFileSync(f, 'utf8') + ' ')
  const r = verifyDesignPacket({ packetDir: c.packet, acceptancePath: c.acceptance })
  check('manifest tamper -> fail-closed', fails(r), JSON.stringify(r))
}

// 6) acceptance 绑定值漂移（index 全过，显式绑定核对失败）
{
  const c = freshCase()
  const a = JSON.parse(readFileSync(c.acceptance, 'utf8'))
  a.bindings.pattern_library_sha256 = '0'.repeat(64)
  writeFileSync(c.acceptance, JSON.stringify(a, null, 2) + '\n')
  const r = verifyDesignPacket({ packetDir: c.packet, acceptancePath: c.acceptance })
  check('acceptance binding drift -> fail-closed', fails(r), JSON.stringify(r))
}

// 7) acceptance decision 非 approved
{
  const c = freshCase()
  const a = JSON.parse(readFileSync(c.acceptance, 'utf8'))
  a.review.decision = 'rejected'
  writeFileSync(c.acceptance, JSON.stringify(a, null, 2) + '\n')
  const r = verifyDesignPacket({ packetDir: c.packet, acceptancePath: c.acceptance })
  check('acceptance not approved -> fail-closed', fails(r), JSON.stringify(r))
}

// 8) 撤销记录（指向本记录）
{
  const c = freshCase()
  writeFileSync(join(c.dir, 'acceptance-revoked.json'),
    JSON.stringify({ record_type: 'packet_acceptance_revocation@1', revokes: 'e861329d5d9f96a163d9f89eb174e33f692a08258dfba37ce6daf38802a80801' }) + '\n')
  const r = verifyDesignPacket({ packetDir: c.packet, acceptancePath: c.acceptance })
  check('revocation record -> fail-closed', fails(r), JSON.stringify(r))
}

// 9) 多余文件（未登记）
{
  const c = freshCase()
  writeFileSync(join(c.packet, 'UNREGISTERED.txt'), 'x')
  const r = verifyDesignPacket({ packetDir: c.packet, acceptancePath: c.acceptance })
  check('unregistered extra file -> fail-closed', fails(r), JSON.stringify(r))
}

// 10) 缺失文件（删一个 index 登记的文件）
{
  const c = freshCase()
  rmSync(join(c.packet, 'schemas', 'claim.json'), { force: true })
  const r = verifyDesignPacket({ packetDir: c.packet, acceptancePath: c.acceptance })
  check('missing listed file -> fail-closed', fails(r), JSON.stringify(r))
}

// 11) mtime 保持替换（缓存对抗：内容变、mtime 还原）
{
  const c = freshCase()
  const f = join(c.packet, 'meta', 'common.defs.json')
  const st = statSync(f)
  writeFileSync(f, readFileSync(f, 'utf8') + ' ')
  utimesSync(f, st.atime, st.mtime)
  const r = verifyDesignPacket({ packetDir: c.packet, acceptancePath: c.acceptance })
  check('mtime-preserved replacement -> fail-closed (no cache)', fails(r), JSON.stringify(r))
}

// 12) 原子替换 index（rename 覆盖）
{
  const c = freshCase()
  const f = join(c.packet, 'SHA256SUMS-packet.txt')
  const tmp = f + '.new'
  writeFileSync(tmp, readFileSync(f, 'utf8') + '\n')
  renameSync(tmp, f)
  const r = verifyDesignPacket({ packetDir: c.packet, acceptancePath: c.acceptance })
  check('atomic index replace -> fail-closed', fails(r), JSON.stringify(r))
}

console.log('design-gate: %d passed, %d failed', pass, fail)
rmSync(work, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
