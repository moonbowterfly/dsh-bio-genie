/**
 * dsh-bio-genie — 工作区解析（bio_python / 语义化工具共用）
 *
 * 优先级：
 *   1. 显式 workdir 参数（绝对路径原样使用；相对路径基于下面的基准解析）
 *   2. 会话工作区 `exec.agent.session.header.cwd`（与 dsh 内置 fs 工具的
 *      session-cwd 做法一致：每个会话操作自己的工作区，而不是服务器启动目录）
 *   3. 遗留配置的默认工作区 A `~/.dsh/dsh-bio-genie/workspace-config.json`
 *      （仅当历史版本写过该文件时生效；该用户特性已由新版 dsh 引擎的
 *      workspace-first 机制取代，设置面板入口已移除，详见 workspace_config.js）
 *   4. 保底工作区 `~/.dsh/sessions/default`（以上均未指定或不可用时自动创建）
 *
 * 历史背景：旧实现默认 `process.cwd()`（dsh 服务器启动目录），导致
 * bio_python 写出的文件落在 checkout 目录而不是会话工作区，且与
 * bio-core skill 中「程序在工作区目录下运行」的描述不符。
 *
 * @module dsh-bio-genie/workdir
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { getConfiguredDefaultWorkspace } from './workspace_config.js'

/** dsh 工作区根目录（用户规范 2026-08-25：所有会话工作区统一位于 ~/.dsh/sessions/ 下）。 */
export function workspaceRoot() {
  return join(homedir(), '.dsh', 'sessions')
}

/** 保底工作区目录（自动创建；仅无会话 cwd / 未指定显式 workdir 时使用）。 */
export function fallbackWorkspace() {
  return join(workspaceRoot(), 'default')
}

/**
 * 会话工作区目录。
 * @param {object} [exec] 工具执行上下文（defineTool execute 的第二参数）。
 * @returns {string|undefined} 会话 cwd；未指定或不可读时返回 undefined。
 */
export function sessionWorkspace(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  if (!existsSync(cwd)) return undefined
  return cwd
}

/** 工作区规范子目录（每次解析工作区时自动创建，供产物分类落位）。 */
export const WORKSPACE_DIRS = ['result', 'figures', 'out']

/**
 * 幂等创建工作区规范子目录（result=交付物 / figures=出版级图 / out=中间数据）。
 * @param {string} cwd 工作区绝对路径。
 */
export function ensureOutputDirs(cwd) {
  for (const name of WORKSPACE_DIRS) {
    try {
      const dir = join(cwd, name)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    } catch {
      // 只读/权限受限等场景不致命：bridge 会在 chdir 失败时保持原目录并报错
    }
  }
}

/** 幂等确保目录存在（不存在则创建；失败静默——由调用方决定回退）。 */
function ensureDir(dir) {
  if (existsSync(dir)) return true
  try {
    mkdirSync(dir, { recursive: true })
    return existsSync(dir)
  } catch {
    return false
  }
}

/**
 * 目录是否可用作工作区：已存在即可用；不存在则尝试创建，创建成功才可用。
 * 创建失败（盘符不存在 / 无权限 / 只读）→ 不可用，调用方必须回退，
 * 以避免把「存在于别台电脑、本机没有」的路径直接当工作区使用。
 */
function usableWorkspaceDir(dir) {
  return ensureDir(dir)
}

/**
 * 解析一次工具调用的工作目录。
 * 优先级：显式 workdir 参数 > 会话工作区 header.cwd（排除 dsh 框架默认填充的服务器目录）
 *   > 遗留配置的默认工作区 A（workspace-config.json，仅历史文件存在时生效，需本机可用否则回退）
 *   > 插件保底 ~/.dsh/sessions/default。
 *
 * 说明（2026-08-25 实测）：
 * - dsh 对未显式指定 cwd 的会话会把 header.cwd 填充为服务器启动目录
 *   （process.cwd()），并非 undefined——若直接使用，遗留配置的默认工作区 A
 *   永远不会生效。因此当 sessionWorkspace 等于 process.cwd() 时视为
 *   「未指定工作区」，继续走配置/保底链。
 * - 配置的默认工作区 A 可能是指定者在别的机器上配置的路径（本机不存在、
 *   盘符不同/缺失）：必须实际可创建才采用，否则安全回退，绝不硬用坏路径。
 * - 新版 dsh 引擎 workspace-first（UI 必须选工作区开会话），第③层仅服务
 *   升级前已写入 workspace-config.json 的存量部署；新用户永远走②/④。
 *
 * @param {object} [exec] 工具执行上下文。
 * @param {string} [workdir] 用户显式指定的工作目录（绝对路径，或相对基准的相对路径）。
 * @returns {string} 解析后的绝对路径。
 */
export function resolveWorkdir(exec, workdir) {
  const serverCwd = process.cwd()
  const rawSessionCwd = sessionWorkspace(exec)
  const sessionCwd = rawSessionCwd && rawSessionCwd !== serverCwd ? rawSessionCwd : undefined

  // ① 用户显式 workdir 参数：尽力使用（相对路径基于会话工作区/保底解析）
  if (workdir) {
    const base = sessionCwd || fallbackWorkspace()
    const cwd = isAbsolute(workdir) ? workdir : resolve(base, workdir)
    ensureDir(cwd)
    ensureOutputDirs(cwd)
    return cwd
  }

  // ② 会话工作区（用户显式用 cwd 创建的会话）
  if (sessionCwd) {
    ensureDir(sessionCwd)
    ensureOutputDirs(sessionCwd)
    return sessionCwd
  }

  // ③ 用户配置的默认工作区 A：必须本机可用（存在或能创建成功），否则回退
  const configured = getConfiguredDefaultWorkspace()
  if (configured && usableWorkspaceDir(configured)) {
    ensureOutputDirs(configured)
    return configured
  }

  // ④ 保底默认工作区
  const fb = fallbackWorkspace()
  ensureDir(fb)
  ensureOutputDirs(fb)
  return fb
}
