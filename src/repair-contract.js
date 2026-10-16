/**
 * dsh-bio-genie — Repair Proposal v0：闭集契约与规范化（src/repair-contract.js）
 *
 * 职责（见 docs/repair-proposal-v0.md）：
 *  - `repair_incident@1` / proposal-request / receipt / `lesson_proof@1` / lesson
 *    的**闭集** schema（未知字段拒绝、长度上限、枚举、时间戳格式）；
 *  - 状态机合法迁移（canTransition）；
 *  - canonical serialization（键排序）+ SHA-256（recordHash，供 store sidecar / 台账用）；
 *  - 变更面策略校验（精确 allowlist + deny-list 兜底，validateProposalFiles）。
 *
 * 本模块**只处理结构化数据，不执行任何命令、不触碰文件系统**。
 * 机器可读镜像：design/repair/repair-contract-v0.json（测试交叉核对防漂移）。
 *
 * @module dsh-bio-genie/repair-contract
 */
import { createHash, randomUUID } from 'node:crypto'

export const CONTRACT_VERSION = 'v0'
export const SCHEMA_INCIDENT = 'g-repair-incident/v1'
export const SCHEMA_PROPOSAL_REQUEST = 'g-repair-proposal-request/v1'
export const SCHEMA_RECEIPT = 'g-repair-receipt/v1'
export const SCHEMA_LESSON_PROOF = 'g-repair-lesson-proof/v1'
export const SCHEMA_LESSON = 'g-repair-lesson/v1'
export const SCHEMA_POLICY = 'g-repair-policy/v1'

