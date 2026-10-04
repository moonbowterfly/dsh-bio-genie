/**
 * BioGenie domain overview. This is a read-only consumer of the existing
 * hosted-domain health/status protocol; it never treats a package probe as a
 * successful integration probe.
 */
import { readFileSync } from 'node:fs'
import {
  DOMAINS, detectDomain, classifyDomainState, fetchDomainIntegration,
} from './domain-adapter.js'

const HOST_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const API_PREFIX = '/api/dsh-bio-genie'

// These destinations are existing panel endpoints. The client opens their
// existing tabs; the overview never creates or mutates domain assets.
const ASSETS = {
  genie: [
    { label: 'Skill 模块', tab: 'skills', endpoint: `${API_PREFIX}/skills` },
    { label: 'Python 环境', tab: 'python', endpoint: `${API_PREFIX}/python-packages` },
  ],
  gem: [
    { label: '模型', tab: 'metabolic', endpoint: `${API_PREFIX}/metabolic`, countPath: ['models', 'count'] },
    { label: '账本', tab: 'metabolic', endpoint: `${API_PREFIX}/metabolic`, countPath: ['ledger', 'count'] },
    { label: '导出', tab: 'metabolic', endpoint: `${API_PREFIX}/metabolic`, countPath: ['exports', 'count'] },
  ],
  graft: [
    { label: '编辑计划', tab: 'editing', endpoint: `${API_PREFIX}/editing`, countPath: ['plans', 'count'] },
  ],
  galatea: [
    { label: '模型目录', tab: 'protein', endpoint: `${API_PREFIX}/galatea-models` },
    { label: '输出', tab: 'protein', endpoint: `${API_PREFIX}/protein`, countPath: ['outputs', 'count'] },
  ],
}

function assetEntries(id, status) {
  return (ASSETS[id] ?? []).map(({ countPath, ...entry }) => {
    const count = countPath?.reduce((value, key) => value?.[key], status?.data)
    return Number.isSafeInteger(count) && count >= 0 ? { ...entry, count } : entry
  })
}

function insufficient(reason) {
  return {
    coverage: 'insufficient',
    counts: { available: null, probing: null, missing: null },
    operations: [],
    reason,
  }
}

/**
 * Only gem_build has two explicit engine choices whose separate readiness can
 * be backed by status.checks AND status.env.engines.*.available. The optional
 * /v1/capabilities report is tool-level and incorrectly conflates these two
 * engines, so it is deliberately not used for this count.
 *
 * Every number below is a count of these known invocation variants only. No
 * claim is made about the other tools, which lack a complete operation map.
 */
export function summarizeAvailability(domainId, status) {
  if (domainId !== 'gem') {
    return insufficient('当前协议未提供完整的 tool + action/engine 依赖映射；粒度不足，不能统计全域可用能力。')
  }
  if (!status || !Array.isArray(status.checks)) {
    return insufficient('运行时状态未取得；tool + engine 能力计数不可得。')
  }
  const checks = new Map(status.checks.map((check) => [check.id, check.status]))
  const engines = status.env?.engines ?? {}
  const operations = ['carveme', 'gapseq'].map((engine) => {
    const python = checks.get('python.cobra')
    const runtime = checks.get(`runtime.${engine}`)
    const engineValue = engines[engine]?.available
    const probing = engine === 'gapseq' && engineValue === null && engines.gapseq?.probing === true
    const missingDependencies = []
    if (python === 'missing') missingDependencies.push('python.cobra')
    if (runtime === 'missing' && engineValue === false) missingDependencies.push(`runtime.${engine}`)

    let state = 'unknown'
    if (missingDependencies.length) state = 'missing'
    else if (python === 'ok' && runtime === 'ok' && engineValue === true) state = 'available'
    else if (python === 'ok' && runtime === 'warn' && probing) state = 'probing'
    return {
      tool: 'gem_build',
      selector: { engine },
      state,
      ...(missingDependencies.length ? { missingDependencies } : {}),
    }
  })
  const counts = { available: 0, probing: 0, missing: 0 }
  for (const operation of operations) {
    if (operation.state in counts) counts[operation.state] += 1
  }
  return {
    coverage: 'partial',
    counts,
    operations,
    reason: '仅统计 gem_build 的已核实 engine 操作；其他工具与 action 的映射粒度不足，三项数字不是全域总数。',
  }
}

