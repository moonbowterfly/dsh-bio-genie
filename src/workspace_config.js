/**
 * dsh-bio-genie — 遗留默认工作区配置（bio agent 默认工作区 A 路径）
 *
 * 语义（2026-08-26 降级为遗留兜底）：
 *   - 新版 dsh 引擎 workspace-first（Web UI 必须先选/建工作区才能开会话），
 *     「默认工作区」作为用户特性已由引擎原生工作区取代，设置面板 tab 与
 *     HTTP 端点已移除。
 *   - 本模块仅保留读取层：历史版本写入的
 *     ~/.dsh/dsh-bio-genie/workspace-config.json 若仍存在，resolveWorkdir()
 *     的解析链继续尊重它（第③优先级），避免升级后静默改变行为。
 *   - 不再提供任何写入入口；文件删除 / 清空 → 自动走保底 ~/.dsh/sessions/default。
 *
 * @module dsh-bio-genie/workspace-config
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 配置文件路径：插件运行时目录 ~/.dsh/dsh-bio-genie/workspace-config.json */
export function workspaceConfigFile() {
  return join(homedir(), '.dsh', 'dsh-bio-genie', 'workspace-config.json')
}

/** 读取用户配置的默认工作区 A（未设置 / 损坏 / 空 → undefined）。不校验目录存在性。 */
export function getConfiguredDefaultWorkspace() {
  const file = workspaceConfigFile()
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const p = raw && raw.defaultWorkspace
    return typeof p === 'string' && p.trim() ? p.trim() : undefined
  } catch {
    return undefined
  }
}
