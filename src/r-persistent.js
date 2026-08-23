/**
 * dsh-bio-genie — 持久化 R 进程管理器
 *
 * 核心优化：保持一个 R 进程常驻，通过 stdin/stdout 通信，
 * 避免每次 bio_r 调用都 spawn 新进程（节省 2-3s 启动时间）。
 *
 * 协议：
 * - 发送：JSON {code: "...", id: "..."}
 * - 接收：JSON {ok: true/false, stdout: "...", stderr: "...", id: "..."}
 * - 通过 id 匹配请求和响应
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rSpawnEnv, rInstallDir, PLUGIN_R_DIR } from './r-runtime.js'

class RPersistentSession {
  constructor(rscript, libDir) {
    this.rscript = rscript
    this.libDir = libDir
    this.process = null
    this.pending = new Map() // id → {resolve, reject, timer}
    this.buffer = ''
    this.ready = false
  }

  start() {
    if (this.process) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const rBridgePath = join(PLUGIN_R_DIR, 'r_bridge_persistent.R')
      this.process = spawn(this.rscript, ['--vanilla', rBridgePath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: rSpawnEnv(this.libDir),
      })

      this.process.stdout.on('data', (d) => {
        this.buffer += d.toString()
        // 尝试解析完整的 JSON 行
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() // 保留未完成的行
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            const pending = this.pending.get(msg.id)
            if (pending) {
              clearTimeout(pending.timer)
              this.pending.delete(msg.id)
              pending.resolve(msg)
            }
          } catch {}
        }
      })

      this.process.stderr.on('data', (d) => {
        // R 启动信息等，忽略
      })

      this.process.on('error', (err) => {
        this.ready = false
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(err)
        }
        this.pending.clear()
        this.process = null
      })

      this.process.on('close', () => {
        this.ready = false
        this.process = null
      })

      // 等待 R 启动完成
      setTimeout(() => {
        this.ready = true
        resolve()
      }, 2000)
    })
  }

  execute(code, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.ready) {
        return reject(new Error('R process not ready'))
      }

      const id = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`R execution timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })

      const msg = JSON.stringify({ code, id }) + '\n'
      this.process.stdin.write(msg)
    })
  }

  stop() {
    if (this.process) {
      this.process.kill()
      this.process = null
      this.ready = false
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('R session stopped'))
    }
    this.pending.clear()
  }
}

// 单例管理器
const sessions = new Map() // libDir → RPersistentSession

export function getPersistentSession(rscript, libDir) {
  if (!sessions.has(libDir)) {
    sessions.set(libDir, new RPersistentSession(rscript, libDir))
  }
  return sessions.get(libDir)
}

export function stopAllSessions() {
  for (const session of sessions.values()) {
    session.stop()
  }
  sessions.clear()
}