function hostCard() {
  return {
    id: 'genie', label: 'BioGenie 宿主', packageName: '@dsh-bio/dsh-bio-genie',
    installed: true, version: HOST_VERSION, state: 'host',
    health: { state: 'self', detail: '当前面板由宿主提供；宿主没有独立的 integration health 端点。' },
    availability: insufficient('宿主没有完整的 tool + action/engine 运行时状态；粒度不足。'),
    assets: assetEntries('genie'), remediations: [],
  }
}

/** Probe one domain without allowing a failure to hide other domain cards. */
export async function collectDomainCard(domain, req, {
  detect = detectDomain, fetchIntegration = fetchDomainIntegration,
} = {}) {
  const probe = detect(domain)
  const base = {
    id: domain.id, label: domain.label, packageName: domain.packageName,
    installed: !!probe.installed, version: probe.version ?? null,
    assets: assetEntries(domain.id), remediations: [],
  }
  let classification = classifyDomainState(domain, { probe })
  if (classification.state === 'not-installed' || classification.state === 'legacy') {
    return {
      ...base, state: classification.state,
      health: { state: 'not-requested', detail: probe.installed ? '旧版插件无集成协议。' : '插件未安装，未请求 integration。' },
      availability: insufficient(probe.installed ? '旧版插件无操作级状态；粒度不足。' : '插件未安装，能力计数不可得。'),
    }
  }

  let health
  try {
    health = await fetchIntegration(req, `${domain.integrationPrefix}/health`, 3_000)
  } catch (error) {
    return {
      ...base, state: 'installed-unavailable',
      health: { state: 'unreachable', detail: error?.message ?? String(error) },
      availability: insufficient('integration health 无法读取，能力计数不可得。'),
    }
  }
  classification = classifyDomainState(domain, { probe, health })
  if (health.pluginId !== domain.siblingDirName) {
    return {
      ...base, state: 'installed-unavailable',
      health: { state: 'identity-mismatch', pluginId: health.pluginId ?? null,
        expectedPluginId: domain.siblingDirName },
      availability: insufficient('integration 身份不匹配，能力计数不可得。'),
    }
  }
  if (classification.state === 'incompatible') {
    return {
      ...base, state: classification.state,
      health: { state: 'incompatible', protocolMajor: health.protocolMajor,
        expectedProtocolMajor: domain.protocolMajor },
      availability: insufficient('integration 协议版本不兼容，能力计数不可得。'),
    }
  }

  let status
  try {
    status = await fetchIntegration(req, `${domain.integrationPrefix}/v1/status`, 12_000)
  } catch (error) {
    return {
      ...base, state: 'installed-unavailable',
      health: { state: 'reachable', protocolMajor: health.protocolMajor },
      statusError: error?.message ?? String(error),
      availability: insufficient('health 可达但 status 无法读取，能力计数不可得。'),
    }
  }
  classification = classifyDomainState(domain, { probe, health, status })
  const usableStatus = classification.state === 'ready' || classification.state === 'degraded'
  return {
    ...base, state: classification.state,
    version: status?.pluginVersion ?? health?.pluginVersion ?? base.version,
    health: { state: 'reachable', protocolMajor: health.protocolMajor },
    availability: usableStatus
      ? summarizeAvailability(domain.id, status)
      : insufficient('status 结构不符合集成协议，能力计数不可得。'),
    assets: assetEntries(domain.id, usableStatus ? status : undefined),
    remediations: usableStatus && Array.isArray(status.remediations) ? status.remediations : [],
  }
}

/** Data source for GET /api/dsh-bio-genie/domain-overview. */
export async function collectDomainOverview(req, options = {}) {
  const domains = options.domains ?? DOMAINS
  // ⚠️ 逐域兜底（2026-10-02 修 Codex 二阶审查 P2）：原用裸 Promise.all，
  // 任一域的 detect/integration 抛出未预期异常就会让**整个端点** 500，
  // 用户连其他域的卡片都看不到。改为逐卡 catch，异常域给出明确降级卡片。
  const domainCards = await Promise.all(domains.map(async (domain) => {
    try {
      return await collectDomainCard(domain, req, options)
    } catch (err) {
      return {
        id: domain.id,
        label: domain.label,
        packageName: domain.packageName,
        installed: false,
        version: null,
        state: 'probe-failed',
        health: { state: 'unreachable', detail: `探测异常：${err?.message || String(err)}` },
        availability: {
          coverage: 'insufficient',
          counts: { available: null, probing: null, missing: null },
          operations: [],
          reason: '域探测抛出异常，能力计数不可得。',
        },
        assets: [],
        remediations: [],
      }
    }
  }))
  return { domains: [hostCard(), ...domainCards] }
}
