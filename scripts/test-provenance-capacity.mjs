/**
 * provenance 台账容量与淘汰策略 —— 硬断言回归测试。
 *
 * 背景（2026-09-11 E2E 现场）：seq 56 的 bio_python 输出 46,716 字符填满台账，
 * seq 73 输出里的 521 无法入账 → agent 在 seq 82 引用 521 时被防火墙打回。
 * 2026-09-12 外部评审又指出两处规则缺陷（本文件②③两条即为它们的回归用例）：
 *   ② 台账满时"空结果"会无条件砍掉一半旧数据 → 历史合法数字被误拦（假阳性）
 *   ③ 重复值不去重 → 只含重复值的输出能挤掉别的数字
 *
 * 纪律：**只打印不算通过**——必须硬断言 + 非零退出码，否则变异（把修复改回去）
 * 也照样"绿"，测试就是摆设（评审实测过这一点）。
 */
import assert from 'node:assert/strict'
import { beginTurn, findUnverifiedNumbers, isVerified, ledgerSize, recordResult } from '../src/provenance.js'

const txt = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] })
const CAP = 2000

// ── ① 主场景：小工具 → 超大输出 → 后续数字仍能入账并溯源 ──────────────
{
  const a = {}
  beginTurn(a)
  recordResult(a, 'gem_validate', txt({ formula_coverage: 0.6835, genes: 1344 }))

  const reactions = []
  for (let i = 0; i < 1000; i++) {
    reactions.push({
      rxn: `Rnxatu${1000 + i}`, bounds: [-1000, 1000],
      stoich: { M00007_c: -1, M00242_c: -1, M01435_c: -1, M00079_c: 1, M00001_c: 1, M03174_c: 1, M00060_c: 1, M00093_c: 1 },
    })
  }
  const bigOut = JSON.stringify({ producer_details: reactions })
  assert.ok(bigOut.length > 100 * 1024, `大输出需 >100KB（实测边界），实际 ${bigOut.length} 字符`)

  recordResult(a, 'bio_python', { content: [{ type: 'text', text: bigOut }] })
  recordResult(a, 'bio_python', txt({ M00001_water_proof: { n_reactions_total: 521, n_as_reactant: 411 } }))

  assert.deepEqual(findUnverifiedNumbers(a, 'M00001_c 参与反应总数：521'), [], '大输出之后的 521 仍应有溯源')
  assert.deepEqual(findUnverifiedNumbers(a, '公式覆盖率 = 0.6835'), [], '早先工具的 0.6835 仍应有溯源')
  assert.deepEqual(findUnverifiedNumbers(a, '基因数：1344'), [], '早先工具的 1344 仍应有溯源')
  assert.ok(ledgerSize(a) <= CAP, `台账不得超过上限 ${CAP}（实际 ${ledgerSize(a)}）`)
  console.log(`  ① 主场景通过（大输出 ${bigOut.length} 字符；台账 ${ledgerSize(a)}）`)
}

// ── ② 回归：满台账 + 空结果 **不得** 淘汰任何旧数据 ────────────────────
{
  const b = {}
  beginTurn(b)
  recordResult(b, 't1', txt({ nums: [...Array.from({ length: 999 }, (_, i) => i + 1), 100000] }))
  recordResult(b, 't2', txt({ nums: Array.from({ length: 1000 }, (_, i) => 2000 + i) }))
  assert.equal(ledgerSize(b), CAP, '前置条件：台账应正好满')
  assert.equal(isVerified(b, 100000), true, '前置条件：100000 应有溯源')

  recordResult(b, 'empty', { content: [] })                     // 不含任何数字的结果
  recordResult(b, 'empty2', txt({ note: 'no numbers here' }))    // 也不含数字
  assert.equal(ledgerSize(b), CAP, '空结果不得减少台账容量')
  assert.equal(isVerified(b, 100000), true, '空结果不得让历史数字失去溯源（假阳性回归）')
  console.log('  ② 空结果不淘汰 ✓')
}

// ── ③ 回归：只含重复值的输出 **不得** 挤掉别的数字 ─────────────────────
{
  const c = {}
  beginTurn(c)
  recordResult(c, 'x', txt({ key: 521 }))
  const repeats = (v) => ({ content: [{ type: 'text', text: Array.from({ length: 1500 }, () => String(v)).join(' ') }] })
  recordResult(c, 'r1', repeats(42))
  recordResult(c, 'r2', repeats(43))
  assert.equal(isVerified(c, 521), true, '重复值输出不得挤掉 521')
  assert.equal(ledgerSize(c), 3, `去重后台账只应存 3 个不同数值（实际 ${ledgerSize(c)}）`)
  console.log('  ③ 重复值去重 ✓')
}

// ── ③b 回归：满台账时**当前工具刚回显的最老值**必须存活（LRU 刷新语义）───────
{
  const e = {}
  beginTurn(e)
  recordResult(e, 'fill1', txt({ nums: Array.from({ length: 1000 }, (_, i) => 10000 + i * 10) }))
  recordResult(e, 'fill2', txt({ nums: Array.from({ length: 1000 }, (_, i) => 50000 + i * 10) }))
  assert.equal(ledgerSize(e), CAP, '前置条件：台账应满')
  assert.equal(isVerified(e, 10000), true, '前置条件：最早值 10000 应在台账内')
  // 当前工具回显最早值 + 999 个新值
  recordResult(e, 'echo', txt({ nums: [10000, ...Array.from({ length: 999 }, (_, i) => 900000 + i * 10)] }))
  assert.equal(isVerified(e, 10000), true, '当前工具刚回显的值不得被淘汰（LRU 刷新回归）')
  assert.equal(ledgerSize(e), CAP, '台账仍应满')
  console.log('  ③b 回显即刷新（LRU）✓')
}

// ── ④ 护栏有效性：编造数字必须仍被拦（门不能只会放行）────────────────────
{
  const d = {}
  beginTurn(d)
  recordResult(d, 'gem_validate', txt({ formula_coverage: 0.6835 }))
  assert.deepEqual(findUnverifiedNumbers(d, '编造值 = 9999.5'), ['9999.5'], '编造数字必须被拦')
  assert.deepEqual(findUnverifiedNumbers(d, '覆盖率 12.34%'), ['12.34'], '编造的百分数必须被拦')
  console.log('  ④ 护栏有效性 ✓')
}

console.log('\nALL PASS')
