#!/usr/bin/env node
/**
 * dsh-bio-genie — Repair Proposal v0.2 · 生成器输入包构建器（lab 件）
 *
 * 定位（设计依据：优化设计 v2.1 §A1，红队修订全并入）：
 *   为「生成器」（产 patch 的一方，云端模型会话）准备受控输入包，并做发送前控制：
 *   1) 输入面只允许：脱敏 incident + 维护者点火请求 + 合成 MRE + 代码快照；
 *   2) 快照 / MRE 先预扫描（canary 词表 + 凭据形状 + 用户路径模式 + 二进制 + 大小上限）；
 *   3) 载荷 = canonical JSON（键排序、无空白），对将发送的字节做终扫；
 *   4) 通过后写 payload.json + payload-record.json（含自我哈希与全部 per-file 哈希）；
 *   5) 任何一步不符 → 拒发（refusal.json 只报文件/偏移/序号，绝不回声命中值）。
 *
 * 本脚本自身不发起任何网络调用（不导入任何网络模块）；不进 npm 包、不注册给 agent。
 * 路径示例一律正斜杠写法（与运行平台无关）。
 *
 * 用法：
 *   node scripts/repair-gen-package.mjs prepare --incident f --snapshot d --mre d
 *     --policy f --checker f --runner f --contract f --allowed a,b --out r.json
 *   node scripts/repair-gen-package.mjs build --incident f --request f --snapshot d
 *     --mre d --canary f --policy f --checker f --runner f --contract f --out dir
 *
 * 退出码：0=READY_TO_SEND；2=REFUSED（扫描违规）；3=INPUT/BINDING/POLICY 拒绝；64=usage
 */
import { readFileSync, readdirSync, lstatSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  sha256Hex, newUuid, validateIncident, validateProposalRequest, validateProposalFiles, canonicalize,
} from '../src/repair-contract.js'

const LF = String.fromCharCode(10)
const BS = String.fromCharCode(92)

const PER_FILE_MAX = 262144
const TOTAL_MAX = 4 * 1024 * 1024
const CANARY_MIN_LEN = 8

// 凭据形状表（正则源一律无转义反斜杠构造；名称进报告，值绝不回声）
const CRED_PATTERNS = [
  ['openai-like', 'sk-[A-Za-z0-9_-]{20,}'],
  ['github-token', 'gh[pousr]_[A-Za-z0-9]{36,}'],
  ['github-pat', 'github_pat_[A-Za-z0-9_]{22,}'],
  ['aws-akid', 'AKIA[0-9A-Z]{16}'],
  ['slack-token', 'xox[baprs]-[A-Za-z0-9-]{10,}'],
  ['google-api-key', 'AIza[0-9A-Za-z_-]{35}'],
  ['npm-token', 'npm_[A-Za-z0-9]{36}'],
  ['private-key-block', '-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}'],
]
const CRED_REGEX = CRED_PATTERNS.map(([name, src]) => [name, new RegExp(src, 'i')])
const USER_PATH_REGEX = new RegExp('[A-Za-z]:(' + BS + BS + '|/)Users', 'i')

function usageDie(message) {
  console.error(JSON.stringify({ code: 'USAGE', message, argv_note: 'node scripts/repair-gen-package.mjs prepare|build --flags...' }, null, 2))
  process.exit(64)
}

function dieJson(code, obj) {
  console.error(JSON.stringify(obj, null, 2))
  process.exit(code)
}

function parseFlags() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const flags = new Map()
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i]
    if (!t.startsWith('--')) continue
    const eq = t.indexOf('=')
    if (eq >= 0) { flags.set(t.slice(2, eq), t.slice(eq + 1)); continue }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { flags.set(t.slice(2), next); i++ }
    else flags.set(t.slice(2), null)
  }
  return { cmd, flags }
}

function flagGet(flags, name, { required = false, dflt = null } = {}) {
  if (!flags.has(name)) {
    if (required) usageDie('missing --' + name)
    return dflt
  }
  const v = flags.get(name)
  if (v === null || v === '') {
    if (required) usageDie('missing value for --' + name)
    return dflt
  }
  return v
}

function loadJson(path, stage) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    dieJson(3, { code: 'INPUT_INVALID', stage, path, message: String(e && e.message).slice(0, 250) })
  }
}

