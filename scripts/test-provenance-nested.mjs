/**
 * provenance 嵌套与深度契约 —— 硬断言回归。
 *
 * 现场（2026-09-11 E2E）：521 嵌在 { M00001_water_proof: { ... } } 内层，
 * agent 引用时被防火墙打回 → 说明"能不能收进嵌套数值"直接决定误报率。
 *
 * 2026-09-12 外部评审指出：旧用例把十层对象先 JSON.stringify 成字符串再放进
 * `content[].text`，收集器只需扫字符串、**根本没递归**，所以那条"十层深嵌套"用例
 * 并没有测到深度上限。本文件用**真结构化对象**测深度契约：
 *   · 结构化 8/16 层 → 必须收到
 *   · 超过 DEPTH_CAP   → 按文档化契约收不到（**已知边界**，不是缺陷）
 *   · 文本字段里的 JSON → 无论多少层都能收到（走字符串扫描路径，与深度无关）
 *   ⚠️ 口径：DEPTH_CAP 从**完整工具结果根**（result）起算，不是从业务 payload 起算。
 */
import assert from 'node:assert/strict'
import { beginTurn, findUnverifiedNumbers, recordResult } from '../src/provenance.js'

/** 把 value 包进 n 层对象（真嵌套，不序列化）。 */
function wrapDeep(n, value) {
  let o = { deep_value: value }
  for (let i = 0; i < n; i++) o = { inner: o }
  return o
}

function probe(title, result, claim, expectVerified) {
  const agent = {}
  beginTurn(agent)
  recordResult(agent, 'bio_python', result)
  const v = findUnverifiedNumbers(agent, claim)
  const ok = expectVerified ? v.length === 0 : v.length > 0
  assert.ok(ok, `${title}：声明 ${JSON.stringify(claim)} → 违规 ${JSON.stringify(v)}（期望${expectVerified ? '有溯源' : '被拦截'}）`)
  console.log(`  PASS ${title}`)
}

// ① 真结构化嵌套：8 层 / 16 层都要收到（≤ DEPTH_CAP=24）
probe('① 结构化 8 层', { content: [{ type: 'text', text: 'ok' }], data: wrapDeep(8, 4321.5) }, '深值 = 4321.5', true)
probe('② 结构化 16 层', { content: [{ type: 'text', text: 'ok' }], data: wrapDeep(16, 5678.5) }, '深值 = 5678.5', true)

// ③ 已知边界：超过 DEPTH_CAP 的**结构化**数值收不到（文档化契约，避免误以为是 bug）
probe('③ 结构化 30 层（超 DEPTH_CAP，按契约收不到）',
  { content: [{ type: 'text', text: 'ok' }], data: wrapDeep(30, 9999.5) }, '深值 = 9999.5', false)

// ③b 边界契约（对外表述要精确）：DEPTH_CAP 从**完整 result 根**起算，
//     而 { data: wrapDeep(n, v) } 里 data 容器自己占一层、数值再占一层，
//     所以 wrapDeep(22) 可收、wrapDeep(23)/wrapDeep(24) 已超界——这是文档化契约，
//     不是"≤24 层都能收"（外部评审 2026-09-12 指出原表述会引起误解）。
probe('③b wrapDeep(22) 可收（边界内）', { content: [{ type: 'text', text: 'ok' }], data: wrapDeep(22, 2222.5) }, '深值 = 2222.5', true)
probe('③c wrapDeep(23) 已超界（按契约不收）', { content: [{ type: 'text', text: 'ok' }], data: wrapDeep(23, 3333.5) }, '深值 = 3333.5', false)

// ④ 文本字段里的 JSON 与深度无关（走字符串扫描路径）
probe('④ 文本字段里的 20 层 JSON',
  { content: [{ type: 'text', text: JSON.stringify(wrapDeep(20, 7777.5)) }] }, '深值 = 7777.5', true)

// ⑤ 现场形态：单层嵌套 dict
probe('⑤ 现场形态（M00001_water_proof.reactions_total）',
  { content: [{ type: 'text', text: JSON.stringify({ M00001_water_proof: { reactions_total: 521, as_reactant: 411 } }) }] },
  '反应总数 = 521.0', true)

// ⑥ 护栏有效性：编造数字必须被拦
probe('⑥ 编造数字应被拦', { content: [{ type: 'text', text: '{}' }] }, '编造值 = 9999.5', false)

console.log('\nALL PASS')
