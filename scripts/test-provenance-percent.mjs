/**
 * provenance 百分比换算容忍 —— 硬断言回归（不依赖 dsh 实例）。
 *
 * 现场：gem_validate 输出小数 0.6835，agent 以 68.35% 引用 → 曾被判无溯源。
 * 2026-09-12 外部评审补充：`=` / `:` 语境下的百分数仍被误拦——CLAIM_RE 末尾的 `%?`
 * 会吞掉一个字符，而旧代码用 `m[0].length - raw.length` 反推数值起点，偏移一位读不到 %，
 * 于是不做 ×100 换算。本文件把两种语境都钉死。
 */
import assert from 'node:assert/strict'
import { beginTurn, findUnverifiedNumbers, recordResult } from '../src/provenance.js'

const agent = {}
beginTurn(agent)
recordResult(agent, 'gem_validate', {
  content: [{ type: 'text', text: '{"metabolite_formula_coverage": 0.6835, "gene_count": 1344}' }],
})
recordResult(agent, 'bio_seq_analyze', {
  content: [{ type: 'text', text: '{"gc_percent": 61.53, "length": 720}' }],
})

/** [标题, 回复文本, 期望违规列表] */
const cases = [
  ['引用百分比 68.35%（自然语言）', '序列公式覆盖率 68.35% 偏低', []],
  ['引用百分比 68.35%（= 写法）', 'coverage = 68.35%', []],
  ['引用百分比 68.35%（: 写法）', 'coverage: 68.35%', []],
  ['裸百分比 68.35%', '68.35%', []],
  ['引用小数 0.6835（直接命中）', 'coverage = 0.6835', []],
  ['引用原值 61.53', 'GC 含量为 61.53', []],
  ['引用百分比 61.53%（台账存 61.53）', 'GC 含量为 61.53%', []],
  ['编造数字 12.34%', '覆盖率 12.34%', ['12.34']],
  ['编造百分数（= 写法）', 'coverage = 12.34%', ['12.34']],
  ['编造数字 99.9', 'score = 99.9', ['99.9']],
]

for (const [title, text, expected] of cases) {
  const got = findUnverifiedNumbers(agent, text)
  assert.deepEqual(got, expected, `${title}：「${text}」得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`)
  console.log(`  PASS ${title}`)
}

console.log(`\nALL PASS（${cases.length} 例）`)