function loadCanaries(path) {
  const text = readFileSync(path, 'utf8')
  const out = []
  for (const raw of text.split(LF)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.length < CANARY_MIN_LEN) dieJson(3, { code: 'INPUT_INVALID', stage: 'canary', message: 'term shorter than ' + CANARY_MIN_LEN })
    out.push({ raw: line, low: line.toLowerCase() })
  }
  if (out.length === 0) dieJson(3, { code: 'INPUT_INVALID', stage: 'canary', message: 'no terms' })
  return out
}

/** 文本扫描：canary 词（子串）+ 凭据形状 + 用户路径。hits 只含定位信息，不含命中值。 */
function scanText(text, where, path, canaries, hits) {
  const low = text.toLowerCase()
  for (let i = 0; i < canaries.length; i++) {
    const idx = low.indexOf(canaries[i].low)
    if (idx >= 0) hits.push({ where, path, kind: 'canary', ref: i, offset: idx })
  }
  for (const [name, rx] of CRED_REGEX) {
    const m = rx.exec(text)
    if (m) hits.push({ where, path, kind: 'credential:' + name, offset: m.index })
  }
  const up = USER_PATH_REGEX.exec(text)
  if (up) hits.push({ where, path, kind: 'user-path', offset: up.index })
}

/** 树扫描：返回 { hashes: Map(rel->sha256), buffers: Map(rel->Buffer), bytes }。违规进 hits。 */
function treeScan(root, label, canaries, hits) {
  const hashes = new Map()
  const buffers = new Map()
  let bytes = 0
  const walk = (dir, relBase) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = relBase ? relBase + '/' + name : name
      let st
      try { st = lstatSync(full) } catch { hits.push({ where: label, path: rel, kind: 'unreadable' }); continue }
      if (st.isSymbolicLink()) { hits.push({ where: label, path: rel, kind: 'symlink' }); continue }
      if (st.isDirectory()) { walk(full, rel); continue }
      if (!st.isFile()) { hits.push({ where: label, path: rel, kind: 'non-regular' }); continue }
      const buf = readFileSync(full)
      bytes += buf.length
      if (buf.length > PER_FILE_MAX) hits.push({ where: label, path: rel, kind: 'oversize-file' })
      if (buf.includes(0)) { hits.push({ where: label, path: rel, kind: 'binary' }); continue }
      const text = buf.toString('utf8')
      scanText(text, label, rel, canaries, hits)
      hashes.set(rel, sha256Hex(buf))
      buffers.set(rel, buf)
    }
  }
  walk(root, '')
  return { hashes, buffers, bytes }
}

function manifestOf(hashes) {
  return [...hashes.entries()].map(([k, v]) => k + ':' + v).sort().join(LF)
}

function writeJson(path, value, pretty = true) {
  writeFileSync(path, JSON.stringify(value, null, pretty ? 2 : undefined) + LF, 'utf8')
}

function writeRefusal(outDir, stage, code, extra) {
  mkdirSync(outDir, { recursive: true })
  const refusal = {
    schema: 'g-repair-gen-refusal/v1',
    created_at: new Date().toISOString(),
    stage,
    code,
    ...extra,
    note: 'hit values are intentionally not echoed (files/offsets/indexes only)',
  }
  const p = join(outDir, 'refusal.json')
  writeJson(p, refusal)
  return p
}

function selfSha() {
  return sha256Hex(readFileSync(fileURLToPath(import.meta.url)))
}

