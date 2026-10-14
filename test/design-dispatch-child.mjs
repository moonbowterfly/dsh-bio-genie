// design-dispatch 顺序测试子进程：在给定 genie 副本中调用 dispatchDesignOp 并输出 JSON 结果。
// argv: <genieCopyDir> <pythonPath> [op]
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const [dir, py, opArg] = process.argv.slice(2)
const op = opArg || 'design_chassis_profile'
const mod = await import(pathToFileURL(join(dir, 'src', 'design-dispatch.js')).href)
const res = await mod.dispatchDesignOp(py, op, {}, { cwd: dir, timeoutMs: 30000 })
console.log(JSON.stringify({
  ok: res.ok,
  code: res.code || null,
  dispatch_id: res.dispatch_id || null,
  staging_dir: res.staging_dir || null,
  error: String(res.error || '').slice(0, 160),
}))
