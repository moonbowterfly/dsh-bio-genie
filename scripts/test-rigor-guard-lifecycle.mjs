/**
 * rigor-guard 生命周期接线测试 —— 驱动**真实的** registerRigorGuard 事件处理链。
 *
 * 为什么必须有这一层（外部代码评审 2026-09-12 的"若只加一个测试"回答）：
 *   只测 provenance.js 的导出函数会漏掉"事件顺序 / 回合状态推进"这类缺陷——
 *   实测就漏了一个：引擎只派发 agent/turn-stopping（**没有** agent/turn-start），
 *   而旧实现在判定之前就重置 sawQuestion，导致本回合 ask_user_question 的
 *   "提议数值豁免"当场失效（豁免从未真正生效）。
 *
 * 覆盖四件事：
 *   ① 已溯源数字 → 放行（不 steer）
 *   ② 编造数字   → 被 steer（且 steer 消息带字段契约：id/role/content）
 *   ③ 本回合问过用户 → 提议数值放行（豁免）
 *   ④ 豁免不跨回合   → 下一回合同样文本必须重新被拦
 */
import assert from 'node:assert/strict'
import { registerRigorGuard } from '../src/rigor-guard.js'
import { ledgerSize } from '../src/provenance.js'

// ── 极简 ctx：收集 handler，模拟事件派发 ──────────────────────────────
function makeCtx() {
  const handlers = new Map()
  return {
    on(name, fn) { handlers.set(name, fn) },
    logger: { info() {}, warn() {} },
    fire(name, ...args) {
      const h = handlers.get(name)
      assert.ok(h, `未注册的 handler: ${name}`)
      return h(...args)
    },
    has: (name) => handlers.has(name),
  }
}

function makeAgent() {
  return { steers: [], session: {}, steer(msg) { this.steers.push(msg) } }
}

/** 走一遍：工具结果 → assistant 回复 → 回合收尾。返回本回合的 steer 次数。 */
async function driveTurn(ctx, agent, { toolResult, reply, askQuestion = false, turn = 1 }) {
  const before = agent.steers.length
  await ctx.fire('tools/post-execute', { agent, name: 'bio_seq_analyze' },
    { content: [{ type: 'text', text: JSON.stringify(toolResult) }] }, async () => {})
  if (askQuestion) {
    await ctx.fire('tools/post-execute', { agent, name: 'ask_user_question' },
      { content: [{ type: 'text', text: '请问用哪个参数？' }] }, async () => {})
  }
  ctx.fire('session/event', agent.session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: reply }] } },
  })
  await ctx.fire('agent/turn-stopping', { agent, turn })
  return agent.steers.length - before
}

const ctx = makeCtx()
registerRigorGuard(ctx)
assert.ok(ctx.has('agent/turn-stopping'), 'rigor-guard 应注册 turn-stopping')
assert.ok(ledgerIsEmpty(), '前置条件：初始台账应为空')

function ledgerIsEmpty() { return ledgerSize({}) === 0 }

let failures = 0
const check = (ok, msg) => { if (ok) console.log(`  PASS ${msg}`); else { failures++; console.error(`  FAIL ${msg}`) } }

// ① 台账为空时不打扰闲聊
{
  const a = makeAgent()
  const n = await driveTurn(ctx, a, { toolResult: { gc_percent: 54.89 }, reply: '随便聊聊，没有数字', turn: 1 })
  check(n === 0, '① 无数字回复不触发 steer')
}
// ② 已溯源数字放行
{
  const a = makeAgent()
  const n = await driveTurn(ctx, a, { toolResult: { gc_percent: 54.89, length: 133 }, reply: 'GC 含量 54.89%，长度 133 bp', turn: 1 })
  check(n === 0, '② 引用工具数字 → 放行（零误报）')
}
// ③ 编造数字被拦，且 steer 负载符合引擎契约
{
  const a = makeAgent()
  const n = await driveTurn(ctx, a, { toolResult: { gc_percent: 54.89 }, reply: '覆盖率 = 12.34%', turn: 1 })
  check(n === 1, '③ 编造数字 → 被 steer 打回')
  const msg = a.steers[0]
  check(Boolean(msg && msg.id && msg.role === 'user' && Array.isArray(msg.content) && msg.source),
    '③ steer 消息带 id/role/source/content（引擎存盘契约）')
  check(/计算防火墙/.test(msg?.content?.[0]?.text || ''), '③ steer 文案点明防火墙与补救方式')
}
// ④ 提问豁免在本回合生效（回归：旧实现在判别前重置 sawQuestion，豁免失效）
{
  const a = makeAgent()
  const n = await driveTurn(ctx, a, {
    toolResult: { gc_percent: 54.89 }, reply: '我建议把阈值设为 12.34%（请确认）', askQuestion: true, turn: 1,
  })
  check(n === 0, '④ 本回合问过用户 → 提议数值豁免')
}
// ⑤ 豁免不跨回合：下一回合同样文本必须被拦
{
  const a = makeAgent()
  await driveTurn(ctx, a, { toolResult: { gc_percent: 54.89 }, reply: '提议 = 12.34%', askQuestion: true, turn: 1 })
  const n2 = await driveTurn(ctx, a, { toolResult: { gc_percent: 54.89 }, reply: '提议 = 12.34%', turn: 2 })
  check(n2 === 1, '⑤ 豁免不跨回合（第 2 回合重新强制）')
}
// ⑥ 每回合最多打回 MAX_STEERS_PER_TURN 次（防 steer 死循环）
{
  const a = makeAgent()
  for (let i = 0; i < 5; i++) {
    await driveTurn(ctx, a, { toolResult: { gc_percent: 54.89 }, reply: 'x = 12.34%', turn: 1 })
  }
  check(a.steers.length === 2, `⑥ 单回合打回上限为 2（实际 ${a.steers.length}）`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exitCode = failures === 0 ? 0 : 1