// ── prepare：生成点火请求草案（维护者审阅用；documents 全哈希绑定） ──────────
function runPrepare(flags) {
  const incidentPath = flagGet(flags, 'incident', { required: true })
  const snapshotDir = resolve(flagGet(flags, 'snapshot', { required: true }))
  const mreDir = resolve(flagGet(flags, 'mre', { required: true }))
  const policyPath = flagGet(flags, 'policy', { required: true })
  const checkerPath = flagGet(flags, 'checker', { required: true })
  const runnerPath = flagGet(flags, 'runner', { required: true })
  const contractPath = flagGet(flags, 'contract', { required: true })
  const allowed = flagGet(flags, 'allowed', { required: true })
  const categories = flagGet(flags, 'categories', { dflt: 'logic-fix,test-add' })
  const attempts = Number(flagGet(flags, 'attempts', { dflt: '1' }))
  const expiry = flagGet(flags, 'expiry', { dflt: new Date(Date.now() + 48 * 3600 * 1000).toISOString() })
  const mreId = flagGet(flags, 'mre-id', { dflt: 'synthetic-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') })
  const oracleId = flagGet(flags, 'oracle-id', { dflt: 'oracle-v0' })
  const commit = flagGet(flags, 'commit', { dflt: null })
  const packageVersion = flagGet(flags, 'package-version', { dflt: 'synthetic-0' })
  const outPath = resolve(flagGet(flags, 'out', { required: true }))

  const incident = loadJson(incidentPath, 'incident')
  const vI = validateIncident(incident)
  if (!vI.ok) dieJson(3, { code: 'INPUT_INVALID', stage: 'incident', errors: vI.errors.slice(0, 6) })

  const emptyHits = []
  const snap = treeScan(snapshotDir, 'snapshot', [], emptyHits)
  const mre = treeScan(mreDir, 'mre', [], emptyHits)
  if (emptyHits.length > 0) dieJson(3, { code: 'INPUT_INVALID', stage: 'scan-light', hits: emptyHits.slice(0, 8) })
  if (snap.hashes.size === 0 || mre.hashes.size === 0) dieJson(3, { code: 'INPUT_INVALID', stage: 'scan-light', message: 'snapshot/mre must be non-empty' })

  const allowedFiles = allowed.split(',').map((s) => s.trim()).filter(Boolean)
  for (const p of allowedFiles) if (!snap.hashes.has(p)) dieJson(3, { code: 'INPUT_INVALID', stage: 'allowed', message: 'allowed file missing from snapshot: ' + p, path: p })

  const checkerSha = sha256Hex(readFileSync(checkerPath))
  const runnerSha = sha256Hex(readFileSync(runnerPath))
  const policySha = sha256Hex(readFileSync(policyPath))
  const contractSha = sha256Hex(readFileSync(contractPath))
  const verifierSha = sha256Hex([runnerSha, checkerSha, policySha].join('|'))
  const treeSha = sha256Hex(manifestOf(snap.hashes))
  const mreSha = sha256Hex('mre:' + manifestOf(mre.hashes))
  const oracleSha = sha256Hex('checker:' + checkerSha)

  const request = {
    schema: 'g-repair-proposal-request/v1',
    request_id: newUuid(),
    incident_id: incident.incident_id,
    base: { commit, tree_sha256: treeSha, package_version: packageVersion },
    repair_contract_sha: contractSha,
    mre_id: mreId,
    mre_sha256: mreSha,
    oracle_id: oracleId,
    oracle_sha256: oracleSha,
    allowed_files: allowedFiles,
    allowed_categories: categories.split(',').map((s) => s.trim()).filter(Boolean),
    verifier_id: 'verifier-local-1',
    verifier_sha256: verifierSha,
    frozen_test_set_sha: oracleSha,
    budget: { attempts },
    expiry,
    requested_by: 'maintainer',
    created_at: new Date().toISOString(),
  }
  const vR = validateProposalRequest(request)
  if (!vR.ok) dieJson(3, { code: 'INTERNAL', stage: 'request-draft', errors: vR.errors.slice(0, 6) })

  writeJson(outPath, request)
  console.log(JSON.stringify({ ok: true, command: 'prepare', out: outPath, request_id: request.request_id, allowed_files: allowedFiles, snapshot: { files: snap.hashes.size, bytes: snap.bytes }, mre: { files: mre.hashes.size, bytes: mre.bytes } }, null, 2))
}

