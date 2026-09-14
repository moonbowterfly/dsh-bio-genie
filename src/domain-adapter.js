/**
 * domain-adapter.js — 宿主侧「托管领域扩展」的**声明式域注册表**。
 *
 * 为什么现在提炼：契约 §0/§12 明写「第二个领域扩展出现后提炼通用机制」。
 * gem（代谢建模域，2026-08-31 接入）是第一个，graft（基因编辑域）是第二个。
 * 提炼范围**严格限定在机械重复部分**：包探测 → 六态判定 → 只读信封拉取 → 条件分页分发。
 * 不引入通用 UI 渲染框架、不引入 capabilities 自动拼装（契约 §0 不做清单；YAGNI）。
 *
 * 纪律：gem 的对外行为必须逐字节不变 —— 由既有 scripts/test-gem-adapter.mjs 与
 * scripts/test-gem-http.mjs（两者都零修改）作回归硬门；server.js 保留同名兼容导出。
 *
 * 三条跨插件事实（实测）：
 *   ① dsh 无父子插件机制：本文件只做「探测 + 只读消费」，不 import 对方代码；
 *   ② 端点用 node:http 直连（不用全局 fetch：dsh 进程内可能装全局代理 dispatcher，
 *      实测同一端点在服务端内层 fetch 下挂起 102s vs node:http 62ms）；
 *   ③ 探测点放装配期/路由里，**绝不放 prompt 文本**（否则域插件没装时 agent 会照着
 *      静态路由去调不存在的工具）。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** dsh-bio-gem 对外暴露的 21 个语义化工具（面板只做展示）。 */
export const GEM_TOOLS = [
  'gem_build', 'gem_report', 'gem_validate', 'gem_gapfind', 'gem_gapfill', 'gem_gapseq',
  'gem_phenotype', 'gem_essentiality', 'gem_annotate', 'gem_media_resolve', 'gem_l3_fix',
  'gem_biomass', 'gem_fluxscan', 'gem_sensitivity', 'gem_ledger', 'gem_benchmark',
  'gem_secretion', 'gem_double_knockout', 'gem_enrichment', 'gem_targets', 'gem_precursor_scan',
]

/** dsh-bio-graft 对外暴露的 7 个语义化工具。 */
export const GRAFT_TOOLS = [
  'graft_profiles', 'graft_design', 'graft_score', 'graft_offtarget',
  'graft_backend_status', 'graft_plan_save', 'graft_plan_load',
]

/**
 * 域注册表。每个域一条声明；新增域 = 加一条（不用碰分发/判定/拉取逻辑）。
 *   packageName          用于 require.resolve 探测（正确处理 pnpm 符号链接与 hoisting）
 *   siblingDirName       同级目录回退名（模块解析失败时的兜底）
 *   integrationPrefix    只读集成协议前缀（health / v1/status 挂其下）
 *   minIntegrationVersion 首个实现集成协议的版本（低于它判 legacy）
 *   protocolMajor        兼容判据（不猜版本字符串行为）
 *   requiredCheckIds     status.checks 必须齐备的 id（缺一即判 installed-unavailable）
 *   routeKey             宿主面板分页 key 与端点名（/api/dsh-bio-genie/<routeKey>）
 *   dataRootName         该域的运行时数据根目录名（~/.dsh/<dataRootName>）
 */
export const DOMAINS = [
  {
    id: 'gem',
    packageName: '@dsh-bio/dsh-bio-gem',
    siblingDirName: 'dsh-bio-gem',
    integrationPrefix: '/api/dsh-bio-gem/integration',
    minIntegrationVersion: '0.1.11',
    protocolMajor: 1,
    requiredCheckIds: ['python.cobra', 'runtime.carveme', 'runtime.gapseq'],
    routeKey: 'metabolic',
    label: '代谢建模',
    dataRootName: 'dsh-bio-gem',
    tools: GEM_TOOLS,
    unavailableMessage: '已安装，但当前不可用。请重新探测或确认 gem 的 integration API 已随同一实例启动。',
  },
  {
    id: 'graft',
    packageName: '@dsh-bio/dsh-bio-graft',
    siblingDirName: 'dsh-bio-graft',
    integrationPrefix: '/api/dsh-bio-graft/integration',
    minIntegrationVersion: '0.1.1',
    protocolMajor: 1,
    requiredCheckIds: ['python.interpreter', 'runtime.casoffinder', 'plans.dir'],
    routeKey: 'editing',
    label: '基因编辑设计',
    dataRootName: 'dsh-bio-graft',
    tools: GRAFT_TOOLS,
    unavailableMessage: '已安装，但当前不可用。请重新探测或确认 graft 的 integration API 已随同一实例启动。',
  },
]

