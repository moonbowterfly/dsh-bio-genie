/**
 * dsh-bio-genie — Repair Proposal v0：私有 repair store（src/repair-store.js）
 *
 * 布局（bioRoot()/repair/，绝不进入科研 workdir / result / design 目录）：
 *   repair/
 *     incidents/<uuid>.json + <uuid>.json.sha256   —— 脱敏 incident（closed schema）
 *     receipts/<uuid>.json  + <uuid>.json.sha256   —— 验证回执（lab 产出）
 *     lessons/<uuid>.json   + <uuid>.json.sha256   —— 已验证经验（lesson + lesson_proof）
 *     .lock                                        —— 互斥锁（wx + 过期回收）
 *
 * 安全性质（对应 C4 测试矩阵）：
 *  - 安全路径：id 仅接受 UUID 白名单 + 目录 containment + lstat 拒 symlink/非普通文件；
 *  - 原子写：tmp → fsync → rename（崩溃窗口不产生半写文件；残留 tmp 会被扫出）；
 *  - 完整性：每个 record 配 sidecar SHA-256（对**字节**计算，改一字节即报 INTEGRITY_FAILED）；
 *  - 锁 + CAS：变更在互斥锁内完成；updateRecord 支持 expect 守卫（CAS_MISMATCH）；
 *  - 上限：cap 到顶拒绝（STORE_CAP），不静默丢弃；
 *  - 只读扫描：scanStore 离线完整性报告（坏哈希/孤儿 sidecar/残留 tmp/坏文件名）。
 *
 * 不做的：不做 public ledger、不导出、不清删已提交记录（GC 只属于未提交 temp）。
 *
 * @module dsh-bio-genie/repair-store
 */
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, writeSync,
  unlinkSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { bioRoot } from './runtime.js'
import { canTransition, sha256Hex } from './repair-contract.js'

export const KINDS = ['incidents', 'receipts', 'lessons']
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LOCK_STALE_MS = 30_000

/** repair store 根（可传 base 覆盖，便于测试；默认 bioRoot()/repair）。 */
export function repairRoot(base) {
  return join(base ?? bioRoot(), 'repair')
}

export function storeError(code, message) {
  const err = new Error(`${code}: ${message ?? ''}`)
  err.code = code
  return err
}

function assertKind(kind) {
  if (!KINDS.includes(kind)) throw storeError('BAD_KIND', String(kind))
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw storeError('BAD_ID', String(id).slice(0, 80))
}

function kindDir(kind, base) {
  return join(repairRoot(base), kind)
}

/** 建 store 目录（幂等）。 */
export function ensureStore(base) {
  for (const kind of KINDS) mkdirSync(kindDir(kind, base), { recursive: true })
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

/**
 * 互斥锁（同步）。wx 建锁文件；过期（>30s mtime）自动回收；超时抛 STORE_BUSY。
 * 语义接近 design-casefile 的排他锁，但面向本 store 的短事务。
 */
export function withLock(fn, { base, timeoutMs = 4000 } = {}) {
  ensureStore(base)
  const lockFile = join(repairRoot(base), '.lock')
  const started = Date.now()
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx')
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), uuid: randomUUID() }))
      } finally {
        closeSync(fd)
      }
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let stale = false
      try {
        const st = lstatSync(lockFile)
        stale = Date.now() - st.mtimeMs > LOCK_STALE_MS
      } catch { /* 竞争中被释放，直接重试 */ }
      if (stale) {
        try { unlinkSync(lockFile) } catch { /* 已被别的进程回收 */ }
        continue
      }
      if (Date.now() - started > timeoutMs) throw storeError('STORE_BUSY', 'lock held')
      sleepSync(50)
    }
  }
  try {
    return fn()
  } finally {
    try { unlinkSync(lockFile) } catch { /* 已释放 */ }
  }
}

/** 原子写：tmp → fsync(file) → rename（目录 fsync 尽力而为，Windows 不支持则跳过）。 */
function atomicWrite(dir, file, text) {
  const tmp = join(dir, `.${randomUUID()}.tmp`)
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
  try {
    const dfd = openSync(dir, 'r')
    try { fsyncSync(dfd) } finally { closeSync(dfd) }
  } catch { /* Windows 目录 fsync 不可用 */ }
}

function writeRecordUnlocked(dir, id, record) {
  const text = JSON.stringify(record, null, 2) + '\n'
  atomicWrite(dir, join(dir, `${id}.json`), text)
  const hash = sha256Hex(text)
  atomicWrite(dir, join(dir, `${id}.json.sha256`), hash + '\n')
  return hash
}

function readRecordUnlocked(dir, id) {
  const file = join(dir, `${id}.json`)
  const resolved = resolve(file)
  if (!resolved.startsWith(resolve(dir) + sep)) throw storeError('PATH_ESCAPE', id)
  let st
  try {
    st = lstatSync(file)
  } catch {
    throw storeError('NOT_FOUND', id)
  }
  if (st.isSymbolicLink() || !st.isFile()) throw storeError('NOT_REGULAR_FILE', id)
  const raw = readFileSync(file)
  let expected
  try {
    expected = readFileSync(join(dir, `${id}.json.sha256`), 'utf8').trim()
  } catch {
    throw storeError('SIDECAR_MISSING', id)
  }
  const actual = sha256Hex(raw)
  if (actual !== expected) throw storeError('INTEGRITY_FAILED', id)
  let record
  try {
    record = JSON.parse(raw.toString('utf8'))
  } catch {
    throw storeError('BAD_JSON', id)
  }
  return { record, sha256: actual }
}

