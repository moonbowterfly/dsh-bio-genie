/**
 * dsh-bio-genie — design packet enable gate（acceptance 注册表 + 链解析；fail-closed）
 *
 * 在任何 Python spawn / cache 命中 / registry mutation 之前执行（v3 §A0.2；v4 链模型）：
 *
 * 1) **acceptance 注册表（内容 hash 身份）**：扫描 design/ 下全部 `acceptance*.json`：
 *    - 记录：record_type=packet_acceptance@1；id = sha256(文件字节)；supersedes = 64hex|null
 *    - 撤销：`acceptance-revoked.json` / `acceptance-revocation*.json`；record_type=
 *      packet_acceptance_revocation@1；revokes = 64hex
 *    未知/损坏记录 → fail-closed。
 * 2) **链结构校验**：fork（同一 target 多个 successor）/ dangling supersedes /
 *    dangling revocation target / 防御性 cycle 检测 → 全部 fail-closed。
 *    （内容哈希身份下环不可构造；检测保留为纵深防御。superseded 记录必须保留在注册表中。）
 * 3) **packet 磁盘核验**：index 全量集合逐文件重算 + 多余文件扫描。
 * 4) **候选**：packet_index_sha256 / bundle_manifest_sha256 与当前磁盘精确匹配、
 *    **严格契约（v5）**：完整审阅身份（policy/report/reviewer/decision）+ exact-key 绑定集
 *    （profile/spec_chain/corpora/pattern/unicode/common defs/两份 lock）+ 逐字段对照
 *    BINDINGS.json；随后全部绑定文件字节核验（含 provenance）。
 * 5) **active 判定**：候选 ∩ 未被 supersedes ∩ 未被 revokes → **恰一条**；
 *    0 条 / ≥2 条 / 被 successor 替代 / 被撤销 → fail-closed。
 * 6) **bundle loader**：经 packet 自带 loader（manifest 驱动）结构核验（「loader 全过」为字面真）。
 *
 * 失败 → { ok:false, code:'CONTRACT_PACKET_UNREVIEWED', detail }——绝不静默降级。
 * 设计上**不设缓存**：每次全量核验（百毫秒级）；缓存对抗（原子替换 / mtime 保持 /
 * 后继 acceptance / cache-hit）因此天然免疫（v3 §A0.2）。
 * @module dsh-bio-genie/design-gate
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DESIGN_DIR = resolve(HERE, '..', 'design')
export const PACKET_DIR = join(DESIGN_DIR, 'packet')
export const ACCEPTANCE_PATH = join(DESIGN_DIR, 'acceptance.json')

const GATE_CODE = 'CONTRACT_PACKET_UNREVIEWED'
const INDEX_NAME = 'SHA256SUMS-packet.txt'
const H64 = /^[0-9a-f]{64}$/

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function fail(detail) {
  return { ok: false, code: GATE_CODE, detail: String(detail).slice(0, 300) }
}

/** 扫描 packet 目录中未登记的文件（排除索引自身 / pyc / __pycache__）。 */
function scanExtras(root, allowed) {
  const extras = []
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const r = rel ? rel + '/' + name : name
      const st = statSync(full)
      if (st.isDirectory()) {
        if (name === '__pycache__') continue
        walk(full, r)
      } else if (name.endsWith('.pyc')) {
        continue
      } else if (!allowed.has(r)) {
        extras.push(r)
      }
    }
  }
  walk(root, '')
  return extras
}