// ── build：校验绑定 → 预扫描 → 载荷渲染 → 字节终扫 → 记录/拒发 ───────────────
function runBuild(flags) {
  const incidentPath = flagGet(flags, 'incident', { required: true })
  const requestPath = flagGet(flags, 'request', { required: true })
  const snapshotDir = resolve(flagGet(flags, 'snapshot', { required: true }))
  const mreDir = resolve(flagGet(flags, 'mre', { required: true }))
  const canaryPath = flagGet(flags, 'canary', { required: true })
  const policyPath = flagGet(flags, 'policy', { required: true })
  const checkerPath = flagGet(flags, 'checker', { required: true })
  const runnerPath = flagGet(flags, 'runner', { required: true })
  const contractPath = flagGet(flags, 'contract', { required: true })
  const outDir = resolve(flagGet(flags, 'out', { required: true }))

  const incident = loadJson(incidentPath, 'incident')
  const vI = validateIncident(incident)
  if (!vI.ok) dieJson(3, { code: 'INPUT_INVALID', stage: 'incident', errors: vI.errors.slice(0, 6) })

  const request = loadJson(requestPath, 'request')
  const vR = validateProposalRequest(request)
  if (!vR.ok) dieJson(3, { code: 'INPUT_INVALID', stage: 'request', errors: vR.errors.slice(0, 6) })

  if (request.incident_id !== incident.incident_id) {
    dieJson(3, { code: 'BINDING_MISMATCH', stage: 'binding', field: 'incident_id', note: 'request.incident_id != incident.incident_id' })
  }

  const canaries = loadCanaries(canaryPath)
  const hits = []
  const snap = treeScan(snapshotDir, 'snapshot', canaries, hits)
  const mre = treeScan(mreDir, 'mre', canaries, hits)

  if (hits.length > 0) {
    const p = writeRefusal(outDir, 'scan', 'SCAN_HIT', {
      hit_count: hits.length,
      hits: hits.slice(0, 12),
      counts: { snapshot_files: snap.hashes.size, mre_files: mre.hashes.size },
    })
    dieJson(2, { code: 'REFUSED', stage: 'scan', message: 'pre-scan hit(s); payload not emitted', refusal_path: p, hit_count: hits.length })
  }
  if (snap.hashes.size === 0 || mre.hashes.size === 0) dieJson(3, { code: 'INPUT_INVALID', stage: 'scan', message: 'snapshot/mre must be non-empty' })
  if (snap.bytes + mre.bytes > TOTAL_MAX) {
    const p = writeRefusal(outDir, 'scan', 'OVERSIZE_TOTAL', { total_bytes: snap.bytes + mre.bytes, limit: TOTAL_MAX })
    dieJson(2, { code: 'REFUSED', stage: 'scan', message: 'total input exceeds cap', refusal_path: p })
  }

  // ── 绑定复核（request 的哈希必须与真实输入一致；任一不符 = 拒发） ──
  const treeSha = sha256Hex(manifestOf(snap.hashes))
  const mreSha = sha256Hex('mre:' + manifestOf(mre.hashes))
  const checkerSha = sha256Hex(readFileSync(checkerPath))
  const oracleSha = sha256Hex('checker:' + checkerSha)
  const contractSha = sha256Hex(readFileSync(contractPath))
  const verifierSha = sha256Hex([
    sha256Hex(readFileSync(runnerPath)), checkerSha, sha256Hex(readFileSync(policyPath)),
  ].join('|'))
  const bindings = [
    ['base.tree_sha256', request.base.tree_sha256, treeSha],
    ['mre_sha256', request.mre_sha256, mreSha],
    ['oracle_sha256', request.oracle_sha256, oracleSha],
    ['repair_contract_sha', request.repair_contract_sha, contractSha],
    ['verifier_sha256', request.verifier_sha256, verifierSha],
  ]
  for (const [field, want, got] of bindings) {
    if (want !== got) {
      dieJson(3, { code: 'BINDING_MISMATCH', stage: 'binding', field, note: 'request value != recomputed from inputs' })
    }
  }

  const allowedSet = new Set(request.allowed_files)
  for (const p of request.allowed_files) {
    if (!snap.hashes.has(p)) dieJson(3, { code: 'BINDING_MISMATCH', stage: 'binding', field: 'allowed_files', path: p, note: 'allowed file missing from snapshot' })
  }
  for (const rel of snap.hashes.keys()) {
    if (!allowedSet.has(rel)) dieJson(3, { code: 'BINDING_MISMATCH', stage: 'binding', field: 'allowed_files', path: rel, note: 'snapshot file not covered by allowed_files (v0 strict: snapshot == allowed set)' })
  }

  const policy = loadJson(policyPath, 'policy')
  const changes = [...snap.hashes.keys()].sort().map((p) => ({ path: p, kind: 'modify' }))
  const pv = validateProposalFiles(changes, policy)
  if (!pv.ok) {
    const p = writeRefusal(outDir, 'policy', 'POLICY_REJECT', { rejects: pv.rejects.slice(0, 8) })
    dieJson(3, { code: 'POLICY_REJECT', stage: 'policy', message: 'candidate surface violates policy', refusal_path: p })
  }

  // ── 载荷组装（canonical JSON：键排序、无空白；无 created_at，保证同输入同字节） ──
  const snapFiles = [...snap.hashes.keys()].sort().map((p) => ({ path: p, sha256: snap.hashes.get(p), content: snap.buffers.get(p).toString('utf8') }))
  const mreFiles = [...mre.hashes.keys()].sort().map((p) => ({ path: p, sha256: mre.hashes.get(p), content: mre.buffers.get(p).toString('utf8') }))
  const payload = {
    schema: 'g-repair-gen-payload/v1',
    request,
    incident,
    mre: { mre_id: request.mre_id, files: mreFiles },
    snapshot: { tree_sha256: treeSha, files: snapFiles },
    constraints: {
      output: 'unified-diff-only',
      no_binary: true,
      max_patch_bytes: 262144,
      allowed_files: [...request.allowed_files],
      note: 'produce a detached unified diff limited to allowed_files; no install/commit/publish actions',
    },
  }
  const payloadBytes = Buffer.from(canonicalize(payload), 'utf8')

  // ── 字节级终扫（以「将发送的字节」为准） ──
  const finalHits = []
  scanText(payloadBytes.toString('utf8'), 'payload-bytes', '(payload.json)', canaries, finalHits)
  if (finalHits.length > 0) {
    const p = writeRefusal(outDir, 'payload-bytes', 'SCAN_HIT', { hit_count: finalHits.length, hits: finalHits.slice(0, 12) })
    dieJson(2, { code: 'REFUSED', stage: 'payload-bytes', message: 'final byte scan hit(s); payload not emitted', refusal_path: p, hit_count: finalHits.length })
  }

  mkdirSync(outDir, { recursive: true })
  const payloadPath = join(outDir, 'payload.json')
  writeFileSync(payloadPath, payloadBytes)
  const payloadSha = sha256Hex(payloadBytes)
  const record = {
    schema: 'g-repair-gen-record/v1',
    created_at: new Date().toISOString(),
    command: 'build',
    builder: { tool: 'repair-gen-package.mjs', sha256: selfSha() },
    request_id: request.request_id,
    incident_id: incident.incident_id,
    inputs: {
      snapshot: { files: snap.hashes.size, bytes: snap.bytes, tree_sha256: treeSha },
      mre: { files: mre.hashes.size, bytes: mre.bytes, mre_sha256: mreSha },
      verifier_sha256: verifierSha,
      contract_sha256: contractSha,
      oracle_sha256: oracleSha,
    },
    payload: { file: 'payload.json', bytes: payloadBytes.length, sha256: payloadSha },
    scan: { stage_snapshot: 'PASS', stage_mre: 'PASS', stage_payload_bytes: 'PASS', canary_terms: canaries.length, credential_patterns: CRED_REGEX.length, user_path_pattern: true, hits: 0 },
    verdict: 'READY_TO_SEND',
  }
  const recordPath = join(outDir, 'payload-record.json')
  writeJson(recordPath, record)

  console.log(JSON.stringify({
    ok: true,
    command: 'build',
    verdict: 'READY_TO_SEND',
    payload_path: payloadPath,
    payload_sha256: payloadSha,
    payload_bytes: payloadBytes.length,
    record_path: recordPath,
    snapshot: { files: snap.hashes.size, bytes: snap.bytes },
    mre: { files: mre.hashes.size, bytes: mre.bytes },
  }, null, 2))
  process.exit(0)
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
const { cmd, flags } = parseFlags()
try {
  if (cmd === 'prepare') runPrepare(flags)
  else if (cmd === 'build') runBuild(flags)
  else usageDie('unknown or missing command (expected prepare|build)')
} catch (e) {
  dieJson(3, { code: 'INPUT_ERROR', message: String(e && e.message).slice(0, 300) })
}