/** 写一条 record（幂等覆盖同 id；cap 到顶且非覆盖时拒绝）。 */
export function writeRecord(kind, id, record, { base, cap = 0, lockTimeoutMs } = {}) {
  assertKind(kind)
  assertId(id)
  return withLock(() => {
    const dir = kindDir(kind, base)
    const exists = existsSync(join(dir, `${id}.json`))
    if (!exists && cap > 0 && countRecords(kind, base) >= cap) {
      throw storeError('STORE_CAP', `${kind} cap=${cap}`)
    }
    const sha256 = writeRecordUnlocked(dir, id, record)
    return { id, sha256 }
  }, { base, timeoutMs: lockTimeoutMs })
}

/** 读一条 record（含 sidecar 完整性校验；任一异常抛出并带 code）。 */
export function readRecord(kind, id, { base } = {}) {
  assertKind(kind)
  assertId(id)
  return readRecordUnlocked(kindDir(kind, base), id)
}

/** 读-改-写（互斥锁内；expect 守卫失败 → CAS_MISMATCH，不落任何字节）。 */
export function updateRecord(kind, id, updater, { base, expect, lockTimeoutMs } = {}) {
  assertKind(kind)
  assertId(id)
  return withLock(() => {
    const dir = kindDir(kind, base)
    const { record } = readRecordUnlocked(dir, id)
    if (typeof expect === 'function' && expect(record) !== true) {
      throw storeError('CAS_MISMATCH', id)
    }
    const next = updater(record)
    if (next === undefined || next === null) throw storeError('UPDATER_INVALID', id)
    writeRecordUnlocked(dir, id, next)
    return { record: next }
  }, { base, timeoutMs: lockTimeoutMs })
}

/** incident 状态迁移（CAS：可传 expectState；非法迁移 → INVALID_TRANSITION）。 */
export function transitionIncident(id, to, { base, expectState } = {}) {
  return updateRecord('incidents', id, (cur) => {
    if (expectState !== undefined && cur.state !== expectState) {
      throw storeError('CAS_MISMATCH', `state=${cur.state} expected=${expectState}`)
    }
    if (!canTransition(cur.state, to)) throw storeError('INVALID_TRANSITION', `${cur.state}→${to}`)
    return { ...cur, state: to }
  }, { base })
}

/** 列某类全部合法 id（非法文件名被忽略，交由 scanStore 报问题）。 */
export function listIds(kind, { base } = {}) {
  assertKind(kind)
  const dir = kindDir(kind, base)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((id) => ID_RE.test(id))
}

/** 计数（只数 record 文件，不含 sidecar/tmp）。 */
export function countRecords(kind, base) {
  return listIds(kind, { base }).length
}

/**
 * 离线完整性扫描（bio_repair_ledger_verify / 维护者用）：
 * 逐条校验 sidecar 哈希与可读性，报告：坏哈希 / 孤儿 sidecar / 残留 tmp / 意外文件 / 坏文件名。
 */
export function scanStore({ base } = {}) {
  const issues = []
  const counts = { incidents: 0, receipts: 0, lessons: 0 }
  let checked = 0
  for (const kind of KINDS) {
    const dir = kindDir(kind, base)
    if (!existsSync(dir)) continue
    let files = []
    try {
      files = readdirSync(dir)
    } catch {
      issues.push({ kind, code: 'DIR_UNREADABLE' })
      continue
    }
    const recordFiles = new Set()
    for (const f of files) {
      if (f.endsWith('.json.sha256')) continue
      if (f.startsWith('.') || f.endsWith('.tmp')) {
        issues.push({ kind, file: f, code: 'STRAY_TEMP' })
        continue
      }
      if (!f.endsWith('.json')) {
        issues.push({ kind, file: f, code: 'UNEXPECTED_FILE' })
        continue
      }
      recordFiles.add(f)
      const id = f.slice(0, -'.json'.length)
      if (!ID_RE.test(id)) {
        issues.push({ kind, file: f, code: 'BAD_ID_FILENAME' })
        continue
      }
      checked += 1
      try {
        readRecordUnlocked(dir, id)
        counts[kind] += 1
      } catch (err) {
        issues.push({ kind, id, code: err.code ?? 'READ_FAILED', detail: String(err.message ?? '').slice(0, 160) })
      }
    }
    for (const f of files) {
      if (!f.endsWith('.json.sha256')) continue
      const recordName = f.slice(0, -'.sha256'.length)
      if (!recordFiles.has(recordName)) issues.push({ kind, file: f, code: 'ORPHAN_SIDECAR' })
    }
  }
  return { ok: issues.length === 0, counts, issues, checked }
}
