// throttle.js 单元测试：缓存命中/过期行为 + 限流时序。
// 用法：node scripts/test-throttle.mjs
import { cacheGet, cacheSet, throttle } from '../src/throttle.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

// --- 缓存 ---
console.log('[cache]')
assert(cacheGet('test:k1') === undefined, '空缓存返回 undefined')
cacheSet('test:k1', { a: 1 })
const hit = cacheGet('test:k1')
assert(hit !== undefined && hit.a === 1, '写入后命中，返回原值')
cacheSet('test:k2', { b: 2 })
assert(cacheGet('test:k1')?.a === 1 && cacheGet('test:k2')?.b === 2, '不同 key 互不干扰')

// 逐出：CACHE_MAX=100，塞 105 个，最旧应被逐出
for (let i = 0; i < 105; i++) cacheSet('test:bulk:' + i, i)
assert(cacheGet('test:k1') === undefined, '超上限后最旧条目被逐出（k1 已丢）')
assert(cacheGet('test:bulk:104') === 104, '新条目仍在')

// --- 限流 ---
console.log('[throttle]')
const t0 = Date.now()
await throttle('entrez_search') // 第一次：不等待
const firstCost = Date.now() - t0
assert(firstCost < 50, `首次调用不等待（耗时 ${firstCost}ms）`)

const t1 = Date.now()
await throttle('entrez_search') // 第二次：应等待至间隔 ≥350ms
const secondCost = Date.now() - t1
assert(secondCost >= 340 && secondCost < 800, `二次调用被限流（耗时 ${secondCost}ms，期望 ~350ms）`)

const t2 = Date.now()
await throttle('entrez_fetch') // 不同 op：独立计时，不等待
const thirdCost = Date.now() - t2
assert(thirdCost < 50, `不同 op 独立限流（耗时 ${thirdCost}ms）`)

const t3 = Date.now()
await throttle('seq_analyze') // 未配置限流的 op：直接放行
assert(Date.now() - t3 < 50, '未配置限流的 op 直接放行')

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