/** 全局字段上限（policy.limits 与之一致；测试交叉核对）。 */
export const LIMITS = Object.freeze({
  max_field_len: 512,
  max_incidents: 500,
  max_receipts: 500,
  max_lessons: 100,
  max_captures_per_hour: 20,
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64_RE = /^[0-9a-f]{64}$/

/** 生成 UUID（所有 record 的 id 形态：小写 UUID v4）。 */
export function newUuid() {
  return randomUUID()
}

/** 状态机全量状态（C4 §5.2）。 */
export const STATES = [
  'OBSERVED', 'TRIAGED', 'REPRODUCIBLE', 'NOT_REPRODUCIBLE', 'OUT_OF_SCOPE',
  'PROPOSAL_CREATED', 'INDEPENDENTLY_VERIFIED', 'MAINTAINER_APPROVED',
  'MERGED', 'RELEASED', 'POST_RELEASE_VERIFIED',
  'REJECTED', 'SUPERSEDED', 'STALE',
]

/**
 * 合法迁移表。语义（C4）：主链 OBSERVED→TRIAGED→REPRODUCIBLE→PROPOSAL_CREATED→
 * INDEPENDENTLY_VERIFIED→MAINTAINER_APPROVED→MERGED→RELEASED→POST_RELEASE_VERIFIED；
 * 任一非终态可转 REJECTED / SUPERSEDED / STALE；终态除 POST_RELEASE_VERIFIED→STALE
 * 外无出边。v0 只允许这些边，不自动 rebase。
 */
export const TRANSITIONS = Object.freeze({
  OBSERVED: ['TRIAGED', 'NOT_REPRODUCIBLE', 'OUT_OF_SCOPE', 'REJECTED', 'SUPERSEDED', 'STALE'],
  TRIAGED: ['REPRODUCIBLE', 'NOT_REPRODUCIBLE', 'OUT_OF_SCOPE', 'REJECTED', 'SUPERSEDED', 'STALE'],
  REPRODUCIBLE: ['PROPOSAL_CREATED', 'REJECTED', 'SUPERSEDED', 'STALE'],
  PROPOSAL_CREATED: ['INDEPENDENTLY_VERIFIED', 'REJECTED', 'SUPERSEDED', 'STALE'],
  INDEPENDENTLY_VERIFIED: ['MAINTAINER_APPROVED', 'REJECTED', 'SUPERSEDED', 'STALE'],
  MAINTAINER_APPROVED: ['MERGED', 'REJECTED', 'SUPERSEDED', 'STALE'],
  MERGED: ['RELEASED', 'STALE'],
  RELEASED: ['POST_RELEASE_VERIFIED', 'STALE'],
  POST_RELEASE_VERIFIED: ['STALE'],
  NOT_REPRODUCIBLE: ['STALE'],
  OUT_OF_SCOPE: ['STALE'],
  REJECTED: [],
  SUPERSEDED: [],
  STALE: [],
})

// ── 校验器（声明式闭集） ─────────────────────────────────────────────────────

const V = {
  str: (max = LIMITS.max_field_len, extra = {}) => ({ kind: 'string', max, ...extra }),
  enum: (values) => ({ kind: 'enum', values }),
  int: (min, max) => ({ kind: 'int', min, max }),
  bool: () => ({ kind: 'bool' }),
  obj: (fields) => ({ kind: 'object', fields }),
  arr: (item, max = 64) => ({ kind: 'array', item, max }),
  nullable: (inner) => ({ kind: 'nullable', inner }),
  hex64: () => ({ kind: 'string', max: 64, pattern: HEX64_RE }),
  uuid: () => ({ kind: 'string', max: 64, pattern: UUID_RE }),
  iso: () => ({ kind: 'string', max: 40, isoTimestamp: true }),
}

function fail(errors, path, code, detail) {
  errors.push(detail === undefined ? { path, code } : { path, code, detail })
}

function validateValue(value, spec, path, errors) {
  switch (spec.kind) {
    case 'nullable':
      if (value === null) return
      return validateValue(value, spec.inner, path, errors)
    case 'string':
      if (typeof value !== 'string') return fail(errors, path, 'TYPE_EXPECTED_STRING')
      if (spec.max && value.length > spec.max) return fail(errors, path, 'TOO_LONG', `len=${value.length} max=${spec.max}`)
      if (spec.pattern && !spec.pattern.test(value)) return fail(errors, path, 'PATTERN_MISMATCH')
      if (spec.isoTimestamp && Number.isNaN(Date.parse(value))) return fail(errors, path, 'INVALID_TIMESTAMP')
      return
    case 'enum':
      if (!spec.values.includes(value)) return fail(errors, path, 'NOT_IN_ENUM', JSON.stringify(spec.values))
      return
    case 'int':
      if (!Number.isInteger(value)) return fail(errors, path, 'TYPE_EXPECTED_INT')
      if (value < spec.min || value > spec.max) return fail(errors, path, 'OUT_OF_RANGE', `${spec.min}..${spec.max}`)
      return
    case 'bool':
      if (typeof value !== 'boolean') return fail(errors, path, 'TYPE_EXPECTED_BOOL')
      return
    case 'array': {
      if (!Array.isArray(value)) return fail(errors, path, 'TYPE_EXPECTED_ARRAY')
      if (value.length > spec.max) fail(errors, path, 'TOO_MANY_ITEMS', `len=${value.length} max=${spec.max}`)
      value.forEach((item, i) => validateValue(item, spec.item, `${path}[${i}]`, errors))
      return
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return fail(errors, path, 'TYPE_EXPECTED_OBJECT')
      }
      const allowed = new Set(Object.keys(spec.fields))
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail(errors, path === '' ? key : `${path}.${key}`, 'UNKNOWN_FIELD')
      }
      for (const [key, fieldSpec] of Object.entries(spec.fields)) {
        if (!(key in value)) {
          fail(errors, path === '' ? key : `${path}.${key}`, 'MISSING_FIELD')
          continue
        }
        validateValue(value[key], fieldSpec, path === '' ? key : `${path}.${key}`, errors)
      }
      return
    }
    default:
      fail(errors, path, 'INTERNAL_SPEC_ERROR', spec.kind)
  }
}

function validate(spec, value) {
  const errors = []
  validateValue(value, spec, '', errors)
  return { ok: errors.length === 0, errors }
}

// ── 五个闭集 schema ──────────────────────────────────────────────────────────

const FINGERPRINT_SPEC = V.obj({
  package: V.str(80),
  version: V.str(32),
  node: V.str(32),
  python: V.nullable(V.str(32)),
  sources_sha256: V.hex64(),
})

