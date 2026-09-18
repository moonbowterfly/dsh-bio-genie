/**
 * dsh-bio-genie — 插件主模块（合并版）
 *
 * 注入 tools / skills / systemPrompt，贡献：
 *  - 系统提示词段（许愿式分析指引，persona.md 可编辑）
 *  - skill 目录（17 领域 + 5 研究 + 19 协议 + 8 指南 + 1 主 skill，共 50 个注册条目）
 *  - bio_python 执行器 + bio_env + bio_log/bio_memory + bio_goal + 57 个语义化工具（共 62 个工具）
 *  - rigor-guard 计算防火墙（_provenance 台账 + turn-stopping 无溯源数字打回）
 *  - 后台预热 Python 环境（零依赖自举：uv + venv + biopython）
 *
 * @module dsh-bio-genie
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BIO_PROMPT_SECTION } from './prompt.js'
import { registerSkills } from './skills.js'
import { registerTools } from './tools.js'
import { registerRigorGuard } from './rigor-guard.js'
import { ensureEnvironment } from './runtime.js'
import { registerApiRoutes } from './server.js'

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
const GUIDES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'agent-guide')

/** Cordis 插件名（cordis.patch.yml 的 row id）。 */
export const name = 'dsh-bio-genie'

/** 需要的**必选**服务。
 *
 * webServer 是**可选**服务（非 web 部署不提供）——曾经它在这里，导致缺少
 * webServer 的宿主中整个插件保持 pending、apply() 永不执行、全部工具注册为 0
 * （2026-09-19 审计发现，与 dsh-bio-gem 同款问题的修复模式对齐）。
 *
 * 现在改用 apply() 内的动态注入 ctx.inject(['webServer'], cb)（官方 dsh 插件
 * 同款模式）：webServer 可用时注册浏览器侧设置面板的 /api/dsh-bio-genie/*
 * 路由（skill 清单 / Python 包列表 / addons / 代谢与编辑域数据）；不可用时
 * 62 个工具与 50 个 skill 照常注册，面板静态部分照常渲染。
 */
export const inject = ['tools', 'skills', 'systemPrompt']

/** 插件配置默认值（不导出 schemastery schema，避免版本差异）。 */
const DEFAULT_CONFIG = {
  defaultTimeoutMs: 60000,
  warmUp: true,
  enableLog: true,
  enableMemory: true,
  pythonEnvDir: undefined,
}

/**
 * 装配插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] 插件配置（可省略）
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  ctx.systemPrompt.section(BIO_PROMPT_SECTION)
  registerSkills(ctx, SKILLS_DIR, GUIDES_DIR)
  registerTools(ctx, cfg)

  // rigor-guard 计算防火墙：工具结果 provenance 台账 + 回合收尾扫描打回。
  // 内部全部 try/catch，任何异常不影响 agent 循环。
  registerRigorGuard(ctx)

  // 设置面板 RPC 路由（loopback-only）：skill 清单 / Python 包列表 / 域数据。
  // webServer 是可选服务——动态注入：可用时注册路由；不可用时什么都不做，
  // 插件其余部分（62 工具 + 50 skill + rigor-guard）已在上方完成注册。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerApiRoutes(webCtx, cfg), 'dsh-bio-genie: api routes')
  })

  // 后台预热（不阻塞加载；失败不致命，工具调用时会重试）
  if (cfg.warmUp !== false) {
    void ensureEnvironment(cfg).then((env) => {
      if (env.ready) {
        console.log(`[dsh-bio-genie] Python 环境就绪 (biopython ${env.biopython})`)
      } else {
        console.warn(`[dsh-bio-genie] Python 环境预热失败: ${env.error ?? 'unknown'}（工具调用时将重试）`)
      }
    })
  }
}
