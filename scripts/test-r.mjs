// R 执行层回归测试：r_bridge.R JSON 契约 + 错误判定 + UTF-8。
// R 未引导（无 Rscript）时跳过——惰性引导不应阻塞常规 bench。
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runRBridge, rscriptPath, rLibDir } from '../src/r-runtime.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const rscript = rscriptPath({})
const lib = rLibDir({})

if (!existsSync(rscript)) {
  console.log('[r] R 环境未引导（首次 bio_r 调用时惰性触发）——跳过 R 执行层测试')
  process.exit(0)
}

console.log(`[r] 使用 ${rscript}`)

// 1. 基础往返 + result 变量
const basic = await runRBridge(rscript, lib, 'x <- 1 + 2\ncat("hello")\nresult <- list(sum = x, text = "你好")', { timeoutMs: 120_000 })
assert(basic.ok === true, '基础执行 ok')
assert(basic.stdout.includes('hello'), 'stdout 捕获 cat 输出')
assert(basic.result && basic.result.sum === 3, `result 结构化返回（sum=${basic.result?.sum}）`)
assert(basic.result && basic.result.text === '你好', 'UTF-8 中文经 JSON 往返无损')

// 2. 错误 → needs_repair 判定（R 错误打印 Error/Execution halted）
const bad = await runRBridge(rscript, lib, 'stop("boom")', { timeoutMs: 120_000 })
assert(/Error/.test(bad.stderr) || /Execution halted/.test(bad.stderr), `stderr 含 R 错误标记（${bad.stderr.slice(0, 80)}）`)

// 3. 中文 stdout（Windows GBK 环境防乱码的关键回归）
const zh = await runRBridge(rscript, lib, 'cat("中文输出测试\\n")', { timeoutMs: 120_000 })
assert(zh.stdout.includes('中文输出测试'), '中文 stdout 不乱码')

// 4. data.frame result
const df = await runRBridge(rscript, lib, 'd <- data.frame(g = c("a","b"), v = c(1,2))\nresult <- list(n = nrow(d), top = d)', { timeoutMs: 120_000 })
assert(df.ok && df.result && df.result.n === 2 && Array.isArray(df.result.top), 'data.frame 结果 JSON 化（top 是数组）')
assert(df.result.top[0].g === 'a' && df.result.top[1].v === 2, 'data.frame 行字段可访问')

// 5. 空代码 / 非法信封不崩
const empty = await runRBridge(rscript, lib, '', { timeoutMs: 120_000 })
assert(empty.ok === true, '空代码不崩')
const garbage = await runRBridge(rscript, lib, 'syntax error here (', { timeoutMs: 120_000 })
assert(/Error/.test(garbage.stderr), '语法错误被捕获进 stderr')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
