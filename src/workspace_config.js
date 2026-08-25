/**
 * dsh-bio-genie — 默认工作区配置（bio agent 默认工作区 A 路径）
 *
 * 语义（用户规范 2026-08-25）：
 *   - 用户在设置面板「工作区」tab 指定 A 路径后，bio-genie 预设会话
 *     未显式指定工作区（无 session.header.cwd）时，自动以 A 为默认工作区
 *   - 未设置 / 清空 → 保持 dsh 默认行为（插件保底 ~/.dsh/sessions/default）
 *
 * 存储：~/.dsh/dsh-bio-genie/workspace-config.json（插件运行时目录，原子写）
 *
 * @module dsh-bio-genie/workspace-config
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, dirname } from 'node:path'

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

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

/** 写默认工作区配置（原子写：tmp + rename）。value 为路径字符串或 null（清空）。 */
export function setConfiguredDefaultWorkspace(value) {
  const file = workspaceConfigFile()
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({
    defaultWorkspace: typeof value === 'string' && value.trim() ? value.trim() : null,
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * 设置面板「工作区」tab 端点：
 *   GET  /api/dsh-bio-genie/workspace-config → { defaultWorkspace, configured, configFile }
 *   POST /api/dsh-bio-genie/workspace-config { defaultWorkspace: 'D:/...' | null | '' } → 写入
 */
export async function handleWorkspaceConfig(req, res) {
  if (req.method === 'GET') {
    const a = getConfiguredDefaultWorkspace()
    writeJson(res, 200, {
      ok: true,
      value: {
        defaultWorkspace: a || null,
        configured: !!a,
        configFile: workspaceConfigFile(),
      },
    })
    return
  }
  // POST
  const val = req.body && req.body.defaultWorkspace
  const next = typeof val === 'string' && val.trim() ? val.trim() : null
  if (next !== null && !isAbsolute(next)) {
    writeJson(res, 400, {
      ok: false,
      code: 'not-absolute',
      message: `默认工作区必须是绝对路径（如 D:/Program/dsh/my-workspace），收到: ${next}`,
    })
    return
  }
  try {
    setConfiguredDefaultWorkspace(next)
    writeJson(res, 200, { ok: true, value: { defaultWorkspace: next, updated: true } })
  } catch (err) {
    writeJson(res, 500, { ok: false, code: 'write-failed', message: err?.message || String(err) })
  }
}