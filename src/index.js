/**
 * dsh-bio-genie — 插件主模块（合并版）
 *
 * 注入 tools / skills / systemPrompt，贡献：
 *  - 系统提示词段（许愿式分析指引，persona.md 可编辑）
 *  - skill 目录（17 领域 + 4 研究 + 17 协议 + 8 指南 + 1 主 skill，共 47 个注册条目）
 *  - bio_python 执行器 + bio_env + bio_log/bio_memory + bio_goal + 48 个语义化工具（共 53 个工具）
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

/** 需要的服务。
 *
 * tools/skills/systemPrompt 之外新增 'webServer'：浏览器侧设置面板的
 * /api/dsh-bio-genie/* 路由（skill 清单 / Python 包列表）
 * 注册在 webServer 上，路由细节见 src/server.js。webServer 是 dsh 宿主
 * 服务，第三方插件无法在缺少它的部署中提供面板的动态数据；这种部署
 * 下面板会优雅降级（静态部分照常渲染，RPC 端点返回 ok:false）。
 */
export const inject = ['tools', 'skills', 'systemPrompt', 'webServer']

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

  // 设置面板 RPC 路由（loopback-only）：skill 清单 / Python 包列表。
  // registerApiRoutes 内部用 ctx.webServer.register 注册路由，若 webServer
  // 不可用 cordis 会自动降级（inject = ['webServer'] 排队等待）。
  ctx.effect(() => registerApiRoutes(ctx, cfg), 'dsh-bio-genie: api routes')

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
