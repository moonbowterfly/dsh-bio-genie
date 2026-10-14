/**
 * dsh-bio-genie — production validateDesignArtifact（design 工件语义校验；v4 §A0.3）
 *
 * 管线：verified packet load（enable gate + packet loader）→ draft-07 schema
 * （Ajv 冻结配置 + x-canonical / x-decimal-string 两 keyword）→ pattern matcher
 * （domain 先行 + Unicode 标量计数 + full-match wrapper）/ DECIMAL_STRING scanner
 * → c14n 层（lone surrogate / 冻结域 / NFC 键碰撞 / 数值域）。
 *
 * 稳定码（按门区分，便于定向变异断言）：
 *   SCHEMA_VIOLATION / PATTERN_DOMAIN_VIOLATION / PATTERN_MAX_LEN / PATTERN_MISMATCH /
 *   DECIMAL_STRING_NONCANONICAL / PATTERN_NOT_IN_LIBRARY / DECIMAL_PAIRING_INVALID /
 *   LONE_SURROGATE / UNICODE_OUT_OF_FROZEN_DOMAIN / NFC_KEY_COLLISION / NUMBER_OUT_OF_RANGE /
 *   UNKNOWN_ARTIFACT_TYPE / PACKET_UNVERIFIED / VALIDATOR_UNAVAILABLE。
 *
 * 语义与 packet 语料运行器（synbio-schema-corpus@1）一致——由 99 例等价性套件
 * （test/design-validation.mjs）对 packet 冻结结果逐项核验。
 * CLI：`node design-validate.js --batch cases.json --out results.json`
 *      `node design-validate.js --type <stem> --value <file.json>`
 * @module dsh-bio-genie/design-validate
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyDesignPacket, PACKET_DIR } from './design-gate.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAX_SAFE = 9007199254740991

const AJV_OPTS = {
  strict: true,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  validateFormats: false,
  validateSchema: true,
  addUsedSchema: false,
  $data: false,
  unicodeRegExp: true,
}

/** verified packet load：enable gate + packet 自带 loader → 构造校验上下文。 */
function loadPacketContext(packetDir) {
  const gate = verifyDesignPacket({ packetDir })
  if (!gate.ok) {
    return { ok: false, errors: [{ code: 'PACKET_UNVERIFIED', path: '$', detail: gate.detail }] }
  }
  let docs
  try {
    const req = createRequire(import.meta.url)
    const loader = req(join(packetDir, 'build', 'bundle_loader.mjs'))
    const res = loader.loadBundle(packetDir)
    if (res.problems.length) {
      return { ok: false, errors: [{ code: 'PACKET_UNVERIFIED', path: '$', detail: 'loader: ' + res.problems[0] }] }
    }
    docs = res.docs
  } catch (e) {
    return { ok: false, errors: [{ code: 'PACKET_UNVERIFIED', path: '$', detail: 'loader: ' + String(e.message).slice(0, 120) }] }
  }
  let Ajv
  try {
    const req2 = createRequire(join(HERE, '..', 'package.json'))
    const m = req2('ajv')
    Ajv = m.default || m
  } catch (e) {
    return { ok: false, errors: [{ code: 'VALIDATOR_UNAVAILABLE', path: '$', detail: 'ajv: ' + String(e.message).slice(0, 120) }] }
  }
  const ajv = new Ajv(AJV_OPTS)
  ajv.addKeyword({ keyword: 'x-canonical', schemaType: 'string' })
  ajv.addKeyword({ keyword: 'x-decimal-string', schemaType: 'boolean' })
  ajv.addSchema(docs['meta/common.defs.json'], 'bundle://meta/common.defs.json')
  const SCHEMAS = {}
  for (const k of Object.keys(docs)) {
    if (k.startsWith('schemas/')) SCHEMAS[k.slice('schemas/'.length, -5)] = docs[k]
  }
  for (const [stem, doc] of Object.entries(SCHEMAS)) {
    ajv.addSchema(doc, 'bundle://schemas/' + stem + '.json')
  }
  const validators = {}
  for (const stem of Object.keys(SCHEMAS)) validators[stem] = ajv.compile(SCHEMAS[stem])
  const library = docs['meta/pattern-library.json'].patterns
  const byLiteral = new Map()
  for (const [name, entry] of Object.entries(library)) byLiteral.set(entry.pattern, { name, entry })
  const ranges = docs['meta/unicode-domain-table.json'].ranges
  return { ok: true, docs, SCHEMAS, validators, byLiteral, ranges }
}

