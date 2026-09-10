/**
 * provenance 百分比换算容忍 —— 单元验证（不依赖 dsh 实例）。
 * 复现 E2E 现场：gem_validate 输出小数 0.6835，agent 以 68.35% 引用。
 */
import { beginTurn, findUnverifiedNumbers, recordResult } from '../src/provenance.js'

const agent = {}
beginTurn(agent)
recordResult(agent, 'gem_validate', {
  content: [{ type: 'text', text: '{"metabolite_formula_coverage": 0.6835, "gene_count": 1344}' }],
})
recordResult(agent, 'bio_seq_analyze', {
  content: [{ type: 'text', text: '{"gc_percent": 61.53, "length": 720}' }],
})

const cases = [
  ['引用百分比 68.35%（台账存 0.6835）', '序列公式覆盖率 68.35% 偏低', []],
  ['引用小数 0.6835（直接命中）', 'coverage = 0.6835', []],
  ['引用原值 61.53', 'GC 含量为 61.53', []],
  ['引用百分比 61.53%（台账存 61.53）', 'GC 含量为 61.53%', []],
  ['编造数字 12.34%', '覆盖率 12.34%', ['12.34']],
  ['编造数字 99.9', 'score = 99.9', ['99.9']],
]

let pass = 0
for (const [title, text, expected] of cases) {
  const got = findUnverifiedNumbers(agent, text)
  const ok = JSON.stringify(got) === JSON.stringify(expected)
  if (ok) pass += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}\n      got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`)
}
console.log(`\n${pass}/${cases.length} passed`)
process.exit(pass === cases.length ? 0 : 1)