export const SCHEMA_SPECS = Object.freeze({
  incident: V.obj({
    schema: V.enum([SCHEMA_INCIDENT]),
    incident_id: V.uuid(),
    state: V.enum(STATES),
    attribution: V.enum(['UNVERIFIED']),
    source_kind: V.enum(['bio_python']),
    plugin_id: V.enum(['dsh-bio-genie']),
    package_fingerprint: FINGERPRINT_SPEC,
    tool_id: V.enum(['bio_python']),
    op_id: V.nullable(V.str(64, { pattern: /^[a-z0-9_]+$/ })),
    symptom_class: V.enum(['PYTHON_TRACEBACK']),
    dedupe_key: V.str(96, { pattern: /^dk_[0-9a-f]{32}$/ }),
    created_at: V.iso(),
    privacy: V.enum(['SANITIZED']),
  }),
  proposalRequest: V.obj({
    schema: V.enum([SCHEMA_PROPOSAL_REQUEST]),
    request_id: V.uuid(),
    incident_id: V.uuid(),
    base: V.obj({
      commit: V.nullable(V.str(64)),
      tree_sha256: V.hex64(),
      package_version: V.str(32),
    }),
    repair_contract_sha: V.hex64(),
    mre_id: V.str(64),
    mre_sha256: V.hex64(),
    oracle_id: V.str(64),
    oracle_sha256: V.hex64(),
    allowed_files: V.arr(V.str(256), 64),
    allowed_categories: V.arr(V.enum(['logic-fix', 'test-add']), 8),
    verifier_id: V.str(64),
    verifier_sha256: V.hex64(),
    frozen_test_set_sha: V.hex64(),
    budget: V.obj({ attempts: V.int(1, 3) }),
    expiry: V.iso(),
    requested_by: V.enum(['maintainer']),
    created_at: V.iso(),
  }),
  receipt: V.obj({
    schema: V.enum([SCHEMA_RECEIPT]),
    receipt_id: V.uuid(),
    proposal_id: V.uuid(),
    verifier: V.obj({ id: V.str(64), version: V.str(32), sha256: V.hex64() }),
    base_red: V.bool(),
    patch_green: V.bool(),
    frozen_suite: V.enum(['PASS', 'FAIL']),
    policy_check: V.enum(['PASS', 'FAIL']),
    evidence: V.obj({
      patch_sha256: V.hex64(),
      mre_sha256: V.hex64(),
      oracle_sha256: V.hex64(),
    }),
    result: V.enum(['READY_FOR_MAINTAINER_REVIEW', 'VERIFY_FAILED']),
    created_at: V.iso(),
  }),
  lessonProof: V.obj({
    schema: V.enum([SCHEMA_LESSON_PROOF]),
    proof_id: V.uuid(),
    lesson_id: V.uuid(),
    red_case_id: V.str(64),
    green_case_id: V.str(64),
    base_fingerprint: V.hex64(),
    verifier: V.obj({ id: V.str(64), version: V.str(32) }),
    result_sha256: V.hex64(),
    revoked: V.bool(),
    created_at: V.iso(),
  }),
  lesson: V.obj({
    lesson_id: V.uuid(),
    error_signature: V.str(200),
    fix_hint: V.str(200),
    env: V.obj({
      plugin: V.str(32),
      python: V.nullable(V.str(32)),
    }),
    status: V.enum(['VERIFIED']),
    created_at: V.iso(),
  }),
})

export function validateIncident(obj) { return validate(SCHEMA_SPECS.incident, obj) }
export function validateProposalRequest(obj) { return validate(SCHEMA_SPECS.proposalRequest, obj) }
export function validateReceipt(obj) { return validate(SCHEMA_SPECS.receipt, obj) }
export function validateLessonProof(obj) { return validate(SCHEMA_SPECS.lessonProof, obj) }
export function validateLesson(obj) { return validate(SCHEMA_SPECS.lesson, obj) }

// ── canonical serialization / hash ──────────────────────────────────────────

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key])
    return out
  }
  return value
}

/** canonical JSON：递归按键排序、无额外空白（跨进程/跨平台字节一致）。 */
export function canonicalize(value) {
  return JSON.stringify(sortValue(value))
}

