/**
 * E3 / P2-1 exitCode 校验测试（node test/exitcode-check.mjs）
 *
 * 用例：
 *  1) fake bridge：打印合法 {ok:true} JSON 后 sys.exit(3)（非超时异常退出）
 *     → 期望 ok:false（修复前会透传 ok:true —— P2-1 缺口）
 *  2) 真 bridge 正常代码 → 期望 ok:true、exitCode 0（回归）
 *  3) 真 bridge 抛异常代码 → 期望 ok:true + stderr 含 Traceback（bridge 契约回归；
 *     needs_repair 判定在 tools.js 层）
 *
 * 注意：直接调 spawnPython（本测试为此将其导出）；真 bridge 用例用系统 python。
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnPython } from '../src/python.js'

const PYTHON = process.argv[2] || 'C:/Users/shuai/miniconda3/python.exe'

const tmp = mkdtempSync(join(tmpdir(), 'genie-exitcode-'))
const fakeBridge = join(tmp, 'fake_bridge.py')
writeFileSync(fakeBridge, [
  'import json, sys',
  'sys.stdin.read()  # 消费 payload，与真 bridge 输入协议一致',
  "sys.stdout.write(json.dumps({'ok': True, 'result': 42}))",
  'sys.stdout.flush()',
  'sys.exit(3)',
].join('\n'))

let failures = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

// 用例 1：非超时异常退出 + 合法 JSON → 必须判失败
{
  const out = await spawnPython(PYTHON, fakeBridge, { code: 'x' }, { timeoutMs: 30_000 })
  check('case1 abnormal exit(3) with valid JSON → ok:false', out.ok === false,
    `ok=${out.ok} exitCode=${out.exitCode} error=${out.error}`)
  check('case1 exitCode preserved for diagnostics', out.exitCode === 3, `exitCode=${out.exitCode}`)
  check('case1 not flagged as timeout', out.timedOut === false, `timedOut=${out.timedOut}`)
}

// 用例 2：真 bridge 正常路径回归
{
  const out = await spawnPython(PYTHON, join(import.meta.dirname, '..', 'python', 'bridge.py'),
    { code: 'result = 6 * 7' }, { timeoutMs: 60_000 })
  check('case2 normal bridge → ok:true', out.ok === true, `ok=${out.ok} exitCode=${out.exitCode}`)
  check('case2 exitCode 0', out.exitCode === 0, `exitCode=${out.exitCode}`)
  check('case2 result carried', out.result === 42, `result=${JSON.stringify(out.result)}`)
}

// 用例 3：真 bridge 代码异常 → ok:true + stderr Traceback（契约不回归）
{
  const out = await spawnPython(PYTHON, join(import.meta.dirname, '..', 'python', 'bridge.py'),
    { code: 'raise ValueError("boom")' }, { timeoutMs: 60_000 })
  check('case3 bridge catches code error → ok:true', out.ok === true, `ok=${out.ok}`)
  check('case3 stderr has Traceback', /Traceback/.test(out.stderr || ''), 'stderr head: ' + (out.stderr || '').slice(0, 60))
  check('case3 exitCode still 0 (handled shape)', out.exitCode === 0, `exitCode=${out.exitCode}`)
}

rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\n结果: 3 用例全过' : `\n结果: ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