/** 全部绑定逐项核验（对某条 acceptance 记录；返回 problems 数组）。 */
function verifyBindings(acc, packetDir, designDir) {
  const problems = []
  const b = acc.bindings || {}
  const inPacket = [
    ['pattern_library_sha256', 'meta/pattern-library.json'],
    ['unicode_domain_table_sha256', 'meta/unicode-domain-table.json'],
    ['common_defs_sha256', 'meta/common.defs.json'],
  ]
  for (const [key, rel] of inPacket) {
    if (!b[key]) { problems.push('binding missing: ' + key); continue }
    const got = sha256File(join(packetDir, rel))
    if (got !== b[key]) problems.push('binding drift ' + key)
  }
  const corpora = [['c14n', 'corpus/c14n_cases.json'], ['schema', 'schema-corpus/schema_cases.json']]
  for (const [key, rel] of corpora) {
    if (!b.corpora?.[key]) { problems.push('binding missing: corpora.' + key); continue }
    const got = sha256File(join(packetDir, rel))
    if (got !== b.corpora[key]) problems.push('binding drift corpora.' + key)
  }
  if (b.locks && typeof b.locks === 'object') {
    const locks = [['npm_package_lock_sha256', 'locks/node/package-lock.json'], ['python_requirements_lock_sha256', 'locks/python/requirements.lock']]
    for (const [key, rel] of locks) {
      if (!b.locks[key]) continue
      const got = sha256File(join(packetDir, rel))
      if (got !== b.locks[key]) problems.push('binding drift locks.' + key)
    }
  }
  if (!b.profile_sha256) problems.push('binding missing: profile_sha256')
  else {
    const profPath = join(designDir, 'provenance', 'casefile-c14n-1.profile.md')
    if (!existsSync(profPath)) problems.push('provenance profile missing')
    else if (sha256File(profPath) !== b.profile_sha256) problems.push('binding drift profile')
  }
  if (!b.spec_chain || typeof b.spec_chain !== 'object') problems.push('binding missing: spec_chain')
  else {
    for (const [v, want] of Object.entries(b.spec_chain)) {
      const p = join(designDir, 'provenance', 'genie-synbio-design-spec-' + v + '-2026-10-13.md')
      if (!existsSync(p)) { problems.push('provenance spec missing: ' + v); continue }
      if (sha256File(p) !== want) problems.push('binding drift spec_chain.' + v)
    }
  }
  return problems
}

/** 严格 acceptance 契约（v5）：完整审阅身份 + exact-key 绑定集 + 逐字段对照 BINDINGS.json。 */
function strictAcceptanceProblems(acc, bindingsDoc) {
  const problems = []
  const p = acc.packet || {}
  if (!H64.test(String(p.packet_index_sha256 || ''))) problems.push('packet_index_sha256 missing/malformed')
  if (!H64.test(String(p.bundle_manifest_sha256 || ''))) problems.push('bundle_manifest_sha256 missing/malformed')
  const r = acc.review || {}
  if (typeof r.policy_id !== 'string' || !r.policy_id) problems.push('review.policy_id missing')
  if (!H64.test(String(r.policy_sha256 || ''))) problems.push('review.policy_sha256 missing/malformed')
  if (typeof r.report_path !== 'string' || !r.report_path) problems.push('review.report_path missing')
  if (!H64.test(String(r.report_sha256 || ''))) problems.push('review.report_sha256 missing/malformed')
  if (typeof r.reviewer !== 'string' || !r.reviewer) problems.push('review.reviewer missing')
  if (r.decision !== 'approved') problems.push('review.decision != approved')
  if ((r.blocker_count ?? 1) !== 0) problems.push('review.blocker_count != 0')
  const b = acc.bindings || {}
  const allowed = new Set(['profile_id', 'profile_rev', 'profile_sha256', 'spec_chain', 'pattern_library_sha256', 'unicode_domain_table_sha256', 'common_defs_sha256', 'corpora', 'locks'])
  for (const k of Object.keys(b)) {
    if (!allowed.has(k)) problems.push('unknown binding key: ' + k)
  }
  for (const k of allowed) {
    if (!(k in b)) problems.push('binding missing: ' + k)
  }
  if (!bindingsDoc || typeof bindingsDoc !== 'object') {
    problems.push('BINDINGS.json unavailable')
    return problems
  }
  const eq = (a, c, label) => {
    if (String(a) !== String(c)) problems.push('binding mismatch vs BINDINGS: ' + label)
  }
  eq(b.profile_id, bindingsDoc.profile?.id, 'profile_id')
  eq(b.profile_rev, bindingsDoc.profile?.rev, 'profile_rev')
  eq(b.profile_sha256, bindingsDoc.profile?.sha256, 'profile_sha256')
  {
    const bs = b.spec_chain || {}
    const Bs = bindingsDoc.spec_chain || {}
    if (Object.keys(bs).sort().join(',') !== Object.keys(Bs).sort().join(',')) problems.push('spec_chain key set mismatch vs BINDINGS')
    for (const k of Object.keys(Bs)) eq(bs[k], Bs[k], 'spec_chain.' + k)
  }
  eq(b.pattern_library_sha256, bindingsDoc.pattern_library?.sha256, 'pattern_library_sha256')
  eq(b.unicode_domain_table_sha256, bindingsDoc.unicode_domain_table?.sha256, 'unicode_domain_table_sha256')
  eq(b.common_defs_sha256, bindingsDoc.common_defs?.sha256, 'common_defs_sha256')
  eq(b.corpora?.c14n, bindingsDoc.corpora?.c14n, 'corpora.c14n')
  eq(b.corpora?.schema, bindingsDoc.corpora?.schema, 'corpora.schema')
  eq(b.locks?.npm_package_lock_sha256, bindingsDoc.locks?.npm_package_lock_sha256, 'locks.npm_package_lock_sha256')
  eq(b.locks?.python_requirements_lock_sha256, bindingsDoc.locks?.python_requirements_lock_sha256, 'locks.python_requirements_lock_sha256')
  return problems
}

