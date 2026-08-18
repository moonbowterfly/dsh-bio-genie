#!/usr/bin/env node
/**
 * dsh-bio-genie — postinstall 钩子
 *
 * 作用：把 `preset/bio-genie/` 复制到 `$DSH_HOME/.agent-presets/bio-genie/`，
 * 让用户安装插件后能在 dsh 的预设选择器里看到「生物基因精灵」人设。
 *
 * 设计原则：
 *   - 幂等：已存在不覆盖（保护用户就地编辑的 persona / skill 文件）
 *   - 非致命：失败仅 warn，不 throw——不挡其他 npm 脚本/postinstall
 *   - Windows 友好：路径用 path.join；DSH_HOME 优先取环境变量，否则 $USERPROFILE/.dsh
 *   - 支持 --force：CI / 调试时强制覆盖
 *   - 支持 --dry-run：只看会做什么，不实际操作
 *
 * 调用方式：
 *   1. 自动：npm 装完插件后跑的 `npm run build:preset` / `postinstall`
 *   2. 手动：node scripts/install-preset.js [--force] [--dry-run]
 *
 * @module dsh-bio-genie/install-preset
 */
import { existsSync, statSync, mkdirSync, readdirSync, copyFileSync, readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
// scripts/install-preset.js → 仓库根；presets 在 preset/bio-genie/
const REPO_ROOT = join(__dirname, '..')
const PRESET_SRC = join(REPO_ROOT, 'preset', 'bio-genie')
const PRESET_ID = 'bio-genie'

/** 从环境变量或 $USERPROFILE/$HOME 推 DSH_HOME。 */
function resolveDshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME
  // dsh 自己的 home-paths 规则：跨平台 <user-home>/.dsh
  const userHome = process.env.USERPROFILE || process.env.HOME || homedir()
  return join(userHome, '.dsh')
}

/** 解析脚本参数。 */
function parseArgs(argv) {
  return {
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose') || argv.includes('-v'),
  }
}

/** 递归拷贝目录（同步版，体量小无需并发）。 */
function copyDirSync(src, dst, { force, skipExisting, verbose }) {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(s, d, { force, skipExisting, verbose })
      continue
    }
    if (entry.isFile()) {
      if (existsSync(d) && skipExisting) {
        if (verbose) console.log(`[install-preset]   skip: ${d}`)
        continue
      }
      // 用户已就地编辑过：--force 时才覆盖，否则保留
      if (existsSync(d) && !force) {
        if (verbose) console.log(`[install-preset]   keep existing: ${d}`)
        continue
      }
      copyFileSync(s, d)
      if (verbose) console.log(`[install-preset]   write: ${d}`)
    }
  }
}

/** 主流程。 */
function main() {
  const args = parseArgs(process.argv.slice(2))

  // 1. 源端校验
  if (!existsSync(PRESET_SRC)) {
    console.warn(`[install-preset] source preset not found at ${PRESET_SRC} (可能是从 npm 包根目录直接跑，忽略)`)
    return 0
  }
  if (!existsSync(join(PRESET_SRC, 'agent.cordis.yml')) || !existsSync(join(PRESET_SRC, 'preset.yml'))) {
    console.warn(`[install-preset] preset at ${PRESET_SRC} incomplete (missing preset.yml or agent.cordis.yml), skipping`)
    return 0
  }

  // 2. 目标端计算
  const dshHome = resolveDshHome()
  const targetRoot = join(dshHome, '.agent-presets')
  const targetDir = join(targetRoot, PRESET_ID)

  // 3. dry-run
  if (args.dryRun) {
    const srcStat = statSync(PRESET_SRC)
    console.log(`[install-preset] dry-run: would copy ${PRESET_SRC} (${srcStat.size} bytes) → ${targetDir}`)
    console.log(`[install-preset]   DSH_HOME = ${dshHome}`)
    console.log(`[install-preset]   options: ${JSON.stringify(args)}`)
    return 0
  }

  // 4. 真正拷贝
  try {
    mkdirSync(targetRoot, { recursive: true })
  } catch (e) {
    console.warn(`[install-preset] cannot create ${targetRoot}: ${e?.message ?? e}`)
    console.warn(`[install-preset] skipping preset install (dsh 仍可用，只是不显示该预设——用户可手动复制插件目录内 preset/bio-genie/ 到 ${targetRoot}/bio-genie/)`)
    return 0
  }

  const existed = existsSync(targetDir)
  if (existed && !args.force) {
    console.log(`[install-preset] preset already installed at ${targetDir} (use --force to overwrite)`)
    return 0
  }

  try {
    copyDirSync(PRESET_SRC, targetDir, { force: args.force, skipExisting: !args.force, verbose: args.verbose })
  } catch (e) {
    console.warn(`[install-preset] copy failed: ${e?.message ?? e}`)
    console.warn(`[install-preset] preset not installed; dsh 仍可用，预设选择器不会出现「生物基因精灵」`)
    return 0
  }

  // 5. 展示结果
  const action = existed ? 'updated' : 'installed'
  const files = readdirSync(targetDir)
  console.log(`[install-preset] preset ${action} → ${targetDir}`)
  console.log(`[install-preset]   files: ${files.join(', ')}`)
  console.log(`[install-preset]   tip: 重启 dsh web → 设置面板选「生物基因精灵」即可激活精灵专家人设`)
  if (existsSync(join(targetDir, 'skills'))) {
    const skills = readdirSync(join(targetDir, 'skills'))
    console.log(`[install-preset]   bundled skills: ${skills.join(', ')}`)
  }
  return 0
}

try {
  process.exit(main())
} catch (e) {
  // 兜底：scripts 任何崩溃都非致命
  console.warn(`[install-preset] unexpected error: ${e?.message ?? e}`)
  console.warn(`[install-preset] preset installation skipped; plugin still works without the preset`)
  process.exit(0)
}
