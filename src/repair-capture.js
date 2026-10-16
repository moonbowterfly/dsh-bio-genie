/**
 * dsh-bio-genie — Repair Proposal v0：observation token 与脱敏 capture（src/repair-capture.js）
 *
 * 数据流（C3.2）：
 *   bio_python traceback →（本模块）短 TTL、一次性、纯内存 observation token
 *     → 显式 bio_repair_capture(token) → 脱敏 OBSERVED incident（attribution=UNVERIFIED）
 *
 * 硬约束：
 *  - token 不含 stderr/代码/路径——只是随机 UUID + 粗粒度分类 + 指纹绑定；
 *  - **首次 traceback 不创建任何 durable incident**；只有显式 capture 才落盘；
 *  - 持久化前丢弃全部 raw 值：incident 走 repair-contract 闭集校验（未知/raw 字段即拒）；
 *  - token 过期 / 已消费 / 未知 / 指纹不符 → fail closed（不落盘、不部分写入）；
 *  - 同一 failure_class × 指纹 去重（活跃 incident 复用，不翻倍）；限流（每小时上限）。
 *
 * 本模块是唯一可能接触 live traceback 的 repair 模块，但 traceback 内容本身
 * 永不进入本模块的任何持久化路径。
 *
 * @module dsh-bio-genie/repair-capture
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PLUGIN_ROOT, resolveEnvDir } from './runtime.js'
import { LIMITS, SCHEMA_INCIDENT, newUuid, sha256Hex, validateIncident } from './repair-contract.js'
import { listIds, readRecord, writeRecord } from './repair-store.js'

/** token 默认 TTL（毫秒）。 */
export const TOKEN_TTL_MS = 10 * 60 * 1000
const TOKEN_MAX = 100

/** 进程内 token 表（短命；重启即失效——符合「纯内存一次性」语义）。 */
const TOKENS = new Map()
/** 捕获窗口计数（成功 capture 次数，每进程；上限 LIMITS.max_captures_per_hour）。 */
const captureWindow = { count: 0 }

/**
 * 计算 package 指纹（绑定安装态：包名/版本 + src 源码树哈希 + node/python）。
 * 源码树哈希 = src/ 下全部 .js 文件（相对路径排序）逐文件 sha256 后再合成——
 * 安装态被篡改时指纹变化，token 校验 fail closed。
 */
export function computeFingerprint({ root } = {}) {
  const rootDir = root ?? PLUGIN_ROOT
  let pkgName = '@dsh-bio/dsh-bio-genie'
  let version = 'unknown'
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
    if (pkg && typeof pkg.name === 'string') pkgName = pkg.name
    if (pkg && typeof pkg.version === 'string') version = pkg.version
  } catch { /* 保持缺省 */ }
  let sources = '0'.repeat(64)
  try {
    sources = hashSourceTree(join(rootDir, 'src'))
  } catch { /* 缺省零值 */ }
  return {
    package: pkgName,
    version,
    node: process.versions.node,
    python: readPythonMajor(),
    sources_sha256: sources,
  }
}

function hashSourceTree(srcDir) {
  const files = []
  const walk = (dir, depth) => {
    if (depth > 5) return
    let entries = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (st.isFile() && name.endsWith('.js')) files.push(full)
    }
  }
  walk(srcDir, 0)
  files.sort()
  const lines = files.map((f) => {
    const rel = relative(srcDir, f).split(sep).join('/')
    return `${rel}:${sha256Hex(readFileSync(f))}`
  })
  return sha256Hex(lines.join('\n'))
}

/** Python major.minor（读 venv pyvenv.cfg；读不到返回 null，环境兼容判定用）。 */
export function readPythonMajor() {
  try {
    const cfg = readFileSync(join(resolveEnvDir(), 'pyvenv.cfg'), 'utf8')
    const m = cfg.match(/^version\s*=\s*(\d+)\.(\d+)/m)
    return m ? `${m[1]}.${m[2]}` : null
  } catch {
    return null
  }
}

/**
 * 发放短 TTL、一次性 observation token。纯加性：失败返回 null（绝不影响调用方）。
 * @param {{toolId?: string, sourceKind?: string, symptomClass?: string, root?: string, ttlMs?: number, now?: number}} [opts]
 * @returns {string|null} token（UUID）
 */