export function domainById(id) {
  const domain = DOMAINS.find((d) => d.id === id)
  if (!domain) throw new Error(`unknown hosted domain: ${id}`)
  return domain
}

export function domainByRouteKey(routeKey) {
  const domain = DOMAINS.find((d) => d.routeKey === routeKey)
  if (!domain) throw new Error(`unknown hosted domain route key: ${routeKey}`)
  return domain
}

/**
 * 探测域插件是否与本插件共存。
 * 先用模块解析（能正确处理 pnpm 符号链接与 hoisting），失败再退回同级目录猜测。
 */
export function detectDomain(domain) {
  const require = createRequire(import.meta.url)
  const readPkg = (p) => JSON.parse(readFileSync(p, 'utf8'))
  try {
    const pkgPath = require.resolve(`${domain.packageName}/package.json`)
    const pkg = readPkg(pkgPath)
    return { installed: true, version: pkg.version, pluginDir: dirname(pkgPath), detectedBy: 'module-resolve' }
  } catch { /* 继续尝试同级目录 */ }
  try {
    const sibling = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
      domain.siblingDirName, 'package.json')
    const pkg = readPkg(sibling)
    return { installed: true, version: pkg.version, pluginDir: dirname(sibling), detectedBy: 'sibling-path' }
  } catch {
    return { installed: false, detectedBy: 'none' }
  }
}

export function isVersionBelow(version, minimum) {
  const parse = (input) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(input ?? '')
    return match ? match.slice(1, 4).map(Number) : null
  }
  const current = parse(version)
  const target = parse(minimum)
  if (!current || !target) return false
  for (let index = 0; index < target.length; index += 1) {
    if (current[index] !== target[index]) return current[index] < target[index]
  }
  return false
}

const CHECK_STATUSES = new Set(['ok', 'warn', 'missing', 'error'])

function hasValidDomainStatus(domain, status) {
  if (!status || !['ready', 'degraded'].includes(status.state) || !Array.isArray(status.checks)) return false
  if (!status.checks.every((check) => typeof check?.id === 'string' && CHECK_STATUSES.has(check.status))) return false
  if (!domain.requiredCheckIds.every((id) => status.checks.some((check) => check.id === id))) return false
  const hasNonOkCheck = status.checks.some((check) => check.status !== 'ok')
  return status.state === (hasNonOkCheck ? 'degraded' : 'ready')
}

/**
 * 六态判定（gem 原 classifyGemState 逐字迁移；判定顺序即优先级）：
 *   not-installed → legacy → incompatible → ready/degraded → installed-unavailable
 */
export function classifyDomainState(domain, { probe, health, status } = {}) {
  if (!probe?.installed) return { state: 'not-installed', installed: false }
  if (isVersionBelow(probe.version, domain.minIntegrationVersion)) {
    return {
      state: 'legacy',
      installed: true,
      version: probe.version,
      minimumVersion: domain.minIntegrationVersion,
    }
  }
  if (health?.protocolMajor !== undefined && health.protocolMajor !== domain.protocolMajor) {
    return {
      state: 'incompatible',
      installed: true,
      version: probe.version,
      protocolMajor: health.protocolMajor,
      expectedProtocolMajor: domain.protocolMajor,
    }
  }
  if (health?.protocolMajor === domain.protocolMajor && hasValidDomainStatus(domain, status)) {
    if (status.checks.some((check) => check?.status !== 'ok')) {
      return { state: 'degraded', installed: true, version: probe.version, checks: status.checks }
    }
    return { state: 'ready', installed: true, version: probe.version, checks: status.checks }
  }
  return { state: 'installed-unavailable', installed: true, version: probe.version }
}

