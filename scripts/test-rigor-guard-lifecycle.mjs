/**
 * rigor-guard 生命周期接线测试 —— 驱动**真实的** registerRigorGuard 事件处理链。
 *
 * 2026-09-12 行为变更（用户决策）：防火墙由「回合拦截（steer 打回）」降级为
 * 「溯源提醒（回复放行 + 日志留痕 + 下轮软提醒）」。本测试对应更新：
 *   受数字 → **发出去**（不撤回），但：
 *   ① 记入日志（noticed N number(s) without provenance）
 *   ② 收到一条软提醒 steer（每回合最多 1 次，不重试不强制）
 *
 * 为什么必须有这一层（外部代码评审 2026-09-12 的"若只加一个测试"回答）：
 *   只测 provenance.js 的导出函数会漏掉"事件顺序 / 回合状态推进"这类缺陷——
 *   实测就漏了一个：引擎只派发 agent/turn-stopping（**没有** agent/turn-start），
 *   而旧实现在判定之前就重置 sawQuestion，导致本回合 ask_user_question 的
 *   "提议数值豁免"当场失效（豁免从未真正生效）。
 *
 * 覆盖六件事：
 *   ① 已溯源数字 → 放行（不提醒）
 *   ② 无溯源数字 → 回复放行（steer=1）+ 消息契约（id/role/content）+ 文案是"提醒"非"拦截"
 *   ③ 本回合问过用户 → 提议数值完全豁免（连提醒都没有）
 *   ④ 豁免不跨回合   → 下一回合同样文本重新触发提醒
 *   ⑤ 每回合软提醒上限 1 次（同一回合连续违规只提醒一次）
 *   ⑥ 日志留痕：违规计数写入 logger.info（审计可查）
 */
import assert from 'node:assert/strict'
import { registerRigorGuard } from '../src/rigor-guard.js'
import { ledgerSize } from '../src/provenance.js'

// ── 极简 ctx：收集 handler + 日志，模拟事件派发 ────────────────────────
function makeCtx() {
  const handlers = new Map()
  const logs = []
  return {
    on(name, fn) { handlers.set(name, fn) },
    logger: {
      info(...args) { logs.push(args.join(' ')) },
      warn() {},
    },
    fire(name, ...args) {
      const h = handlers.get(name)
      assert.ok(h, `未注册的 handler: ${name}`)
      return h(...args)
    },
    has: (name) => handlers.has(name),
    logs,
  }
}

function makeAgent() {
  return { nudges: [], session: {}, steer(msg) { this.nudges.push(msg) } }
}

/** 走一遍：工具结果 → assistant 回复 → 回合收尾。收集本轮日志与提醒。 */
async function driveTurn(ctx, agent, { toolResult, reply, askQuestion = false, turn = 1 }) {
  const before = agent.nudges.length
  const logBefore = ctx.logs.length
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
  return agent.nudges.length - before
}

const ctx = makeCtx()
registerRigorGuard(ctx)
assert.ok(ctx.has('agent/turn-stopping'), 'rigor-guard 应注册 turn-stopping')
assert.ok(ledgerSize({}) === 0, '前置条件：初始台账应为空')

let failures = 0
const check = (ok, msg) => { if (ok) console.log(`  PASS ${msg}`); else { failures++; console.error(`  FAIL ${msg}`) } }

// ① 无数字回复不打扰
{
  const a = makeAgent()
  const n = await driveTurn(ctx, a, { toolResult: { gc_percent: 54.89 }, reply: '随便聊聊，没有数字', turn: 1 })
  check(n === 0, '① 无数字回复不触发提醒')
}
// ② 已溯源数字放行
{
  const a = makeAgent()
  const n = await driveTurn(ctx, a, { toolResult: { gc_percent: 54.89, length: 133 }, reply: 'GC 含量 54.89%，长度 133 bp', turn: 1 })
  check(n === 0, '② 引用工具数字 → 放行（零误报）')
}
// ③ 无溯源数字：回复**放行**，但收到软提醒（消息契约 + 文案是提醒语气）
{
  const a = makeAgent()
  const n = await driveTurn(ctx, a, { toolResult: { gc_percent: 54.89 }, reply: '覆盖率 = 12.34%', turn: 1 })
  check(n === 1, '③ 无溯源数字 → 软提醒 1 次（回复不拦截）')
  const msg = a.nudges[0]
  check(Boolean(msg && msg.id && msg.role === 'user' && Array.isArray(msg.content) && msg.source),
    '③ 提醒消息带 id/role/source/content（引擎存盘契约）')
  check(/溯源提醒/.test(msg?.content?.[0]?.text || ''), '③ 文案是「溯源提醒」语气（非拦截令）')
  check(!/请调用相应 bio_\* 工具.*后再回复/.test(msg?.content?.[0]?.text || ''),
    '③ 不再要求「先算完再回复」（旧拦截话术已移除）')
  // 日志留痕
  check(ctx.logs.some((l) => l.includes('without provenance') && l.includes('12.34')),
    '③ 违规数字已记入日志（审计留痕）')
}
// ④ 提问豁免在本回合生效（回归：旧实现在判别前重置 sawQuestion，豁免失效）
{
  const a = makeAgent()
  const n = await driveTurn(ctx, a, {
    toolResult: { gc_percent: 54.89 }, reply: '我建议把阈值设为 12.34%（请确认）', askQuestion: true, turn: 1,
  })
  check(n === 0, '④ 本回合问过用户 → 提议数值完全豁免（连提醒都没有）')
}
// ⑤ 豁免不跨回合：下一回合同样文本重新触发提醒
{
  const a = makeAgent()
  await driveTurn(ctx, a, { toolResult: { gc_percent: 54.89 }, reply: '提议 = 12.34%', askQuestion: true, turn: 1 })
  const n2 = await driveTurn(ctx, a, { toolResult: { gc_percent: 54.89 }, reply: '提议 = 12.34%', turn: 2 })
  check(n2 === 1, '⑤ 豁免不跨回合（第 2 回合重新提醒）')
}
// ⑥ 每回合软提醒上限 1 次（连续违规只提醒一次，不刷屏）
{
  const a = makeAgent()
  for (let i = 0; i < 5; i++) {
    await driveTurn(ctx, a, { toolResult: { gc_percent: 54.89 }, reply: 'x = 12.34%', turn: 1 })
  }
  check(a.nudges.length === 1, `⑥ 单回合软提醒上限 1（实际 ${a.nudges.length}）`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exitCode = failures === 0 ? 0 : 1