/**
 * 全量核验 design packet（acceptance 链 + packet 完整性 + 全部绑定 + loader）。
 * 返回 { ok:true, manifest_sha256, index_sha256, checked_files, acceptance_id, acceptance_file }
 * 或 { ok:false, code, detail }。
 */
export function verifyDesignPacket({ packetDir = PACKET_DIR, designDir = DESIGN_DIR } = {}) {
  // ── 1) acceptance 注册表发现与解析 ────────────────────────────────────
  if (!existsSync(designDir)) return fail('design dir missing: ' + designDir)
  const names = readdirSync(designDir).filter((n) => n.startsWith('acceptance') && n.endsWith('.json')).sort()
  const records = []
  const revocations = []
  const problems = []
  for (const name of names) {
    const p = join(designDir, name)
    const isRev = name === 'acceptance-revoked.json' || /^acceptance-revocation.*\.json$/.test(name)
    let doc
    try {
      doc = JSON.parse(readFileSync(p, 'utf8'))
    } catch (e) {
      problems.push('unreadable record ' + name + ': ' + e.message)
      continue
    }
    const id = sha256File(p)
    if (isRev) {
      if (!doc || doc.record_type !== 'packet_acceptance_revocation@1') { problems.push('malformed revocation record: ' + name); continue }
      if (typeof doc.revokes !== 'string' || !H64.test(doc.revokes)) { problems.push('malformed revocation target in ' + name); continue }
      revocations.push({ name, id, revokes: doc.revokes })
    } else {
      if (!doc || doc.record_type !== 'packet_acceptance@1') { problems.push('unknown acceptance registry record: ' + name); continue }
      let sup = null
      if (doc.supersedes != null) {
        if (typeof doc.supersedes !== 'string' || !H64.test(doc.supersedes)) { problems.push('malformed supersedes in ' + name); continue }
        sup = doc.supersedes
      }
      records.push({ name, id, doc, supersedes: sup })
    }
  }
  if (problems.length) return fail('acceptance registry: ' + problems[0])
  if (records.length === 0) return fail('no acceptance records in ' + designDir)

  // ── 2) 链结构校验（fork / dangling / cycle / revocation target）────────
  const ids = new Set(records.map((r) => r.id))
  const bySup = new Map()
  for (const r of records) {
    if (r.supersedes) {
      const arr = bySup.get(r.supersedes) || []
      arr.push(r.name)
      bySup.set(r.supersedes, arr)
    }
  }
  for (const [t, arr] of bySup) {
    if (arr.length > 1) return fail('supersedes fork: target ' + t.slice(0, 16) + ' has successors ' + arr.join(','))
  }
  for (const r of records) {
    if (r.supersedes && !ids.has(r.supersedes)) {
      return fail('dangling supersedes in ' + r.name + ': ' + r.supersedes.slice(0, 16) + ' matches no present record')
    }
  }
  {
    const byId = new Map(records.map((r) => [r.id, r]))
    for (const r of records) {
      let cur = r
      let steps = 0
      while (cur && cur.supersedes) {
        cur = byId.get(cur.supersedes)
        steps += 1
        if (steps > records.length) return fail('supersedes cycle involving ' + r.name)
      }
    }
  }
  for (const v of revocations) {
    if (!ids.has(v.revokes)) return fail('revocation target mismatch in ' + v.name + ': ' + v.revokes.slice(0, 16) + ' matches no present record')
  }

  // ── 3) packet 磁盘核验（index 全量集合 + extras）──────────────────────
  const indexPath = join(packetDir, INDEX_NAME)
  if (!existsSync(indexPath)) return fail('packet index missing')
  const indexSha = sha256File(indexPath)
  const listed = new Map()
  for (const ln of readFileSync(indexPath, 'utf8').split('\n')) {
    if (!ln) continue
    const sp = ln.indexOf('  ')
    if (sp !== 64) return fail('index line malformed: ' + ln.slice(0, 60))
    const h = ln.slice(0, 64)
    const rel = ln.slice(66)
    if (!H64.test(h)) return fail('index hash malformed: ' + rel)
    listed.set(rel, h)
  }
  if (listed.size === 0) return fail('packet index empty')
  for (const [rel, want] of listed) {
    const p = join(packetDir, rel)
    if (!existsSync(p)) return fail('listed file missing: ' + rel)
    const got = sha256File(p)
    if (got !== want) return fail('hash mismatch ' + rel + ' disk=' + got.slice(0, 16) + ' listed=' + want.slice(0, 16))
  }
  const allowed = new Set([...listed.keys(), INDEX_NAME])
  const extras = scanExtras(packetDir, allowed)
  if (extras.length) return fail('unregistered extra files: ' + extras.slice(0, 5).join(', '))
  const manifestPath = join(packetDir, 'bundle.manifest.json')
  if (!existsSync(manifestPath)) return fail('bundle manifest missing')
  const manifestSha = sha256File(manifestPath)
  let bindingsDoc = null
  try {
    bindingsDoc = JSON.parse(readFileSync(join(packetDir, 'BINDINGS.json'), 'utf8'))
  } catch {
    bindingsDoc = null
  }

  // ── 4) 候选：与当前 packet 精确匹配 + approved + 绑定全过 ─────────────
  const candidates = []
  const candidateProblems = []
  for (const r of records) {
    const acc = r.doc
    if (String(acc.packet?.packet_index_sha256 || '') !== indexSha) continue
    if (String(acc.packet?.bundle_manifest_sha256 || '') !== manifestSha) continue
    const sp = strictAcceptanceProblems(acc, bindingsDoc)
    if (sp.length) { candidateProblems.push(r.name + ': ' + sp[0]); continue }
    const bp = verifyBindings(acc, packetDir, designDir)
    if (bp.length) { candidateProblems.push(r.name + ': ' + bp[0]); continue }
    candidates.push(r)
  }

  // ── 5) active 判定：候选 ∩ 未 superseded ∩ 未 revoked → 恰一条 ────────
  const supersededBy = new Map()
  for (const r of records) if (r.supersedes) supersededBy.set(r.supersedes, r.name)
  const revokedBy = new Map()
  for (const v of revocations) revokedBy.set(v.revokes, v.name)
  const active = candidates.filter((r) => !supersededBy.has(r.id) && !revokedBy.has(r.id))
  if (active.length === 0) {
    const diag = []
    for (const r of candidates) {
      if (supersededBy.has(r.id)) diag.push(r.name + ' superseded by ' + supersededBy.get(r.id))
      else if (revokedBy.has(r.id)) diag.push(r.name + ' revoked by ' + revokedBy.get(r.id))
    }
    for (const d of candidateProblems) diag.push(d)
    return fail('no active acceptance for current packet' + (diag.length ? ' (' + diag.slice(0, 3).join('; ') + ')' : ''))
  }
  if (active.length > 1) return fail('multiple active acceptances: ' + active.map((r) => r.name).join(', '))
  const winner = active[0]

  // ── 6) bundle loader（manifest 驱动结构核验；「loader 全过」为字面真）──
  try {
    const req = createRequire(import.meta.url)
    const loader = req(join(packetDir, 'build', 'bundle_loader.mjs'))
    const res = loader.loadBundle(packetDir)
    if (res.problems.length) return fail('bundle loader problems: ' + res.problems[0])
  } catch (e) {
    return fail('bundle loader unavailable: ' + String(e.message).slice(0, 160))
  }

  return {
    ok: true,
    manifest_sha256: manifestSha,
    index_sha256: indexSha,
    checked_files: listed.size,
    acceptance_id: winner.id,
    acceptance_file: winner.name,
  }
}