// ── 语义层（与 packet 语料运行器逐字一致；I1/K3 冻结语义）──────────────
function decimalScan(s) {
  if (typeof s !== 'string') return false
  const n = s.length
  if (n === 0) return false
  let i = 0
  let neg = false
  if (s[0] === '-') {
    neg = true
    i = 1
    if (i >= n) return false
  }
  const c = s.charCodeAt(i)
  if (c === 48) {
    i += 1
    if (i < n) {
      const d = s.charCodeAt(i)
      if (d >= 48 && d <= 57) return false
    }
  } else if (c >= 49 && c <= 57) {
    i += 1
    while (i < n) {
      const d = s.charCodeAt(i)
      if (d >= 48 && d <= 57) i += 1
      else break
    }
  } else {
    return false
  }
  if (i === n) {
    if (neg && s.slice(1, i) === '0') return false
    return true
  }
  if (s[i] === '.') {
    i += 1
    if (i >= n) return false
    let j = i
    while (j < n) {
      const d = s.charCodeAt(j)
      if (d >= 48 && d <= 57) j += 1
      else break
    }
    if (j === i) return false
    const last = s.charCodeAt(j - 1)
    if (!(last >= 49 && last <= 57)) return false
    i = j
  }
  return i === n
}

function isAscii(s) {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 127) return false
  }
  return true
}

const wrapperCache = new Map()
function fullmatchWrapper(lit, s) {
  let re = wrapperCache.get(lit)
  if (!re) {
    re = new RegExp('^(?:' + lit + ')$', 'u')
    wrapperCache.set(lit, re)
  }
  return re.test(s)
}

function matchCode(name, entry, s) {
  if (!isAscii(s)) return 'PATTERN_DOMAIN_VIOLATION'
  const scalarCount = [...s].length
  if (scalarCount > entry.max_len) return 'PATTERN_MAX_LEN'
  if (name === 'canonicalDecimal') {
    if (!decimalScan(s)) return 'DECIMAL_STRING_NONCANONICAL'
    return null
  }
  if (!fullmatchWrapper(entry.pattern, s)) return 'PATTERN_MISMATCH'
  return null
}

function makeResolveRef(ctx) {
  return function resolveRef(node) {
    if (!node || typeof node !== 'object') return node
    const r = node['$ref']
    if (typeof r === 'string') {
      const pre = 'bundle://meta/common.defs.json#/definitions/'
      if (r.startsWith(pre)) {
        const name = r.slice(pre.length)
        return (ctx.docs['meta/common.defs.json'].definitions && ctx.docs['meta/common.defs.json'].definitions[name]) || node
      }
      const pre2 = 'bundle://schemas/'
      if (r.startsWith(pre2)) {
        const t = r.slice(pre2.length).split('#')[0]
        const stem = t.endsWith('.json') ? t.slice(0, -5) : t
        return ctx.SCHEMAS[stem] || node
      }
    }
    return node
  }
}