/** SHA-256 hex（输入 string 或 Buffer）。 */
export function sha256Hex(input) {
  return createHash('sha256').update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input).digest('hex')
}

/** record canonical hash（sidecar / 台账用）。 */
export function recordHash(record) {
  return sha256Hex(canonicalize(record))
}

// ── 状态机 ──────────────────────────────────────────────────────────────────

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to)
}

// ── 变更面策略校验（精确 allowlist + deny-list 兜底） ─────────────────────────

/** 内置保守默认策略（与 design/repair/repair-policy-v0.json 一致；测试交叉核对）。 */
export const DEFAULT_POLICY = Object.freeze({
  schema: SCHEMA_POLICY,
  plugin_id: 'dsh-bio-genie',
  mode: 'proposal-only',
  capture: Object.freeze({
    source_kinds: Object.freeze(['bio_python']),
    symptom_classes: Object.freeze(['PYTHON_TRACEBACK']),
    max_captures_per_hour: LIMITS.max_captures_per_hour,
  }),
  proposal: Object.freeze({
    enabled: false,
    allowed_files: Object.freeze([]),
    exact_deny: Object.freeze([
      'package.json', 'pnpm-lock.yaml', 'package-lock.json', '.npmrc',
      'cordis.patch.yml', 'src/index.js', '.gitmodules',
      'scripts/install-preset.js',
      'design/repair/repair-contract-v0.json', 'design/repair/repair-policy-v0.json',
      'scripts/repair-lab-verify.mjs',
    ]),
    prefix_deny: Object.freeze(['scripts/', '.github/', 'preset/', 'skills/', 'prompts/', 'test/', 'node_modules/', '.git/']),
    suffix_deny: Object.freeze(['.exe', '.dll', '.pyc', '.node', '.so', '.dylib', '.zip', '.tgz', '.tar', '.gz', '.whl']),
  }),
  limits: LIMITS,
})

const CHANGE_KINDS = ['add', 'modify', 'delete', 'rename']

function rejectPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 256) return 'BAD_PATH'
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'ABSOLUTE_PATH'
  if (path.includes('\\')) return 'BACKSLASH_PATH'
  if (path.includes(':')) return 'COLON_ADS_OR_DRIVE'
  if (path.includes('//')) return 'DOUBLE_SLASH'
  const segments = path.split('/')
  for (const seg of segments) {
    if (seg === '' ) return 'EMPTY_SEGMENT'
    if (seg === '.' || seg === '..') return 'DOT_SEGMENT'
    if (seg.endsWith('.') || seg.endsWith(' ')) return 'TRAILING_DOT_OR_SPACE'
    if (seg === '.git' || seg === 'node_modules') return 'VCS_OR_MODULES_SEGMENT'
  }
  return null
}

/**
 * 校验一组候选变更是否符合策略（v0：不用于生成补丁，是 lab runner / 未来
 * proposal 的策略门；拒绝性用例必须杀死全部禁类）。
 * @param {Array<{path: string, kind: 'add'|'modify'|'delete'|'rename', from?: string}>} changes
 * @param {object} [policy] 默认 DEFAULT_POLICY
 * @returns {{ok: boolean, verdict: 'ACCEPT'|'REJECT', rejects: Array<{path: string, reason: string}>, checked: number}}
 */
