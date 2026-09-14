/**
 * Hosted-domain adapter tests — dsh-bio-graft（基因编辑域）.
 *
 * Run: node scripts/test-graft-adapter.mjs
 *
 * 与 test-gem-adapter.mjs 同构：六态判定必须与契约 §3 表格逐条对应，
 * 且「缺必检项」不得判 ready（宿主面板会谎报可用）。
 */
import assert from 'node:assert/strict'

const adapter = await import('../src/domain-adapter.js')

let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`✗ ${name}`)
    console.error(error.stack || error.message)
  }
}

const graft = adapter.domainById('graft')

test('registry declares both hosted domains with distinct route keys and tool prefixes', () => {
  assert.deepEqual(adapter.DOMAINS.map((d) => d.id).sort(), ['gem', 'graft'])
  assert.equal(adapter.domainByRouteKey('editing').id, 'graft')
  assert.equal(adapter.domainByRouteKey('metabolic').id, 'gem')
  assert.equal(graft.integrationPrefix, '/api/dsh-bio-graft/integration')
  assert.deepEqual(graft.requiredCheckIds, ['python.interpreter', 'runtime.casoffinder', 'plans.dir'])
  assert.equal(graft.minIntegrationVersion, '0.1.1')
  assert.equal(graft.tools.every((t) => t.startsWith('graft_')), true)
})

test('classifies an absent graft package as not-installed', () => {
  assert.deepEqual(adapter.classifyDomainState(graft, {
    probe: { installed: false, detectedBy: 'none' },
  }), {
    state: 'not-installed',
    installed: false,
  })
})

test('classifies a package below the protocol introduction version as legacy', () => {
  assert.deepEqual(adapter.classifyDomainState(graft, {
    probe: { installed: true, version: '0.1.0' },
  }), {
    state: 'legacy',
    installed: true,
    version: '0.1.0',
    minimumVersion: '0.1.1',
  })
})

test('classifies a modern installed package with a failed health request as installed-unavailable', () => {
  assert.deepEqual(adapter.classifyDomainState(graft, {
    probe: { installed: true, version: '0.1.1' },
  }), {
    state: 'installed-unavailable',
    installed: true,
    version: '0.1.1',
  })
})

test('classifies a reachable but incompatible protocol major explicitly', () => {
  assert.deepEqual(adapter.classifyDomainState(graft, {
    probe: { installed: true, version: '0.1.1' },
    health: { protocolMajor: 2, protocolMinors: [0] },
  }), {
    state: 'incompatible',
    installed: true,
    version: '0.1.1',
    protocolMajor: 2,
    expectedProtocolMajor: 1,
  })
})

test('classifies a compatible protocol with all checks ok as ready', () => {
  const checks = [
    { id: 'python.interpreter', status: 'ok' },
    { id: 'runtime.casoffinder', status: 'ok' },
    { id: 'plans.dir', status: 'ok' },
  ]
  assert.deepEqual(adapter.classifyDomainState(graft, {
    probe: { installed: true, version: '0.1.1' },
    health: { protocolMajor: 1 },
    status: { state: 'ready', checks },
  }), {
    state: 'ready',
    installed: true,
    version: '0.1.1',
    checks,
  })
})

test('classifies a missing off-target backend as degraded (not ready)', () => {
  const checks = [
    { id: 'python.interpreter', status: 'ok' },
    { id: 'runtime.casoffinder', status: 'missing' },
    { id: 'plans.dir', status: 'ok' },
  ]
  assert.deepEqual(adapter.classifyDomainState(graft, {
    probe: { installed: true, version: '0.1.1' },
    health: { protocolMajor: 1 },
    status: { state: 'degraded', checks },
  }), {
    state: 'degraded',
    installed: true,
    version: '0.1.1',
    checks,
  })
})

test('a status missing a required check id is not accepted as ready', () => {
  const checks = [
    { id: 'python.interpreter', status: 'ok' },
    { id: 'plans.dir', status: 'ok' },
  ]
  assert.deepEqual(adapter.classifyDomainState(graft, {
    probe: { installed: true, version: '0.1.1' },
    health: { protocolMajor: 1 },
    status: { state: 'ready', checks },
  }), {
    state: 'installed-unavailable',
    installed: true,
    version: '0.1.1',
  })
})

test('treats a status/checks contradiction as installed-unavailable', () => {
  const checks = [
    { id: 'python.interpreter', status: 'ok' },
    { id: 'runtime.casoffinder', status: 'missing' },
    { id: 'plans.dir', status: 'ok' },
  ]
  assert.deepEqual(adapter.classifyDomainState(graft, {
    probe: { installed: true, version: '0.1.1' },
    health: { protocolMajor: 1 },
    status: { state: 'ready', checks },
  }), {
    state: 'installed-unavailable',
    installed: true,
    version: '0.1.1',
  })
})

test('rejects an unknown status value', () => {
  assert.deepEqual(adapter.classifyDomainState(graft, {
    probe: { installed: true, version: '0.1.1' },
    health: { protocolMajor: 1 },
    status: { state: 'weird', checks: [] },
  }), {
    state: 'installed-unavailable',
    installed: true,
    version: '0.1.1',
  })
})

test('gem keeps its previously published semantics (no drift across the refactor)', () => {
  const gem = adapter.domainById('gem')
  assert.equal(gem.minIntegrationVersion, '0.1.11')
  assert.deepEqual(adapter.classifyDomainState(gem, {
    probe: { installed: true, version: '0.1.2' },
  }), {
    state: 'legacy',
    installed: true,
    version: '0.1.2',
    minimumVersion: '0.1.11',
  })
})

if (failed > 0) {
  console.error(`\ntest-graft-adapter: ${failed} failed`)
  process.exitCode = 1
} else {
  console.log('\ntest-graft-adapter: all passed')
}
