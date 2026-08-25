/**
 * dsh-bio-genie — 工作区解析（bio_python / 语义化工具共用）
 *
 * 优先级：
 *   1. 显式 workdir 参数（绝对路径原样使用；相对路径基于下面的基准解析）
 *   2. 会话工作区 `exec.agent.session.header.cwd`（与 dsh 内置 fs 工具的
 *      session-cwd 做法一致：每个会话操作自己的工作区，而不是服务器启动目录）
 *   3. 保底工作区 `~/deepseek-harness/bio-genie-workspace`（会话工作区未
 *      指定或不可用时自动创建）
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

/** 保底工作区目录（自动创建）。 */
export function fallbackWorkspace() {
  return join(homedir(), 'deepseek-harness', 'bio-genie-workspace')
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

/**
 * 解析一次工具调用的工作目录。
 * @param {object} [exec] 工具执行上下文。
 * @param {string} [workdir] 用户显式指定的工作目录（绝对路径，或相对基准的相对路径）。
 * @returns {string} 解析后的绝对路径。
 */
export function resolveWorkdir(exec, workdir) {
  const base = sessionWorkspace(exec) ?? fallbackWorkspace()
  const cwd = !workdir
    ? base
    : isAbsolute(workdir)
      ? workdir
      : resolve(base, workdir)

  // 保底目录可能尚不存在：幂等创建，避免 python 写文件时目录缺失。
  if (!existsSync(cwd)) {
    try {
      mkdirSync(cwd, { recursive: true })
    } catch {
      // 只读/权限受限等场景不致命：bridge 会在 chdir 失败时保持原目录并报错
    }
  }
  // 规范目录：result/figures/out 自动预建
  ensureOutputDirs(cwd)
  return cwd
}
