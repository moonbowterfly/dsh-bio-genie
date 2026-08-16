/**
 * dsh-bio-genie — 插件主模块（合并版）
 *
 * 注入 tools / skills / systemPrompt，贡献：
 *  - 系统提示词段（许愿式分析指引，persona.md 可编辑）
 *  - skill 目录（14 领域 + 1 主 skill）
 *  - bio_python 执行器 + bio_env + 11 个语义化工具
 *  - 后台预热 Python 环境（零依赖自举：uv + venv + biopython）
 *
 * @module dsh-bio-genie
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BIO_PROMPT_SECTION } from './prompt.js'
import { registerSkills } from './skills.js'
import { registerTools } from './tools.js'
import { ensureEnvironment } from './runtime.js'

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

/** Cordis 插件名（cordis.patch.yml 的 row id）。 */
export const name = 'dsh-bio-genie'

/** 需要的服务。 */
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
  registerSkills(ctx, SKILLS_DIR)
  registerTools(ctx, cfg)

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
