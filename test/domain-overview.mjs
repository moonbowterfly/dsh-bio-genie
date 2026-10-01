/** Read-only domain overview aggregation and partial operation-count contract. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DOMAINS, domainById } from '../src/domain-adapter.js'
import { collectDomainOverview, summarizeAvailability } from '../src/domain-overview.js'

const req = { headers: { host: '127.0.0.1:3080' }, url: '/api/dsh-bio-genie/domain-overview' }

function statusFor(domain, overrides = {}) {
  const checks = domain.requiredCheckIds.map((id) => ({ id, status: 'ok' }))
  return {
    state: 'ready',
    pluginVersion: '0.1.99',
    checks,
    env: domain.id === 'gem'
      ? { engines: { carveme: { available: true }, gapseq: { available: true } } }
      : {},
    data: {},
    remediations: [],
    ...overrides,
  }
}

function checkStatus(domain, changes, overrides = {}) {
  const checks = domain.requiredCheckIds.map((id) => ({ id, status: changes[id] ?? 'ok' }))
  return statusFor(domain, {
    state: checks.some((check) => check.status !== 'ok') ? 'degraded' : 'ready',
    checks,
    ...overrides,
  })
}

function integrations({ onFetch } = {}) {
  const requests = []
  const fetchIntegration = async (_req, endpoint, timeoutMs) => {
    requests.push({ endpoint, timeoutMs })
    if (onFetch) return onFetch(endpoint)
    const domain = DOMAINS.find((candidate) => endpoint.startsWith(candidate.integrationPrefix + '/'))
    assert.ok(domain, `unexpected integration endpoint: ${endpoint}`)
    if (endpoint.endsWith('/health')) {
      return { protocolMajor: domain.protocolMajor, pluginVersion: '0.1.99' }
    }
    assert.ok(endpoint.endsWith('/v1/status'), `unexpected extra endpoint: ${endpoint}`)
    return statusFor(domain)
  }
  return { requests, fetchIntegration }
}

test('overview has the host and three domains, using existing asset endpoints', async () => {
  const broker = integrations()
  const result = await collectDomainOverview(req, {
    detect: () => ({ installed: true, version: '0.1.99', detectedBy: 'test' }),
    fetchIntegration: broker.fetchIntegration,
  })
  assert.deepEqual(result.domains.map((card) => card.id), ['genie', ...DOMAINS.map((d) => d.id)])
  const [host, gem, graft, galatea] = result.domains
  assert.equal(host.installed, true)
  assert.equal(host.health.state, 'self')
  assert.equal(host.availability.coverage, 'insufficient')
  assert.deepEqual([gem.state, graft.state, galatea.state], ['ready', 'ready', 'ready'])
  assert.deepEqual([gem.health.state, graft.health.state, galatea.health.state],
    ['reachable', 'reachable', 'reachable'])
  assert.equal(broker.requests.length, DOMAINS.length * 2)
  assert.ok(broker.requests.every(({ endpoint }) => /\/(?:health|v1\/status)$/.test(endpoint)))

  assert.ok(gem.assets.some((asset) => asset.label === '模型' && asset.tab === 'metabolic'
    && asset.endpoint === '/api/dsh-bio-genie/metabolic'))
  assert.ok(gem.assets.some((asset) => asset.label === '账本' && asset.endpoint === '/api/dsh-bio-genie/metabolic'))
  assert.ok(graft.assets.some((asset) => asset.tab === 'editing'
    && asset.endpoint === '/api/dsh-bio-genie/editing'))
  assert.ok(galatea.assets.some((asset) => asset.label === '模型目录' && asset.tab === 'protein'
    && asset.endpoint === '/api/dsh-bio-genie/galatea-models'))
  assert.equal(graft.availability.coverage, 'insufficient')
  assert.equal(galatea.availability.counts.available, null)
})

test('gem_build engines are counted as two operations, never one whole-tool status', () => {
  const gem = domainById('gem')
  const status = checkStatus(gem, { 'runtime.carveme': 'missing' }, {
    env: { engines: { carveme: { available: false }, gapseq: { available: true } } },
  })
  const availability = summarizeAvailability('gem', status)
  assert.equal(availability.coverage, 'partial')
  assert.deepEqual(availability.counts, { available: 1, probing: 0, missing: 1 })
  assert.deepEqual(availability.operations.map(({ tool, selector, state }) =>
    [tool, selector.engine, state]), [
    ['gem_build', 'carveme', 'missing'],
    ['gem_build', 'gapseq', 'available'],
  ])
  assert.match(availability.reason, /不是全域总数/)
})

test('explicit gapseq probe is probing; absent or ambiguous engine state is unknown', () => {
  const gem = domainById('gem')
  const status = checkStatus(gem, { 'runtime.gapseq': 'warn' }, {
    env: { engines: { carveme: { available: true }, gapseq: { available: null, probing: true } } },
  })
  const probing = summarizeAvailability('gem', status)
  assert.deepEqual(probing.counts, { available: 1, probing: 1, missing: 0 })
  assert.equal(probing.operations[1].state, 'probing')

  const absentField = summarizeAvailability('gem', checkStatus(gem, {}, {
    env: { engines: { carveme: { available: true }, gapseq: {} } },
  }))
  assert.deepEqual(absentField.counts, { available: 1, probing: 0, missing: 0 })
  assert.equal(absentField.operations[1].state, 'unknown')

  const ambiguousWarn = summarizeAvailability('gem', checkStatus(gem,
    { 'runtime.gapseq': 'warn' }, {
      env: { engines: { carveme: { available: true }, gapseq: { available: null } } },
    }))
  assert.equal(ambiguousWarn.operations[1].state, 'unknown')
})

test('uninstalled gem remains visible with no integration requests', async () => {
  const broker = integrations()
  const result = await collectDomainOverview(req, {
    domains: [domainById('gem')],
    detect: () => ({ installed: false, detectedBy: 'none' }),
    fetchIntegration: broker.fetchIntegration,
  })
  const gem = result.domains[1]
  assert.equal(gem.installed, false)
  assert.equal(gem.state, 'not-installed')
  assert.equal(gem.health.state, 'not-requested')
  assert.equal(gem.availability.coverage, 'insufficient')
  assert.deepEqual(gem.availability.counts, { available: null, probing: null, missing: null })
  assert.match(gem.availability.reason, /插件未安装/)
  assert.deepEqual(broker.requests, [])
})

test('health and status failures are isolated without losing installation evidence', async () => {
  const requests = []
  const result = await collectDomainOverview(req, {
    detect: () => ({ installed: true, version: '0.1.99' }),
    fetchIntegration: async (_req, endpoint) => {
      requests.push(endpoint)
      if (endpoint.includes('dsh-bio-gem') && endpoint.endsWith('/health')) {
        throw new Error('health timeout')
      }
      if (endpoint.includes('dsh-bio-graft') && endpoint.endsWith('/v1/status')) {
        throw new Error('status timeout')
      }
      const domain = DOMAINS.find((candidate) => endpoint.startsWith(candidate.integrationPrefix + '/'))
      return endpoint.endsWith('/health')
        ? { protocolMajor: domain.protocolMajor }
        : statusFor(domain)
    },
  })
  const gem = result.domains.find((card) => card.id === 'gem')
  const graft = result.domains.find((card) => card.id === 'graft')
  const galatea = result.domains.find((card) => card.id === 'galatea')
  assert.deepEqual([gem.installed, graft.installed, galatea.installed], [true, true, true])
  assert.deepEqual([gem.state, graft.state, galatea.state],
    ['installed-unavailable', 'installed-unavailable', 'ready'])
  assert.equal(gem.health.state, 'unreachable')
  assert.equal(graft.health.state, 'reachable')
  assert.match(graft.statusError, /status timeout/)
  assert.equal(gem.availability.counts.available, null)
  assert.equal(graft.availability.coverage, 'insufficient')
  assert.ok(!requests.some((endpoint) => endpoint.includes('dsh-bio-gem')
    && endpoint.endsWith('/v1/status')), 'failed health must not trigger status request')
})
