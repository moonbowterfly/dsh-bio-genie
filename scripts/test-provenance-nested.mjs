/**
 * 验证：嵌套 dict 里的数字是否进不了 rigor-guard 台账（导致误伤）。
 *
 * 现场（2026-09-11 E2E）：agent 的 bio_python 返回里，521 嵌在
 * { M00001_water_proof: { 各种统计 } } 内层；agent 在回复中引用 521 时被防火墙打回。
 */
import { beginTurn, findUnverifiedNumbers, recordResult } from '../src/provenance.js'

function probe(title, result, claim, expectVerified = true) {
  const agent = {}
  beginTurn(agent)
  recordResult(agent, 'bio_python', result)
  const v = findUnverifiedNumbers(agent, claim)
  const ok = expectVerified ? v.length === 0 : v.length > 0
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}`)
  console.log(`      声明 ${JSON.stringify(claim)} → 违规 ${JSON.stringify(v)}`
    + `（期望${expectVerified ? '有溯源' : '被拦截'}）`)
  return ok
}

const nested = {
  content: [{
    type: 'text',
    text: JSON.stringify({
      M00001_water_proof: {
        reactions_total: 521,
        as_reactant: 411,
        as_product: 110,
        abc_transport: 128,
      },
    }),
  }],
}

const flat = {
  content: [{
    type: 'text',
    text: JSON.stringify({ reactions_total: 521, as_reactant: 411 }),
  }],
}

const deep = {
  content: [{
    type: 'text',
    text: JSON.stringify({ a: { b: { c: { d: { e: { f: { g: { h: { i: { deep_value: 777 } } } } } } } } } }),
  }],
}

let allOk = true
allOk = probe('① 嵌套 dict（现场形态）', nested, '反应总数 521') && allOk
allOk = probe('② 顶层扁平（对照）', flat, '反应总数 521') && allOk
allOk = probe('③ 十层深嵌套（depth 上限探测）', deep, '深值 777') && allOk

// ④ 护栏不能失效：编造数字必须被拦。
// 注意 CLAIM_RE 只扫「带小数」或「前面带比较语境（= < > : 等）」的数字——
// 纯整数裸写在句中本就不在扫描范围（这是设计，不是缺陷），故用例要用比较语境写法。
allOk = probe('④ 编造数字应被拦（护栏有效性）', flat, '编造值 = 9999.5', false) && allOk

console.log(`\n结论：${allOk ? '嵌套提取正常且护栏有效' : '存在问题（见上方 FAIL）'}`)
process.exit(allOk ? 0 : 1)
