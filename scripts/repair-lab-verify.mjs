#!/usr/bin/env node
/**
 * dsh-bio-genie — Repair Proposal v0：lab 验证入口（scripts/repair-lab-verify.mjs）
 *
 * **不进 npm 包、不注册给 desktop agent**；仅维护者在 repair lab 内、对
 * candidate worktree 之外的受信副本显式点火时使用（见 docs/repair-proposal-v0.md）。
 * 「候选运行时不能把工作树自己的这个文件作为信任根」——本入口必须从 lab 受信区
 * 运行（与候选树分离），其哈希记入 receipt。
 *
 * 用法：
 *   node scripts/repair-lab-verify.mjs \
 *     --trusted <受信目录> --base <base 树> --candidate <候选树> \
 *     --proposal <提案 uuid> --out <receipt.json 路径>
 *
 * 受信目录（maintainer 提供、hash 固定；与候选树分离）：
 *   repair-policy-v0.json  —— 策略（allowlist/deny；只从受信目录读，绝不读候选树）
 *   checker.mjs            —— 冻结 checker（node checker.mjs <tree>；exit 0=绿）
 *   MANIFEST.json          —— {"files": {文件名: sha256}}；逐文件核对，未列文件一律拒绝
 *
 * 判定（v0 合成语义）：base 必红（checker 非 0）+ 候选必绿（checker 0）+ 策略必过。
 * 输出：receipt（g-repair-receipt/v1，闭集校验后写盘）。退出码：
 *   0 = READY_FOR_MAINTAINER_REVIEW    1 = VERIFY_FAILED（receipt 仍产出，便于审计）
 *   2 = TRUSTED_INTEGRITY（受信被篡改）  3 = POLICY_REJECT（变更面越界/空变更）
 */
import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  newUuid, sha256Hex, validateProposalFiles, validateReceipt, SCHEMA_RECEIPT,
} from '../src/repair-contract.js'

function die(code, msg) {
  console.error(msg)
  process.exit(code)
}

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  if (required && !v) die(64, `usage: missing --${name}`)
  return v
}

const args = {
  trusted: resolve(arg('trusted')),
  base: resolve(arg('base')),
  candidate: resolve(arg('candidate')),
  proposal: arg('proposal'),
  out: resolve(arg('out')),
}

// ── ① 受信目录完整性（逐文件核对 MANIFEST；未列文件一律拒绝） ──
let manifest
try {
  manifest = JSON.parse(readFileSync(join(args.trusted, 'MANIFEST.json'), 'utf8'))
} catch {
  die(2, 'TRUSTED_INTEGRITY: MANIFEST.json unreadable')
}
const listed = Object.keys(manifest.files ?? {})
for (const f of listed) {
  let actual
  try {
    actual = sha256Hex(readFileSync(join(args.trusted, f)))
  } catch {
    die(2, `TRUSTED_INTEGRITY: missing ${f}`)
  }
  if (actual !== manifest.files[f]) die(2, `TRUSTED_INTEGRITY: hash mismatch ${f}`)
}
for (const f of readdirSync(args.trusted)) {
  if (f === 'MANIFEST.json') continue
  if (!listed.includes(f)) die(2, `TRUSTED_INTEGRITY: unlisted file ${f}`)
}

// ── ② 树扫描 + 变更面 ──
function scanTree(root, label) {
  const out = new Map()
  const walk = (dir, relBase) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue
      const full = join(dir, name)
      const rel = relBase ? `${relBase}/${name}` : name
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) die(3, `POLICY_REJECT: symlink/reparse not allowed (${label}/${rel})`)
      if (st.isDirectory()) {
        walk(full, rel)
      } else if (st.isFile()) {
        out.set(rel, sha256Hex(readFileSync(full)))
      } else {
        die(3, `POLICY_REJECT: non-regular file (${label}/${rel})`)
      }
    }
  }
  walk(root, '')
  return out
}

const baseMap = scanTree(args.base, 'base')
const candMap = scanTree(args.candidate, 'candidate')
const changes = []
for (const [rel] of candMap) if (!baseMap.has(rel)) changes.push({ path: rel, kind: 'add' })
for (const [rel, h] of baseMap) {
  if (!candMap.has(rel)) changes.push({ path: rel, kind: 'delete' })
  else if (candMap.get(rel) !== h) changes.push({ path: rel, kind: 'modify' })
}

// ── ③ 策略（只从受信目录读） ──
let policy
try {
  policy = JSON.parse(readFileSync(join(args.trusted, 'repair-policy-v0.json'), 'utf8'))
} catch {
  die(2, 'TRUSTED_INTEGRITY: repair-policy-v0.json unreadable')
}
const pv = validateProposalFiles(changes, policy)
if (!pv.ok) {
  die(3, `POLICY_REJECT: ${pv.rejects.slice(0, 3).map((x) => `${x.path} → ${x.reason}`).join('; ')}`)
}

// ── ④ 冻结 checker：base 必红、候选必绿 ──
const checkerPath = join(args.trusted, 'checker.mjs')
const rBase = spawnSync(process.execPath, [checkerPath, args.base], { timeout: 120_000 })
const rCand = spawnSync(process.execPath, [checkerPath, args.candidate], { timeout: 120_000 })
const baseRed = rBase.status !== 0
const patchGreen = rCand.status === 0

// ── ⑤ receipt（闭集校验后写盘） ──
const runnerPath = fileURLToPath(import.meta.url)
const vSha = sha256Hex(
  [runnerPath, checkerPath, join(args.trusted, 'repair-policy-v0.json')]
    .map((p) => sha256Hex(readFileSync(p)))
    .join('|'),
)
const changeLines = changes
  .map((c) => `${c.kind}:${c.path}:${candMap.get(c.path) ?? baseMap.get(c.path) ?? ''}`)
  .sort()
const patchSha = sha256Hex(changeLines.join('\n'))
const treeManifest = (m) => [...m.entries()].map(([k, v]) => `${k}:${v}`).sort().join('\n')
const mreSha = sha256Hex('base:' + treeManifest(baseMap))
const oracleSha = sha256Hex('checker:' + sha256Hex(readFileSync(checkerPath)))

const receipt = {
  schema: SCHEMA_RECEIPT,
  receipt_id: newUuid(),
  proposal_id: args.proposal,
  verifier: { id: 'verifier-local-1', version: 'v0', sha256: vSha },
  base_red: baseRed,
  patch_green: patchGreen,
  frozen_suite: baseRed && patchGreen ? 'PASS' : 'FAIL',
  policy_check: 'PASS',
  evidence: { patch_sha256: patchSha, mre_sha256: mreSha, oracle_sha256: oracleSha },
  result: baseRed && patchGreen ? 'READY_FOR_MAINTAINER_REVIEW' : 'VERIFY_FAILED',
  created_at: new Date().toISOString(),
}
const rv = validateReceipt(receipt)
if (!rv.ok) die(64, `receipt invalid: ${JSON.stringify(rv.errors.slice(0, 3))}`)
writeFileSync(args.out, JSON.stringify(receipt, null, 2) + '\n', 'utf8')

console.log(JSON.stringify({
  ok: receipt.result === 'READY_FOR_MAINTAINER_REVIEW',
  result: receipt.result,
  base_red: baseRed,
  patch_green: patchGreen,
  changes: changes.length,
  receipt_path: args.out,
}, null, 2))
process.exit(receipt.result === 'READY_FOR_MAINTAINER_REVIEW' ? 0 : 1)