function semErrors(ctx, stem, doc) {
  const resolveRef = makeResolveRef(ctx)
  const errs = []
  function walk(s, v, path) {
    s = resolveRef(s)
    if (!s || typeof s !== 'object') return
    if (typeof v === 'string') {
      if (s['x-decimal-string'] === true) {
        const hit = ctx.byLiteral.get(s.pattern)
        if (!hit) errs.push({ code: 'DECIMAL_PAIRING_INVALID', path })
        else {
          const code = matchCode(hit.name, hit.entry, v)
          if (code) errs.push({ code, path })
        }
      } else if (typeof s.pattern === 'string') {
        const hit = ctx.byLiteral.get(s.pattern)
        if (!hit) errs.push({ code: 'PATTERN_NOT_IN_LIBRARY', path })
        else {
          const code = matchCode(hit.name, hit.entry, v)
          if (code) errs.push({ code, path })
        }
      }
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const props = s.properties || {}
      for (const k of Object.keys(v)) {
        if (Object.prototype.hasOwnProperty.call(props, k)) walk(props[k], v[k], path + '/' + k)
      }
      const ap = s.additionalProperties
      if (ap && typeof ap === 'object') {
        for (const k of Object.keys(v)) {
          if (!Object.prototype.hasOwnProperty.call(props, k)) walk(ap, v[k], path + '/' + k)
        }
      }
    } else if (Array.isArray(v)) {
      const it = s.items
      if (it && typeof it === 'object') {
        for (let i = 0; i < v.length; i += 1) walk(it, v[i], path + '/' + i)
      }
    }
  }
  walk(ctx.SCHEMAS[stem], doc, '')
  return errs
}

// ── c14n 层（lone surrogate / 冻结域 / NFC 键碰撞 / 数值域）──────────────
function c14nLayer(ranges, value) {
  const errs = []
  function inDomain(cp) {
    let lo = 0
    let hi = ranges.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const seg = ranges[mid]
      if (cp < seg[0]) hi = mid - 1
      else if (cp > seg[1]) lo = mid + 1
      else return true
    }
    return false
  }
  function checkStr(s, path) {
    for (const ch of s) {
      if (ch.length === 1) {
        const u = ch.charCodeAt(0)
        if (u >= 0xd800 && u <= 0xdfff) {
          errs.push({ code: 'LONE_SURROGATE', path })
          return
        }
      }
      const cp = ch.codePointAt(0)
      if (!inDomain(cp)) {
        errs.push({ code: 'UNICODE_OUT_OF_FROZEN_DOMAIN', path, detail: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0') })
      }
    }
  }
  function walk(v, path) {
    if (typeof v === 'string') { checkStr(v, path); return }
    if (typeof v === 'number') {
      if (Number.isInteger(v) && Math.abs(v) > MAX_SAFE) errs.push({ code: 'NUMBER_OUT_OF_RANGE', path })
      return
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) walk(v[i], path + '/' + i)
      return
    }
    if (v && typeof v === 'object') {
      const seen = new Set()
      for (const [k, val] of Object.entries(v)) {
        checkStr(k, path)
        const nk = k.normalize('NFC')
        if (seen.has(nk)) errs.push({ code: 'NFC_KEY_COLLISION', path: path + '/' + nk })
        seen.add(nk)
        walk(val, path + '/' + k)
      }
    }
  }
  walk(value, '')
  return errs
}

/**
 * 校验一个 design 工件。返回：
 * { ok, artifact_type, engine, engine_errors, sem:[code@path], c14n:[code@path], errors:[{code,path,detail?}] }
 * ok = engine && sem 空 && c14n 空（完整管线）；core 判定（engine&&sem）供语料等价比对。
 */
