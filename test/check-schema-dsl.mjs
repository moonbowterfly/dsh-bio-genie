// test/check-schema-dsl.mjs — 用 dsh-tools value schema DSL 白名单审计全部工具定义。
//
// 背景：真实 dsh（@deepseek-ai/dsh-tools）对作者 schema 有严格白名单（value schema DSL）：
//   - 值节点（string/number/integer/boolean/null）只允许 type/enum/const + 注解键；minimum/maximum/
//     exclusiveMinimum 等边界关键字一律 UNSUPPORTED_SCHEMA；
//   - object 节点必须显式 additionalProperties: true|false；array 只有 type/items；oneOf 分支不允许 required；
//   - 每个值节点必须有 type（或 oneOf）；parameters 顶层是 property-map（属性表），不是值节点。
// mock loader（test/dsh-tools-loader.mjs）不校验 schema → 违规只在真实 dsh 启动时以 UNSUPPORTED_SCHEMA
// 爆出并阻断插件加载。本脚本把 DSL 规则转写为离线审计器：mock 加载 src/tools.js 收集全部工具定义，
// 逐节点收集【全部】违规（不 fail-fast），作为回归门。
//
// 用法：node test/check-schema-dsl.mjs   （exit 0 = 无违规；exit 1 = 列出全部违规）
import { register } from 'node:module'
register('./dsh-tools-loader.mjs', import.meta.url)

const { registerTools } = await import('../src/tools.js')

// —— 收集全部工具定义（mock defineTool 直接透传）——
const tools = []
const ctx = {
  tools: { register: (t) => { tools.push(t); return () => {} } },
  skills: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  on: () => () => {},
  get: () => undefined,
  logger: { warn: () => {}, info: () => {} },
  effect: (callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : (() => {}) },
  inject: () => () => {},
}
try {
  registerTools(ctx, {})
} catch (e) {
  console.error('registerTools threw:', e.stack || e.message)
  process.exit(1)
}

// —— dsh-tools value schema DSL 白名单（照 lib/index.js assertAuthorKeys 语义对齐）——
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']
const violations = []
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function checkValue(node, path, allowRequired) {
  if (!isRecord(node)) {
    violations.push(`${path}: must be a value schema object (got ${node === null ? 'null' : typeof node})`)
    return
  }
  const authorKeys = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])]
  if (Object.hasOwn(node, 'required') && node.required !== true) {
    violations.push(`${path}.required must be true when present`)
  }
  const checkKeys = (extra) => {
    const allowed = [...authorKeys, ...extra]
    for (const k of Object.keys(node)) {
      if (!allowed.includes(k)) violations.push(`${path}.${k} is not supported by the value schema DSL`)
    }
  }
  if (Object.hasOwn(node, 'oneOf')) {
    checkKeys(['oneOf', 'type'])
    if (Object.hasOwn(node, 'type')) violations.push(`${path} cannot declare both type and oneOf`)
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      violations.push(`${path}.oneOf must be an array of at least two value schemas`)
    } else {
      node.oneOf.forEach((b, i) => checkValue(b, `${path}.oneOf[${i}]`, false))
    }
    return
  }
  switch (node.type) {
    case 'json':
      checkKeys(['type'])
      break
    case 'object':
      checkKeys(['type', 'properties', 'additionalProperties'])
      if (typeof node.additionalProperties !== 'boolean') {
        violations.push(`${path}.additionalProperties must be explicitly true or false`)
      }
      if (Object.hasOwn(node, 'properties')) {
        const props = node.properties
        if (!isRecord(props)) violations.push(`${path}.properties must be an object of value schemas`)
        else for (const [k, v] of Object.entries(props)) checkValue(v, `${path}.properties.${k}`, true)
      }
      break
    case 'array':
      checkKeys(['type', 'items'])
      if (Object.hasOwn(node, 'items')) checkValue(node.items, `${path}.items`, false)
      break
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      checkKeys(['type', 'enum', 'const'])
      break
    default:
      violations.push(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf (got ${JSON.stringify(node.type)})`)
  }
}

function checkPropertyMap(spec, path) {
  if (!isRecord(spec)) {
    violations.push(`${path} must be an object of value schemas`)
    return
  }
  for (const [k, v] of Object.entries(spec)) checkValue(v, `${path}.${k}`, true)
}

// —— 审计每工具的 parameters（property-map）与 output.schema（值节点）——
for (const t of tools) {
  checkPropertyMap(t.parameters, `${t.name}.parameters`)
  if (t.output && t.output.schema) checkValue(t.output.schema, `${t.name}.output.schema`, false)
}

// —— 工具名唯一性与命名模式（防复制粘贴重名）——
const seen = new Map()
for (const t of tools) {
  if (!t || typeof t.name !== 'string' || !t.name) {
    violations.push(`tool without a valid name: ${JSON.stringify(t?.name)}`)
    continue
  }
  seen.set(t.name, (seen.get(t.name) ?? 0) + 1)
  if (!/^(bio_|design_)[a-z0-9_]+$/.test(t.name)) {
    violations.push(`tool name out of convention (bio_*/design_*): ${t.name}`)
  }
}
for (const [name, n] of seen) {
  if (n > 1) violations.push(`duplicate tool name registered ${n} times: ${name}`)
}

if (violations.length) {
  console.log(`❌ schema DSL 违规 ${violations.length} 处：`)
  for (const v of violations) console.log('  - ' + v)
  process.exit(1)
}
console.log(`✅ schema DSL 审计通过：${tools.length} 个工具，0 违规`)
