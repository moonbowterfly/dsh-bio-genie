/**
 * dsh-bio-genie — rigor-guard（计算防火墙的运行时层）
 *
 * ⚙️ 模式说明（2026-09-12 用户决策：由「回合拦截」降级为「溯源提醒」）：
 * 旧模式曾用 agent.steer() 在收尾前**物理打回**含无溯源数字的回复——实战发现
 * 数字本身往往是对的（只是台账滞后/四位小数截断），打回反而打断工作流、拖慢回合。
 * 现模式：**放行回复 + 在收尾时静默收集违规清单记入日志**；
 * 强制语气改为**文本提醒**（通过 steer 注入要求「下次给数字带出处」，不再阻断本轮）。
 * 台账（provenance.js）与数值检测逻辑保持不变——溯源能力完整保留，只是不再 jail。
 *
 * 挂载框架 agent 生命周期事件：
 *  - `session/event`（assistant/message）：跟踪每个 agent 最新的回复文本
 *  - `agent/turn-stopping`：收尾扫描回复中无溯源的数值声明 → 记日志 + 软提醒
 *
 * 设计约束：
 *  - 只对用过 bio_* 工具的 agent 生效（台账为空直接放行，不打扰闲聊）
 *  - 本回合调过 ask_user_question 的放行（决策检查点允许提议数值）
 *  - 提醒注入每回合最多 1 次（软提醒，不重试不强制）
 *  - 任何内部异常只记日志，绝不阻塞 agent 循环
 *
 * @module dsh-bio-genie/rigor-guard
 */
import {
  recordResult, markQuestionAsked, sawQuestion,
  ledgerSize, beginTurn, findUnverifiedNumbers,
} from './provenance.js'

/** 每回合最多软提醒次数（提醒≠拦截；超限完全静默）。 */
const MAX_SOFT_NUDGES_PER_TURN = 1

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
  /** agent → { lastReply: string, nudges: number, turn: number } */
  const state = new WeakMap()
  /** session 对象 → agent 对象（assistant/message 事件不带 agent，靠 session 关联） */
  const sessionAgent = new WeakMap()

  const st = (agent) => {
    let s = state.get(agent)
    if (!s) {
      s = { lastReply: '', nudges: 0, turn: -1 }
      state.set(agent, s)
    }
    return s
  }

  // 工具结果统一过 provenance 台账（waterfall：先记录再放行原 decision）
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const agent = exec?.agent
      // 尽早在"回复文本产生之前"建立 session→agent 映射：session/event 只带 session，
      // 若等到 turn-stopping 才登记，**第一回合的回复根本不会被扫描**（实测缺陷）。
      if (agent?.session) sessionAgent.set(agent.session, agent)
      if (exec?.name === 'ask_user_question') markQuestionAsked(agent)
      if (agent && typeof exec?.name === 'string') {
        recordResult(agent, exec.name, result?.content ?? result)
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-bio-genie rigor-guard: provenance record failed: ${String(error)}`)
    }
    return next()
  })

  // ⚠️ 不要挂 agent/pre-step：该事件是 **waterfall**（引擎读返回值 decision.kind），
  // 普通 emit 语义的处理器会因返回 undefined 直接打断 agent 循环
  //（2026-09-12 实测：turn/end 报 "Cannot read properties of undefined (reading 'kind')"）。
  // session→agent 映射在 tools/post-execute 里登记已足够：只有用过工具的会话才可能触发强制，
  // 而任何工具结果都必然早于同回合的 assistant/message。

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
  // ⚠️ 本引擎（0.1.5-rc.1）不派发 agent/turn-start（只有 turn-stopping），此处理器当前
  // 不会触发；保留它是为引擎将来补上该事件时行为依旧正确（turn-stopping 里已有兜底）。
  ctx.on('agent/turn-start', ({ agent }) => {
    try {
      if (!agent) return
      if (agent.session) sessionAgent.set(agent.session, agent)
      const s = st(agent)
      s.nudges = 0
      s.lastReply = ''
      beginTurn(agent)
    } catch { /* ignore */ }
  })

  // 回合收尾：扫描回复，无溯源数字 → 记日志 + 软提醒（不拦截）
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      if (!agent) return
      if (agent.session) sessionAgent.set(agent.session, agent)
      const s = st(agent)
      // ⚠️ 顺序很重要（2026-09-12 实测修正）：引擎只派发 agent/turn-stopping，
      // **没有** agent/turn-start（见 dsh-agent-loop 的事件表），所以这里就是唯一的
      // 回合状态推进点。旧实现在"判定之前"就 beginTurn()（重置 sawQuestion），
      // 于是本回合 ask_user_question 刚设下的"提议数值豁免"当场被清掉 → 豁免形同虚设。
      // 正解：**先用当前状态判定，跑完再推进**。
      const newTurn = s.turn !== turn
      if (newTurn) s.nudges = 0
      // 台账为空（没用过工具）或本回合已向用户提问 → 完全静默
      const exempt = ledgerSize(agent) === 0 || sawQuestion(agent)
      let violations = []
      if (!exempt && s.lastReply) {
        violations = findUnverifiedNumbers(agent, s.lastReply)
      }
      // 回合推进放在最后：为下一回合清豁免、记回合号（不依赖 turn-start 是否存在）
      if (newTurn) {
        s.turn = turn
        beginTurn(agent)
      }
      // 违规记录（审计留痕：数字出来了但没溯源，日志可查）
      if (violations.length > 0) {
        ctx.logger?.info?.(
          `dsh-bio-genie rigor-guard: noticed ${violations.length} number(s) without provenance: ${violations.join(', ')}`)
      }
      if (exempt || violations.length === 0) return
      if (s.nudges >= MAX_SOFT_NUDGES_PER_TURN) return  // 提醒过就够，不反复打扰
      s.nudges += 1
      const list = violations.slice(0, 6).map((v) => `\`${v}\``).join('、')
      // ⚠️ 必须传完整 message 记录：dsh 0.1.5-rc.1 的会话持久化校验
      // （dsh-session assertMessageEventShape）要求 user/message 的 data 自带
      // 非空 `id` 与 `role: 'user'`，否则存盘后 resume 直接失败。
      // 这是**本轮之后的提醒**（回复已放行）：要求下一轮给数字带上出处，
      // 不要求撤回、不要求停止本轮工作。
      agent.steer({
        id: `plugin-msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        role: 'user',
        source: { kind: 'plugin', plugin: 'dsh-bio-genie' },
        content: [{
          type: 'text',
          text:
            `[dsh-bio-genie 溯源提醒] 刚才的回复里有这些数字本轮没在工具输出中出现过：${list}。` +
            `不用撤回，本轮继续；但**下次引用关键数值时请顺带说明来源**（哪个工具/哪次计算，` +
            `或补一次 bio_* 调用验证）。若它只是计划值，标注 [提议-待验证] 即可。`,
        }],
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-bio-genie rigor-guard: turn-stopping check failed: ${String(error)}`)
    }
  })
}