export function validateProposalFiles(changes, policy = DEFAULT_POLICY) {
  const rejects = []
  const list = Array.isArray(changes) ? changes : []
  if (list.length === 0) return { ok: false, verdict: 'REJECT', rejects: [{ path: '(none)', reason: 'EMPTY_CHANGES' }], checked: 0 }
  if (list.length > 64) return { ok: false, verdict: 'REJECT', rejects: [{ path: '(many)', reason: 'TOO_MANY_CHANGES' }], checked: list.length }

  const exactDeny = new Set((policy.proposal?.exact_deny ?? []).map((p) => p.toLowerCase()))
  const prefixDeny = (policy.proposal?.prefix_deny ?? []).map((p) => p.toLowerCase())
  const suffixDeny = (policy.proposal?.suffix_deny ?? []).map((p) => p.toLowerCase())
  const allow = new Set(policy.proposal?.allowed_files ?? [])

  // case 冲突检测（Windows 大小写不敏感文件系统）：path 与 rename 的 from 均计入；
  // 同一组内仅大小写不同的路径 → 双双拒绝（防大小写绕过与仅大小写 rename）
  const lowerCount = new Map()
  for (const ch of list) {
    const lp = String(ch?.path ?? '').toLowerCase()
    lowerCount.set(lp, (lowerCount.get(lp) ?? 0) + 1)
    if (ch?.kind === 'rename') {
      const lf = String(ch?.from ?? '').toLowerCase()
      lowerCount.set(lf, (lowerCount.get(lf) ?? 0) + 1)
    }
  }

  for (const change of list) {
    const path = String(change?.path ?? '')
    const kind = change?.kind
    if (!CHANGE_KINDS.includes(kind)) { rejects.push({ path, reason: 'BAD_KIND' }); continue }
    const bad = rejectPath(path)
    if (bad) { rejects.push({ path, reason: bad }); continue }
    const lower = path.toLowerCase()
    let fromLower = null
    if (kind === 'rename') {
      const from = String(change?.from ?? '')
      const fromBad = rejectPath(from)
      if (fromBad) { rejects.push({ path, reason: `BAD_FROM:${fromBad}` }); continue }
      if (from.toLowerCase() === lower && from !== path) { rejects.push({ path, reason: 'CASE_ONLY_RENAME' }); continue }
      fromLower = from.toLowerCase()
    }
    if ((lowerCount.get(lower) ?? 0) > 1 || (fromLower !== null && (lowerCount.get(fromLower) ?? 0) > 1)) {
      rejects.push({ path, reason: 'CASE_COLLISION' }); continue
    }
    if (kind === 'rename') {
      const from = String(change?.from ?? '')
      if (exactDeny.has(fromLower) || prefixDeny.some((p) => fromLower.startsWith(p)) || suffixDeny.some((s) => fromLower.endsWith(s))) {
        rejects.push({ path, reason: 'FROM_DENIED' }); continue
      }
      if (!allow.has(from)) { rejects.push({ path, reason: 'FROM_NOT_ON_ALLOWLIST' }); continue }
    }
    if (exactDeny.has(lower)) { rejects.push({ path, reason: 'EXACT_DENY' }); continue }
    if (prefixDeny.some((p) => lower.startsWith(p))) { rejects.push({ path, reason: 'PREFIX_DENY' }); continue }
    if (suffixDeny.some((s) => lower.endsWith(s))) { rejects.push({ path, reason: 'SUFFIX_DENY' }); continue }
    if (!allow.has(path)) { rejects.push({ path, reason: 'NOT_ON_ALLOWLIST' }); continue }
  }

  const ok = rejects.length === 0
  return { ok, verdict: ok ? 'ACCEPT' : 'REJECT', rejects, checked: list.length }
}

/** schema 描述（测试与机读 JSON 交叉核对用：字段集/状态/迁移/上限不得漂移）。 */
export function describeContract() {
  const fieldsOf = (spec) => Object.keys(spec.fields).sort()
  return {
    version: CONTRACT_VERSION,
    states: [...STATES],
    transitions: Object.fromEntries(Object.entries(TRANSITIONS).map(([k, v]) => [k, [...v]])),
    schemas: {
      incident: { name: SCHEMA_INCIDENT, fields: fieldsOf(SCHEMA_SPECS.incident) },
      proposalRequest: { name: SCHEMA_PROPOSAL_REQUEST, fields: fieldsOf(SCHEMA_SPECS.proposalRequest) },
      receipt: { name: SCHEMA_RECEIPT, fields: fieldsOf(SCHEMA_SPECS.receipt) },
      lessonProof: { name: SCHEMA_LESSON_PROOF, fields: fieldsOf(SCHEMA_SPECS.lessonProof) },
      lesson: { name: SCHEMA_LESSON, fields: fieldsOf(SCHEMA_SPECS.lesson) },
    },
    limits: { ...LIMITS },
  }
}
