/**
 * op 层限流 + 缓存（状态常驻 dsh 服务器进程）。
 *
 * 每次语义化工具调用都是全新 Python 子进程（callBio → spawn → exit），
 * Python 侧的内存状态无法跨调用存活，因此限流/缓存状态必须放 TS 层
 * （dsh 服务器进程常驻，模块级变量跨调用有效）。限流在 spawn 前等待，
 * 连进程启动开销都省掉。
 *
 * @module dsh-bio-genie/throttle
 */

/** 各 op 的最小调用间隔（NCBI 合规 3 req/s ≈ 350ms；Enrichr/Ensembl 礼貌节流）。 */
const RATE_LIMIT_MS = {
  entrez_search: 350,
  entrez_fetch: 350,
  pubmed_search: 350,
  pubmed_abstract: 350,
  enrichr: 600,
  ref_genome: 200,
}
/** 缓存 TTL（查询类 op 结果 24h 内视为新鲜）。 */
const CACHE_TTL_MS = 24 * 3600_000
/** 缓存条目上限（超出逐出最旧）。 */
const CACHE_MAX = 100

/** op → 上次调用时间戳（限流）。 */
const rateState = new Map()
/** `${op}:${JSON.stringify(args)}` → { ts, value }（缓存）。 */
const cacheMap = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 查缓存。命中（未过期）返回缓存值，否则返回 undefined。
 * @param {string} key 缓存键
 */
export function cacheGet(key) {
  const hit = cacheMap.get(key)
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.value
  return undefined
}

/**
 * 写入缓存，超出上限逐出最旧条目。
 * @param {string} key 缓存键
 * @param {*} value 缓存值
 */
export function cacheSet(key, value) {
  cacheMap.set(key, { ts: Date.now(), value })
  if (cacheMap.size > CACHE_MAX) cacheMap.delete(cacheMap.keys().next().value)
}

/**
 * 限流等待：若距上次调用不足最小间隔，则等待剩余时间。
 * @param {string} op 操作名（RATE_LIMIT_MS 中定义的才生效）
 */
export async function throttle(op) {
  const minInterval = RATE_LIMIT_MS[op]
  if (!minInterval) return
  const last = rateState.get(op) ?? 0
  const wait = last + minInterval - Date.now()
  if (wait > 0) await sleep(wait)
  rateState.set(op, Date.now())
}