/**
 * 读取一个固定的 integration 信封（有界等待）。
 *
 * 用 `node:http` 直连而非全局 fetch：dsh 进程内可能安装全局代理 dispatcher
 * （`@deepseek-ai/dsh-http-proxy` 会 `undici.setGlobalDispatcher`），实测同一端点
 * 在**服务端内层 fetch** 下出现过长挂起（浏览器路径实测 102s，而同等 curl/外部
 * node fetch 为 15–25ms）。node:http 不经过 undici，无此变量。
 */
export function fetchDomainIntegration(req, endpoint, timeoutMs) {
  const host = req.headers?.host
  if (typeof host !== 'string') return Promise.reject(new Error('missing host'))
  const target = new URL(endpoint, `http://${host}`)
  const hostname = target.hostname.replace(/^\[|\]$/g, '')
  const port = target.port || '80'
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } }
    const ok = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    let timer
    const request = http.get({
      hostname,
      port,
      path: target.pathname,
      headers: { accept: 'application/json' },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
        if (body.length > 1_000_000) {
          res.destroy()
          fail(new Error('integration response too large'))
        }
      })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return fail(new Error(`integration HTTP ${res.statusCode}`))
        }
        let envelope
        try {
          envelope = JSON.parse(body)
        } catch {
          return fail(new Error('integration returned invalid JSON'))
        }
        if (!envelope || envelope.ok !== true || !envelope.value || typeof envelope.value !== 'object') {
          return fail(new Error('integration returned an invalid envelope'))
        }
        ok(envelope.value)
      })
      res.on('error', fail)
    })
    timer = setTimeout(() => {
      request.destroy()
      fail(new Error('integration request timeout'))
    }, timeoutMs)
    request.on('error', fail)
  })
}

/** 本地安装探测（?probe=install）——让前端延迟到打开分页时才做远程探测。 */
export function isDomainInstallProbe(req) {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams.get('probe') === 'install'
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body, null, 2))
}

/**
 * 域分页数据端点（gem 原 handleMetabolic 的通用化）：
 *   ?probe=install → 只做本地安装探测（快，不触网络）
 *   否则 → 六态判定 + 按需拉取 health/status，交给域自己的 shape* 构造展示载荷
 *
 * ⚠️ 关键纪律（迁移自 gem 的真实教训）：health 成功但 status 未取回时，
 * classify 会判 installed-unavailable —— **不能**在拿到 health 后提前返回，
 * 否则 status 永远不会被请求，degraded/ready 状态不可达。
 */
export async function handleDomainRequest(domain, req, res, { shapeLegacy, shapeLive, log = console } = {}) {
  const probe = detectDomain(domain)
  if (isDomainInstallProbe(req)) {
    const value = probe.installed
      ? { installed: true, version: probe.version, pluginDir: probe.pluginDir, detectedBy: probe.detectedBy }
      : { installed: false }
    return writeJson(res, 200, { ok: true, value })
  }
  let classification = classifyDomainState(domain, { probe })
  if (classification.state === 'not-installed') {
    return writeJson(res, 200, { ok: true, value: { installed: false } })
  }
  if (classification.state === 'legacy') {
    return writeJson(res, 200, { ok: true, value: shapeLegacy(probe) })
  }

  let health
  let status
  try {
    health = await fetchDomainIntegration(req, `${domain.integrationPrefix}/health`, 3_000)
    classification = classifyDomainState(domain, { probe, health })
    if (classification.state === 'incompatible') {
      return writeJson(res, 200, { ok: true, value: shapeLive(probe, classification, health) })
    }
    // status 冷探测可能很慢（gem 的 WSL/gapseq 探测、graft 的计划目录扫描）；双方都有
    // 缓存 + 预热。给足余量，失败只记日志，不拖垮面板。
    status = await fetchDomainIntegration(req, `${domain.integrationPrefix}/v1/status`, 12_000)
  } catch (err) {
    log.warn(`[dsh-bio-genie] ${domain.id} integration probe failed:`,
      err?.message, '| cause:', err?.cause?.message ?? err?.cause ?? 'none')
  }
  classification = classifyDomainState(domain, { probe, health, status })
  return writeJson(res, 200, { ok: true, value: shapeLive(probe, classification, health, status) })
}

/** 域路由注册（loopback-only 由调用方的 guard 负责）。 */
export function domainRouteEntries(handlers) {
  return Object.entries(handlers).map(([routeKey, handler]) => ({
    domain: domainByRouteKey(routeKey),
    handler,
  }))
}
