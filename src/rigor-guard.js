/**
 * dsh-bio-genie — rigor-guard（计算防火墙的运行时强制层）
 *
 * 挂载框架 agent 生命周期事件，实现「无溯源数字物理上发不出去」：
 *
 *  - `session/event`（assistant/message）：跟踪每个 agent 最新的回复文本
 *  - `agent/turn-stopping`：回合收尾前扫描回复；发现无溯源数值声明时
 *    用 agent.steer() 注入一条插件反馈，强制 agent 调用工具验证后再输出
 *
 * 设计约束：
 *  - 只对用过 bio_* 工具的 agent 生效（台账为空直接放行，不打扰闲聊）
 *  - 本回合调过 ask_user_question 的放行（决策检查点允许提议数值）
 *  - 每回合最多打回 2 次，防止 steer 死循环
 *  - 任何内部异常只记日志，绝不阻塞 agent 循环
 *
 * @module dsh-bio-genie/rigor-guard
 */
import {
  recordResult, markQuestionAsked, sawQuestion,
  ledgerSize, beginTurn, findUnverifiedNumbers,
} from './provenance.js'

/** 每回合最多打回次数。 */
const MAX_STEERS_PER_TURN = 2

/** 从 assistant/message 事件的 message.content 提取纯文本。 */
function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/**
 * 注册 rigor-guard。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerRigorGuard(ctx) {
  /** agent → { lastReply: string, steers: number, turn: number } */
  const state = new WeakMap()
  /** session 对象 → agent 对象（assistant/message 事件不带 agent，靠 session 关联） */
  const sessionAgent = new WeakMap()

  const st = (agent) => {
    let s = state.get(agent)
    if (!s) {
      s = { lastReply: '', steers: 0, turn: -1 }
      state.set(agent, s)
    }
    return s
  }

  // 工具结果统一过 provenance 台账（waterfall：先记录再放行原 decision）
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const agent = exec?.agent
      if (exec?.name === 'ask_user_question') markQuestionAsked(agent)
      if (agent && typeof exec?.name === 'string') {
        recordResult(agent, exec.name, result?.content ?? result)
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-bio-genie rigor-guard: provenance record failed: ${String(error)}`)
    }
    return next()
  })

  // 跟踪 assistant 回复文本（session/event 广播，按 session 归到 agent）
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'assistant/message') return
      const agent = sessionAgent.get(session)
      if (!agent) return
      const text = messageText(event.data?.message)
      if (text) st(agent).lastReply = text
    } catch { /* 绝不影响会话事件流 */ }
  })

  // 回合开始：重置打回计数与提问豁免
  ctx.on('agent/turn-start', ({ agent }) => {
    try {
      if (!agent) return
      if (agent.session) sessionAgent.set(agent.session, agent)
      const s = st(agent)
      s.steers = 0
      s.lastReply = ''
      beginTurn(agent)
    } catch { /* ignore */ }
  })

  // 回合收尾：扫描回复，无溯源数字 → steer 打回
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      if (!agent) return
      if (agent.session) sessionAgent.set(agent.session, agent)
      const s = st(agent)
      // 回合号变化时重置打回计数与提问豁免（不依赖 turn-start 事件是否存在）
      if (s.turn !== turn) {
        s.turn = turn
        s.steers = 0
        beginTurn(agent)
      }
      // 台账为空（没用过工具）或本回合已向用户提问 → 不强制
      if (ledgerSize(agent) === 0 || sawQuestion(agent)) return
      if (s.steers >= MAX_STEERS_PER_TURN || !s.lastReply) return
      const violations = findUnverifiedNumbers(agent, s.lastReply)
      if (violations.length === 0) return
      s.steers += 1
      const list = violations.map((v) => `\`${v}\``).join('、')
      agent.steer({
        content: [{
          type: 'text',
          text:
            `[dsh-bio-genie 计算防火墙] 你刚才的回复包含无工具溯源的数值声明：${list}。\n` +
            `这些数字不在本轮任何工具输出的 _provenance 台账中。请调用相应 bio_* 工具` +
            `实际计算/验证这些数值后再回复；若它们只是计划中的提议值（而非结论），` +
            `请改用 ask_user_question 向用户确认，或在文本中明确标注 [提议-待验证]。`,
        }],
        source: { kind: 'plugin', plugin: 'dsh-bio-genie' },
      })
      ctx.logger?.info?.(`dsh-bio-genie rigor-guard: blocked ${violations.length} unverified claim(s): ${violations.join(', ')}`)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-bio-genie rigor-guard: turn-stopping check failed: ${String(error)}`)
    }
  })
}
