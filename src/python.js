/**
 * dsh-bio-genie — Python 调用封装（双通道）
 *
 * 1. runBridge()   — bio_python 执行器通道：spawn bridge.py，stdin 传
 *                    {code, cwd}，stdout 收 {ok, stdout, stderr, result, ...}
 * 2. callBio()     — 语义化工具通道：spawn bio_ops.py，stdin 传 {op, args}，
 *                    stdout 收 {ok, result|error}
 *
 * 两者都使用 -I（isolated mode）忽略宿主 PYTHONPATH/PYTHONHOME，防止环境污染。
 * @module dsh-bio-genie/python
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const BRIDGE_PATH = join(import.meta.dirname, '..', 'python', 'bridge.py')
const OPS_PATH = join(import.meta.dirname, '..', 'python', 'bio_ops.py')

export function spawnPython(exe, script, payload, { cwd, timeoutMs, signal } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(exe, ['-I', script], {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // 隔离宿主环境：-I 已忽略 PYTHONPATH，这里再清一次保险
      env: { ...process.env, PYTHONPATH: '', PYTHONHOME: '' },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let didTimeout = false

    const settle = (obj) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolvePromise(obj)
    }
    const onAbort = () => child.kill()
    const timer = setTimeout(() => { didTimeout = true; child.kill() }, timeoutMs)

    if (signal) {
      if (signal.aborted) child.kill()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => settle({ ok: false, stdout, stderr, error: String(err), exitCode: null, timedOut: false }))
    child.on('close', (code) => {
      let parsed = null
      try { parsed = JSON.parse(stdout.trim()) } catch { /* fallthrough */ }
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
        // P2-1 exitCode 校验：桥/ops 脚本所有合法出口都返回 exit 0（代码级失败也是
        // ok:true+stderr traceback 或 ok:false+exit 0）。close code!==0（非超时）说明
        // 进程未走正常出口（外部 kill/崩溃/输出中断），即便 stdout 有合法 JSON 也不可信，
        // 按失败处理并保留现场供诊断。
        if (code !== 0 && !didTimeout) {
          settle({
            ok: false, stdout, stderr,
            error: `python exited abnormally (code ${code}) after producing output; output not trusted`,
            exitCode: code, timedOut: false,
          })
          return
        }
        // 超时后 kill 与进程自行退出存在竞态：即便 kill 前恰好输出了合法 JSON，
        // 只要超时已发生就如实标记，让上层知道执行未完整
        settle({ ...parsed, exitCode: code, timedOut: didTimeout })
      } else {
        const reason = didTimeout
          ? `python execution timed out after ${timeoutMs} ms (exit ${code})`
          : `python returned no valid JSON (exit ${code})`
        settle({ ok: false, stdout, stderr, error: reason, exitCode: code, timedOut: didTimeout })
      }
    })
    try {
      child.stdin.write(JSON.stringify(payload))
      child.stdin.end()
    } catch (err) {
      // python 未启动（如路径不存在）时 stdin 可能已关闭；error 事件会兜底上报
      settle({ ok: false, stdout, stderr, error: `stdin write failed: ${err.message}`, exitCode: null, timedOut: false })
    }
  })
}

/**
 * 执行任意 Python 代码（bio_python 执行器）。
 * @param {string} pythonPath venv python
 * @param {string} code Python 源码
 * @param {{cwd?: string, timeoutMs?: number, signal?: AbortSignal}} [opts]
 */
export function runBridge(pythonPath, code, { cwd, timeoutMs = 60_000, signal } = {}) {
  return spawnPython(pythonPath, BRIDGE_PATH, { code, cwd: cwd || process.cwd() }, { cwd, timeoutMs, signal })
}

/**
 * 调用一个语义化操作（bio_ops.py 注册表）。
 * @param {string} pythonPath venv python
 * @param {string} op 操作名
 * @param {object} args 参数
 * @param {{cwd?: string, timeoutMs?: number, signal?: AbortSignal}} [opts]
 */
export function callBio(pythonPath, op, args = {}, { cwd, timeoutMs = 60_000, signal } = {}) {
  return spawnPython(pythonPath, OPS_PATH, { op, args }, { cwd, timeoutMs, signal })
}
