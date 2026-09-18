/**
 * 通用 Python 测试运行器（bench 链用，跨平台）。
 *
 * 解析 python 解释器（与 test-ops.mjs 的 findPython 同款优先级）：
 *   DSH_BIO_PYTHON 环境变量 → DSH_HOME/dsh-bio-genie/python-env → PATH 上的 python
 * 然后运行指定脚本；非零退出即失败（fail-closed）。
 *
 * 用法: node scripts/run-python-test.mjs scripts/test-blast-params.py
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function findPython() {
  if (process.env.DSH_BIO_PYTHON) return process.env.DSH_BIO_PYTHON
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const venv = join(home, 'dsh-bio-genie', 'python-env')
  const exe = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
  return existsSync(exe) ? exe : 'python'
}

const script = process.argv[2]
if (!script) {
  console.error('usage: node scripts/run-python-test.mjs <path-to-test.py>')
  process.exit(2)
}
const repoRoot = resolve(import.meta.dirname, '..')
const r = spawnSync(findPython(), [script], { cwd: repoRoot, stdio: 'inherit', windowsHide: true })
if (r.error) {
  console.error(`failed to spawn python: ${r.error.message}`)
  process.exit(1)
}
if (r.status !== 0) {
  console.error(`python test failed: ${script} (exit ${r.status})`)
  process.exit(1)
}
console.log(`python test passed: ${script}`)
