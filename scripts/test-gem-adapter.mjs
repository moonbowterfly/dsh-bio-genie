/**
 * Hosted-gem adapter unit tests.
 *
 * Run: node scripts/test-gem-adapter.mjs
 */
import assert from 'node:assert/strict'

const adapter = await import('../src/server.js')

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

test('classifies an absent gem package as not-installed without a network result', () => {
  assert.equal(typeof adapter.classifyGemState, 'function')
  assert.deepEqual(adapter.classifyGemState({
    probe: { installed: false, detectedBy: 'none' },
  }), {
    state: 'not-installed',
    installed: false,
  })
})

test('classifies a package below the protocol introduction version as legacy', () => {
  assert.deepEqual(adapter.classifyGemState({
    probe: { installed: true, version: '0.1.2' },
  }), {
    state: 'legacy',
    installed: true,
    version: '0.1.2',
    minimumVersion: '0.1.11',
  })
})

test('classifies a modern installed package with a failed health request as installed-unavailable', () => {
  assert.deepEqual(adapter.classifyGemState({
    probe: { installed: true, version: '0.1.11' },
    error: new Error('health request timed out'),
  }), {
    state: 'installed-unavailable',
    installed: true,
    version: '0.1.11',
  })
})

test('classifies a reachable but incompatible protocol major explicitly', () => {
  assert.deepEqual(adapter.classifyGemState({
    probe: { installed: true, version: '0.1.11' },
    health: { protocolMajor: 2, protocolMinors: [0] },
  }), {
    state: 'incompatible',
    installed: true,
    version: '0.1.11',
    protocolMajor: 2,
    expectedProtocolMajor: 1,
  })
})

test('classifies a compatible protocol with a non-ok check as degraded', () => {
  const checks = [
    { id: 'python.cobra', status: 'ok' },
    { id: 'runtime.carveme', status: 'missing' },
    { id: 'runtime.gapseq', status: 'ok' },
  ]
  assert.deepEqual(adapter.classifyGemState({
    probe: { installed: true, version: '0.1.11' },
    health: { protocolMajor: 1 },
    status: { state: 'degraded', checks },
  }), {
    state: 'degraded',
    installed: true,
    version: '0.1.11',
    checks,
  })
})

test('classifies a compatible protocol with all checks ok as ready', () => {
  const checks = [
    { id: 'python.cobra', status: 'ok' },
    { id: 'runtime.carveme', status: 'ok' },
    { id: 'runtime.gapseq', status: 'ok' },
  ]
  assert.deepEqual(adapter.classifyGemState({
    probe: { installed: true, version: '0.1.11' },
    health: { protocolMajor: 1 },
    status: { state: 'ready', checks },
  }), {
    state: 'ready',
    installed: true,
    version: '0.1.11',
    checks,
  })
})

test('treats a malformed status snapshot as installed-unavailable instead of ready', () => {
  assert.deepEqual(adapter.classifyGemState({
    probe: { installed: true, version: '0.1.11' },
    health: { protocolMajor: 1 },
    status: { state: 'ready', checks: [] },
  }), {
    state: 'installed-unavailable',
    installed: true,
    version: '0.1.11',
  })
})

test('treats a status/checks contradiction as installed-unavailable', () => {
  assert.deepEqual(adapter.classifyGemState({
    probe: { installed: true, version: '0.1.11' },
    health: { protocolMajor: 1 },
    status: {
      state: 'ready',
      checks: [
        { id: 'python.cobra', status: 'ok' },
        { id: 'runtime.carveme', status: 'missing' },
        { id: 'runtime.gapseq', status: 'ok' },
      ],
    },
  }), {
    state: 'installed-unavailable',
    installed: true,
    version: '0.1.11',
  })
})

if (failed) process.exitCode = 1
