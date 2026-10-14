/**
 * dsh-bio-genie — design packet enable gate（acceptance 绑定核验；fail-closed）
 *
 * 在任何 Python spawn / cache 命中 / registry mutation 之前执行（v3 §A0.2）：
 *   1. acceptance 记录：packet_acceptance@1 + approved + blocker_count=0；
 *      未被撤销（存在指向本记录的 revocation 记录 → fail-closed）
 *   2. packet index 全量集合：逐条目重算 sha256 + 多余/缺失文件扫描 +
 *      index 自身 sha256 == acceptance.packet.packet_index_sha256
 *   3. bundle manifest 哈希 == acceptance.packet.bundle_manifest_sha256
 *   4. 全部绑定逐项核验：pattern-library / unicode-domain / common.defs /
 *      corpora / locks（packet 内）+ profile / spec chain（design/provenance/）
 * 失败 → { ok:false, code:'CONTRACT_PACKET_UNREVIEWED', detail }——绝不静默降级。
 *
 * 设计上**不设缓存**：每次调用全量核验（百毫秒级）。状态机正确性优先于性能；
 * 缓存对抗（原子替换 / mtime 保持 / 后继 acceptance）因此天然免疫（v3 §A0.2）。
 * @module dsh-bio-genie/design-gate
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DESIGN_DIR = resolve(HERE, '..', 'design')
export const PACKET_DIR = join(DESIGN_DIR, 'packet')
export const ACCEPTANCE_PATH = join(DESIGN_DIR, 'acceptance.json')

const GATE_CODE = 'CONTRACT_PACKET_UNREVIEWED'
const INDEX_NAME = 'SHA256SUMS-packet.txt'

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

/**
 * 全量核验 design packet。返回 { ok:true, manifest_sha256, index_sha256, checked_files }
 * 或 { ok:false, code, detail }。
 */
export function verifyDesignPacket({ packetDir = PACKET_DIR, acceptancePath = ACCEPTANCE_PATH } = {}) {
  // ── 1) acceptance 记录 ────────────────────────────────────────────────
  if (!existsSync(acceptancePath)) return fail('acceptance record missing: ' + acceptancePath)
  let acc
  try {
    acc = JSON.parse(readFileSync(acceptancePath, 'utf8'))
  } catch (e) {
    return fail('acceptance unreadable: ' + e.message)
  }
  if (acc.record_type !== 'packet_acceptance@1') return fail('acceptance record_type invalid')
  if (acc.review?.decision !== 'approved') return fail('acceptance decision is not approved')
  if ((acc.review?.blocker_count ?? 1) !== 0) return fail('acceptance blocker_count != 0')

  // 1b) 撤销：任何指向本记录的 revocation 记录 → fail-closed
  const revPath = join(dirname(acceptancePath), 'acceptance-revoked.json')
  if (existsSync(revPath)) {
    try {
      const rev = JSON.parse(readFileSync(revPath, 'utf8'))
      if (rev.record_type === 'packet_acceptance_revocation@1') {
        return fail('acceptance revoked (revokes=' + String(rev.revokes).slice(0, 16) + ')')
      }
      return fail('unrecognized revocation record present')
    } catch (e) {
      return fail('revocation record unreadable: ' + e.message)
    }
  }

  // ── 2) packet index 全量集合 ─────────────────────────────────────────
  const indexPath = join(packetDir, INDEX_NAME)
  if (!existsSync(indexPath)) return fail('packet index missing')
  const indexSha = sha256File(indexPath)
  const expectedIndexSha = String(acc.packet?.packet_index_sha256 || '')
  if (!expectedIndexSha) return fail('acceptance.packet.packet_index_sha256 missing')
  if (indexSha !== expectedIndexSha) {
    return fail('packet index hash mismatch disk=' + indexSha.slice(0, 16) + ' expected=' + expectedIndexSha.slice(0, 16))
  }
  const listed = new Map()
  for (const ln of readFileSync(indexPath, 'utf8').split('\n')) {
    if (!ln) continue
    const sp = ln.indexOf('  ')
    if (sp !== 64) return fail('index line malformed: ' + ln.slice(0, 60))
    const h = ln.slice(0, 64)
    const rel = ln.slice(66)
    if (!/^[0-9a-f]{64}$/.test(h)) return fail('index hash malformed: ' + rel)
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

  // ── 3) bundle manifest 哈希 == acceptance 绑定 ───────────────────────
  const manifestPath = join(packetDir, 'bundle.manifest.json')
  if (!existsSync(manifestPath)) return fail('bundle manifest missing')
  const manifestSha = sha256File(manifestPath)
  const expectedManifest = String(acc.packet?.bundle_manifest_sha256 || '')
  if (!expectedManifest) return fail('acceptance.packet.bundle_manifest_sha256 missing')
  if (manifestSha !== expectedManifest) {
    return fail('bundle manifest hash mismatch disk=' + manifestSha.slice(0, 16) + ' expected=' + expectedManifest.slice(0, 16))
  }

  // ── 4) 全部绑定逐项核验 ──────────────────────────────────────────────
  const b = acc.bindings || {}
  const inPacket = [
    ['pattern_library_sha256', 'meta/pattern-library.json'],
    ['unicode_domain_table_sha256', 'meta/unicode-domain-table.json'],
    ['common_defs_sha256', 'meta/common.defs.json'],
  ]
  for (const [key, rel] of inPacket) {
    if (!b[key]) return fail('acceptance binding missing: ' + key)
    const got = sha256File(join(packetDir, rel))
    if (got !== b[key]) return fail('binding drift ' + key + ' disk=' + got.slice(0, 16) + ' expected=' + String(b[key]).slice(0, 16))
  }
  const corpora = [['c14n', 'corpus/c14n_cases.json'], ['schema', 'schema-corpus/schema_cases.json']]
  for (const [key, rel] of corpora) {
    if (!b.corpora?.[key]) return fail('acceptance binding missing: corpora.' + key)
    const got = sha256File(join(packetDir, rel))
    if (got !== b.corpora[key]) return fail('binding drift corpora.' + key)
  }
  // locks：acceptance 未声明时跳过（其字节仍被 index 全量核验覆盖）；声明则必须逐项相符
  if (b.locks && typeof b.locks === 'object') {
    const locks = [['npm_package_lock_sha256', 'locks/node/package-lock.json'], ['python_requirements_lock_sha256', 'locks/python/requirements.lock']]
    for (const [key, rel] of locks) {
      if (!b.locks[key]) continue
      const got = sha256File(join(packetDir, rel))
      if (got !== b.locks[key]) return fail('binding drift locks.' + key)
    }
  }
  // provenance（packet 外随包携带；对 acceptance 绑定逐项核验）
  if (!b.profile_sha256) return fail('acceptance binding missing: profile_sha256')
  const profPath = join(DESIGN_DIR, 'provenance', 'casefile-c14n-1.profile.md')
  if (!existsSync(profPath)) return fail('provenance profile missing')
  if (sha256File(profPath) !== b.profile_sha256) return fail('binding drift profile')
  if (!b.spec_chain || typeof b.spec_chain !== 'object') return fail('acceptance binding missing: spec_chain')
  for (const [v, want] of Object.entries(b.spec_chain)) {
    const p = join(DESIGN_DIR, 'provenance', 'genie-synbio-design-spec-' + v + '-2026-10-13.md')
    if (!existsSync(p)) return fail('provenance spec missing: ' + v)
    if (sha256File(p) !== want) return fail('binding drift spec_chain.' + v)
  }

  return { ok: true, manifest_sha256: manifestSha, index_sha256: indexSha, checked_files: listed.size }
}
