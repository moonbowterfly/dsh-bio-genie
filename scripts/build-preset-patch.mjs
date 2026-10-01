#!/usr/bin/env node
/**
 * dsh-bio-genie — 由 preset/ 源生成 cordis.patch.yml
 *
 * 单一数据源：preset/bio-genie/{agent.cordis.yml, preset.yml} → 本文件生成
 * cordis.patch.yml 的 preset 声明段。改 persona / skills 后运行本脚本重建。
 *
 * 双引擎版本行为（关键设计，2026-10-01 实测）：
 *   0.2.0+：`@deepseek-ai/dsh-agent-preset` 声明生效 —— 安装插件即自动获得
 *           「生物精灵」preset；customSkillDirs 用 createRequire(baseUrl) 动态
 *           解析本包内的 preset/bio-genie/skills。
 *   0.1.x ：无 `@deepseek-ai/dsh-agent-preset` 包（fail-loud：其行若参与加载会
 *           令整个 plugin tree 失败）。disabled 表达式做「能力检测」：不可
 *           解析时自动禁用该行（安全跳过）；preset 仍由 postinstall
 *           （scripts/install-preset.js）以文件式（~/.dsh/.agent-presets）提供。
 *
 * 用法：node scripts/build-preset-patch.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const PRESET_DIR = join(REPO_ROOT, 'preset', 'bio-genie')

const agentYml = readFileSync(join(PRESET_DIR, 'agent.cordis.yml'), 'utf8')
const metaYml = readFileSync(join(PRESET_DIR, 'preset.yml'), 'utf8')

const name = /^name:\s*(.+)$/m.exec(metaYml)?.[1]?.trim()
const desc = /^description:\s*(.+)$/m.exec(metaYml)?.[1]?.trim()
const order = /^order:\s*(\d+)$/m.exec(metaYml)?.[1]?.trim()
if (!name || !desc || !order) throw new Error('preset.yml 缺少 name/description/order')

// ── 表达式（能力检测 + 动态路径；两版求值都不抛错）────────────────────────
const DISABLED_EXPR =
  '!!js "(() => { try { return !process.getBuiltinModule(\'node:module\')' +
  '.createRequire(baseUrl).resolve(\'@deepseek-ai/dsh-agent-preset/package.json\') } catch { return true } })()"'
const SKILLS_EXPR =
  '!!js "(() => { try { return process.getBuiltinModule(\'node:path\').join(' +
  'process.getBuiltinModule(\'node:path\').dirname(' +
  'process.getBuiltinModule(\'node:module\').createRequire(baseUrl)' +
  '.resolve(\'@dsh-bio/dsh-bio-genie/package.json\')), \'preset\', \'bio-genie\', \'skills\') } ' +
  'catch { return process.getBuiltinModule(\'node:path\').join(' +
  'process.env.DSH_HOME || process.env.USERPROFILE || \'.\', ' +
  '\'.dsh\', \'.agent-presets\', \'bio-genie\', \'skills\') } })()"'

// ── 从 agent.cordis.yml 提取行数组（从 persona 起），替换 skills 表达式 ──
const lines = agentYml.split('\n')
const start = lines.findIndex((l) => l.startsWith('- id: persona'))
if (start < 0) throw new Error('agent.cordis.yml: 未找到 "- id: persona" 起始行')

const body = []
let skillsReplaced = 0
for (const line of lines.slice(start)) {
  if (line.includes('fileURLToPath')) {
    const indent = line.match(/^\s*/)[0]
    body.push(' '.repeat(10) + `${indent}- ${SKILLS_EXPR}`)
    skillsReplaced += 1
  } else if (line.trim() === '') {
    body.push('')
  } else {
    body.push(' '.repeat(10) + line)
  }
}
if (skillsReplaced !== 1) throw new Error(`customSkillDirs 表达式替换数=${skillsReplaced}（预期 1）`)

// ── 组装 cordis.patch.yml ─────────────────────────────────────────────────
const out = `# dsh-bio-genie bundle patch: inserts the plugin row over whatever profile it
# is stacked on, plus (DSH 0.2.0+) the bio-genie agent preset declaration.
# Applied AFTER @deepseek-ai/dsh-base (which supplies the \`tools\`, \`skills\`,
# and \`systemPrompt\` services this plugin injects).
#
# [preset 声明行的双版本语义]
#   - DSH 0.2.0+：\`@deepseek-ai/dsh-agent-preset\` 可解析 → 行生效，安装插件即
#     自动出现「生物精灵」preset；skills 由 createRequire(baseUrl) 动态解析
#     本包内 preset/bio-genie/skills。
#   - DSH 0.1.x ：无该包（fail-loud 引擎）→ disabled 能力检测为 true，行被
#     安全跳过；preset 仍由 postinstall（scripts/install-preset.js）以文件式
#     （~/.dsh/.agent-presets/bio-genie）提供。
#
# The plugin's own Schemastery schema supplies every default; users can
# override any field from their profile cordis.patch.yml or a --patch overlay
# by id \`dsh-bio-genie\`.
#
# Example override (pin the bundled environment to an explicit directory):
#   - id: dsh-bio-genie
#     name: '@dsh-bio/dsh-bio-genie'
#     config:
#       pythonEnvDir: 'D:/data/dsh-bio-env'
#       uvBase: 'https://gh-proxy.com/https://github.com/astral-sh/uv/releases/download/0.7.5'
#
# ⚠️ 本文件由 scripts/build-preset-patch.mjs 生成（单一数据源 preset/bio-genie/），
#    请勿手改；修改 persona/skills 后重新运行生成脚本。

- insert:
    - id: dsh-bio-genie
      name: '@dsh-bio/dsh-bio-genie'
    - id: preset-bio-genie
      name: '@deepseek-ai/dsh-agent-preset'
      disabled: ${DISABLED_EXPR}
      config:
        id: bio-genie
        name: '${name}'
        description: '${desc}'
        order: ${order}
        plugins:
${body.join('\n')}
`

const outPath = join(REPO_ROOT, 'cordis.patch.yml')
writeFileSync(outPath, out, 'utf8')
console.log(`generated: ${outPath}`)
console.log(`  lines: ${out.split('\n').length} | skillsReplaced: ${skillsReplaced}`)