export function validateDesignArtifact(artifactType, value, { packetDir = PACKET_DIR } = {}) {
  const ctx = loadPacketContext(packetDir)
  if (!ctx.ok) {
    return { ok: false, artifact_type: artifactType, engine: false, engine_errors: 0, sem: [], c14n: [], errors: ctx.errors }
  }
  const v = ctx.validators[artifactType]
  if (!v) {
    return { ok: false, artifact_type: artifactType, engine: false, engine_errors: 0, sem: [], c14n: [], errors: [{ code: 'UNKNOWN_ARTIFACT_TYPE', path: '$', detail: String(artifactType) }] }
  }
  const engineOk = v(value)
  const engineErrors = []
  if (!engineOk && v.errors) {
    for (const e of v.errors.slice(0, 20)) {
      engineErrors.push({ code: 'SCHEMA_VIOLATION', path: e.instancePath || '$', detail: e.keyword + ' ' + JSON.stringify(e.params || {}).slice(0, 80) })
    }
  }
  const sem = semErrors(ctx, artifactType, value)
  const c14n = c14nLayer(ctx.ranges, value)
  const ok = engineOk && sem.length === 0 && c14n.length === 0
  return {
    ok,
    artifact_type: artifactType,
    engine: engineOk,
    engine_errors: engineOk ? 0 : (v.errors ? v.errors.length : -1),
    sem: sem.map((x) => x.code + '@' + x.path),
    c14n: c14n.map((x) => x.code + '@' + x.path),
    errors: [...engineErrors, ...sem, ...c14n],
  }
}

/** 从 schema+value 推导 c14n 注解表（path -> set|seq；base 优先，allOf/if-then-else 分支补缺）。
 *  stage② 用（把注解传给冻结 c14n CLI 做 canonical 复核）。失败返回 null（fail-closed）。 */
export function deriveAnnotationsForArtifact(artifactType, value, { packetDir = PACKET_DIR } = {}) {
  const ctx = loadPacketContext(packetDir)
  if (!ctx.ok) return null
  const ann = {}
  const resolveRef = makeResolveRef(ctx)
  function walk(s, v, path) {
    s = resolveRef(s)
    if (!s || typeof s !== 'object') return
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const props = s.properties || {}
      for (const k of Object.keys(v)) {
        if (Object.prototype.hasOwnProperty.call(props, k)) walk(props[k], v[k], path + '/' + k)
      }
      const ap = s.additionalProperties
      if (ap && typeof ap === 'object') {
        for (const k of Object.keys(v)) {
          if (!Object.prototype.hasOwnProperty.call(props, k)) walk(ap, v[k], path + '/' + k)
        }
      }
    } else if (Array.isArray(v)) {
      const kind = s['x-canonical']
      if (typeof kind === 'string' && !(path in ann)) ann[path] = kind
      const it = s.items
      if (it && typeof it === 'object') {
        for (let i = 0; i < v.length; i += 1) walk(it, v[i], path + '/' + i)
      }
    }
    for (const bk of ['allOf', 'anyOf', 'oneOf']) {
      for (const br of (s[bk] || [])) walk(br, v, path)
    }
    for (const bk of ['then', 'else', 'if']) {
      const br = s[bk]
      if (br && typeof br === 'object') walk(br, v, path)
    }
  }
  walk(ctx.SCHEMAS[artifactType], value, '$')
  return ann
}

// ── CLI ──────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2)
  if (args.includes('--batch')) {
    const casesPath = args[args.indexOf('--batch') + 1]
    const outPath = args[args.indexOf('--out') + 1]
    const cases = JSON.parse(readFileSync(casesPath, 'utf8'))
    const results = []
    for (const c of cases.cases) {
      const r = validateDesignArtifact(c.schema, c.doc)
      results.push({
        id: c.id,
        valid: r.ok,
        core_valid: r.engine && r.sem.length === 0,
        engine: r.engine,
        engine_errors: r.engine_errors,
        sem: r.sem,
        c14n: r.c14n,
      })
    }
    writeFileSync(outPath, JSON.stringify({ side: 'ts-prod', results }, null, 1) + '\n', 'utf8')
    console.error('ts-prod cases: ' + results.length)
    return 0
  }
  if (args.includes('--type')) {
    const t = args[args.indexOf('--type') + 1]
    const f = args[args.indexOf('--value') + 1]
    const value = JSON.parse(readFileSync(f, 'utf8'))
    const r = validateDesignArtifact(t, value)
    process.stdout.write(JSON.stringify(r, null, 1) + '\n')
    return r.ok ? 0 : 1
  }
  console.log('usage: node design-validate.js --batch cases.json --out results.json | --type <stem> --value <file.json>')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