export function issueObservationToken(opts = {}) {
  const {
    toolId = 'bio_python',
    sourceKind = 'bio_python',
    symptomClass = 'PYTHON_TRACEBACK',
    root,
    ttlMs = TOKEN_TTL_MS,
    now = Date.now(),
  } = opts
  try {
    const fingerprint = computeFingerprint({ root })
    const token = randomUUID()
    TOKENS.set(token, {
      token,
      createdAt: now,
      expiresAt: now + ttlMs,
      sourceKind,
      toolId,
      symptomClass,
      fingerprint,
      usedAt: undefined,
    })
    // 清理：已消费/过期项；容量上限丢最旧
    for (const [key, entry] of TOKENS) {
      if (key === token) continue
      const gone = now > entry.expiresAt || (entry.usedAt !== undefined && now - entry.usedAt > TOKEN_TTL_MS)
      if (gone) TOKENS.delete(key)
    }
    while (TOKENS.size > TOKEN_MAX) TOKENS.delete(TOKENS.keys().next().value)
    return token
  } catch {
    return null
  }
}

/**
 * 消费（一次性）：校验存在 / 未消费 / 未过期 / 指纹一致。任一失败 → fail closed。
 * @returns {{ok: true, entry: object} | {ok: false, code: string}}
 */
export function consumeObservationToken(token, { now = Date.now(), root } = {}) {
  const entry = TOKENS.get(token)
  if (!entry) return { ok: false, code: 'TOKEN_UNKNOWN' }
  if (entry.usedAt !== undefined) return { ok: false, code: 'TOKEN_ALREADY_USED' }
  if (now > entry.expiresAt) {
    TOKENS.delete(token)
    return { ok: false, code: 'TOKEN_EXPIRED' }
  }
  const fingerprint = computeFingerprint({ root })
  if (fingerprint.sources_sha256 !== entry.fingerprint.sources_sha256 || fingerprint.version !== entry.fingerprint.version) {
    TOKENS.delete(token)
    return { ok: false, code: 'FINGERPRINT_MISMATCH' }
  }
  entry.usedAt = now
  entry.fingerprint = fingerprint
  return { ok: true, entry }
}

const ACTIVE_STATES = new Set([
  'OBSERVED', 'TRIAGED', 'REPRODUCIBLE', 'PROPOSAL_CREATED', 'INDEPENDENTLY_VERIFIED', 'MAINTAINER_APPROVED',
])

function dedupeKeyOf(entry) {
  const fp = entry.fingerprint
  return 'dk_' + sha256Hex(`${entry.symptomClass}|dsh-bio-genie|${fp.version}|${fp.sources_sha256}`).slice(0, 32)
}

function findActiveIncident(dedupeKey, base) {
  for (const id of listIds('incidents', { base })) {
    try {
      const { record } = readRecord('incidents', id, { base })
      if (record.dedupe_key === dedupeKey && ACTIVE_STATES.has(record.state)) return record
    } catch { /* 坏记录跳过，交由 ledger_verify 报告 */ }
  }
  return null
}

/**
 * 显式登记一条脱敏 OBSERVED incident。输入只接受 token（不接受任何 raw 内容）。
 * @returns {{ok: true, incident_id: string, deduped: boolean, state: string} | {ok: false, code: string, message?: string}}
 */
export function captureIncident({ token, base, root, now = Date.now() } = {}) {
  if (captureWindow.count >= LIMITS.max_captures_per_hour) {
    return { ok: false, code: 'RATE_LIMITED', message: `每小时最多 ${LIMITS.max_captures_per_hour} 条 capture（本进程）` }
  }
  const consumed = consumeObservationToken(token, { now, root })
  if (!consumed.ok) return consumed
  try {
    const entry = consumed.entry
    const record = {
      schema: SCHEMA_INCIDENT,
      incident_id: newUuid(),
      state: 'OBSERVED',
      attribution: 'UNVERIFIED',
      source_kind: entry.sourceKind,
      plugin_id: 'dsh-bio-genie',
      package_fingerprint: entry.fingerprint,
      tool_id: entry.toolId,
      op_id: null,
      symptom_class: entry.symptomClass,
      dedupe_key: dedupeKeyOf(entry),
      created_at: new Date(now).toISOString(),
      privacy: 'SANITIZED',
    }
    const v = validateIncident(record)
    if (!v.ok) {
      return { ok: false, code: 'SCHEMA_INVALID', message: v.errors.slice(0, 3).map((e) => `${e.path}:${e.code}`).join(', ') }
    }
    const existing = findActiveIncident(record.dedupe_key, base)
    if (existing) {
      captureWindow.count += 1
      return { ok: true, deduped: true, incident_id: existing.incident_id, state: existing.state }
    }
    writeRecord('incidents', record.incident_id, record, { base, cap: LIMITS.max_incidents })
    captureWindow.count += 1
    return { ok: true, deduped: false, incident_id: record.incident_id, state: 'OBSERVED' }
  } catch (err) {
    return { ok: false, code: err.code ?? 'CAPTURE_FAILED', message: String(err.message ?? err).slice(0, 200) }
  }
}
