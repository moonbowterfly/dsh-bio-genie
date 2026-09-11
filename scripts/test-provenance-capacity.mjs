/**
 * 复现：单个超大工具输出是否会挤掉其他工具的数字（导致后续数字声明被误判无溯源）。
 *
 * 现场（2026-09-11 E2E）：seq 56 的 bio_python 输出 46,716 字符（含全部反应/计量/bounds），
 * seq 73 输出含 "n_reactions_total": 521；agent 在 seq 82 引用 521 时被防火墙打回。
 */
import { beginTurn, findUnverifiedNumbers, ledgerSize, recordResult } from '../src/provenance.js'

const agent = {}
beginTurn(agent)

// ① 模拟一个小工具输出（正常场景下应被记住）
recordResult(agent, 'gem_validate', {
  content: [{ type: 'text', text: JSON.stringify({ formula_coverage: 0.6835, genes: 1344 }) }],
})
console.log('① 记录 gem_validate 后台账容量:', ledgerSize(agent))

// ② 模拟 seq 56 的超大输出（46K 字符：几百个反应 × 每个含 id/系数/bounds）
const bigReactions = []
for (let i = 0; i < 600; i++) {
  bigReactions.push({
    rxn: `Rnxatu${1000 + i}`,
    bounds: [-1000, 1000],
    stoich: { M00007_c: -1, M00242_c: -1, M01435_c: -1, M00079_c: 1, M00001_c: 1, M03174_c: 1, M00060_c: 1, M00093_c: 1 },
  })
}
const bigOut = JSON.stringify({ producer_details: bigReactions })
console.log('② 大输出字符数:', bigOut.length)
recordResult(agent, 'bio_python', { content: [{ type: 'text', text: bigOut }] })
console.log('   大输出后台账容量:', ledgerSize(agent))

// ③ 模拟 seq 73 的输出（含 521）
recordResult(agent, 'bio_python', {
  content: [{ type: 'text', text: JSON.stringify({ M00001_water_proof: { n_reactions_total: 521, n_as_reactant: 411 } }) }],
})
console.log('③ 记录 521 后台账容量:', ledgerSize(agent))

// ④ agent 引用这些数字，看是否被判无溯源
console.log()
const cases = [
  ['521（来自 seq 73 的工具输出）', 'M00001_c 参与反应总数：521'],
  ['0.6835（来自 gem_validate）', '公式覆盖率 = 0.6835'],
  ['1344（来自 gem_validate）', '基因数：1344'],
]
for (const [label, claim] of cases) {
  const v = findUnverifiedNumbers(agent, claim)
  console.log(`${v.length === 0 ? '✅ 有溯源' : '❌ 被误判无溯源'}  ${label}  → ${JSON.stringify(v)}`)
}
