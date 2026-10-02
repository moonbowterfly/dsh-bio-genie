import assert from 'node:assert/strict'
import http from 'node:http'
import { GEM_TOOLS, GRAFT_TOOLS, detectDomain, domainById } from '../src/domain-adapter.js'
import { liveMetabolicValue, handleEditing } from '../src/server.js'
import { capabilitiesPayload, gemFixtureNames, graftFixtureNames } from './fixtures/hosted-capabilities.mjs'

let failures = 0
async function test(name, run) {
  try {
    await run()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`✗ ${name}`)
    console.error(error.stack ?? error)
  }
}

// detectDomain reads each plugin's package.json; fixture versions follow the checked-out packages.
const gem = detectDomain(domainById('gem'))
const graft = detectDomain(domainById('graft'))
assert.ok(gem.installed && graft.installed, 'sibling domain package.json files are required')
const ready = { state: 'ready', checks: [] }
const health = { protocolMajor: 1, protocolMinors: [0] }

function gemValue(payload) {
  return liveMetabolicValue(gem, ready, health, { features: ['capabilities'] }, payload)
}

await test('gem accepts the real snake_case payload', () => {
  const payload = capabilitiesPayload('dsh-bio-gem', gem.version, gemFixtureNames)
  const value = gemValue(payload)
  assert.deepEqual(value.tools, gemFixtureNames)
  assert.equal(value.capabilities.contractVersion, payload.contract_version)
})

await test('gem rejects a foreign plugin_id and falls back to its static manifest', () => {
  const payload = capabilitiesPayload('another-plugin', gem.version, gemFixtureNames)
  const value = gemValue(payload)
  assert.deepEqual(value.tools, GEM_TOOLS)
  assert.equal(value.capabilities, undefined)
})

await test('gem rejects an incompatible contract_version and falls back', () => {
  const payload = capabilitiesPayload('dsh-bio-gem', gem.version, gemFixtureNames)
  payload.contract_version = '2'
  const value = gemValue(payload)
  assert.deepEqual(value.tools, GEM_TOOLS)
  assert.equal(value.capabilities, undefined)
})

await test('gem rejects missing identity or version and inconsistent tools', () => {
  const malformed = [
    (payload) => { delete payload.plugin_id },
    (payload) => { delete payload.contract_version },
    (payload) => { payload.tool_count += 1 },
    (payload) => { payload.tools[1].name = payload.tools[0].name },
  ]
  for (const breakPayload of malformed) {
    const payload = capabilitiesPayload('dsh-bio-gem', gem.version, gemFixtureNames)
    breakPayload(payload)
    const value = gemValue(payload)
    assert.deepEqual(value.tools, GEM_TOOLS)
    assert.equal(value.capabilities, undefined)
  }
})

function integrationOk(value) { return JSON.stringify({ ok: true, value }) }

async function withMockGraft(capabilities, run, { advertise = true } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/dsh-bio-graft/integration/health') {
      return res.end(integrationOk({ pluginVersion: graft.version, protocolMajor: 1, protocolMinors: [0] }))
    }
    if (req.url === '/api/dsh-bio-graft/integration/v1/status') {
      return res.end(integrationOk({
        state: 'ready', pluginVersion: graft.version,
        features: advertise ? ['status', 'capabilities'] : ['status'],
        checks: domainById('graft').requiredCheckIds.map((id) => ({ id, status: 'ok' })),
      }))
    }
    if (req.url === '/api/dsh-bio-graft/integration/v1/capabilities') {
      return res.end(integrationOk(capabilities))
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = { code: null, body: null,
      writeHead(code) { this.code = code }, end(body) { this.body = body } }
    await handleEditing({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${server.address().port}` } }, response)
    assert.equal(response.code, 200)
    await run(JSON.parse(response.body).value, requests)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

await test('graft fetches and adopts its advertised capabilities', async () => {
  const payload = capabilitiesPayload('dsh-bio-graft', graft.version, graftFixtureNames)
  await withMockGraft(payload, async (value, requests) => {
    assert.ok(requests.includes('/api/dsh-bio-graft/integration/v1/capabilities'))
    assert.deepEqual(value.tools, graftFixtureNames)
    assert.equal(value.capabilities.toolCount, payload.tool_count)
  })
})

await test('graft rejects a foreign plugin_id and falls back', async () => {
  const payload = capabilitiesPayload('another-plugin', graft.version, graftFixtureNames)
  await withMockGraft(payload, async (value) => {
    assert.deepEqual(value.tools, GRAFT_TOOLS)
    assert.equal(value.capabilities, undefined)
  })
})

await test('graft rejects an incompatible contract_version and falls back', async () => {
  const payload = capabilitiesPayload('dsh-bio-graft', graft.version, graftFixtureNames)
  payload.contract_version = '2'
  await withMockGraft(payload, async (value) => {
    assert.deepEqual(value.tools, GRAFT_TOOLS)
    assert.equal(value.capabilities, undefined)
  })
})

await test('graft without the feature flag keeps its static manifest and skips the request', async () => {
  const payload = capabilitiesPayload('dsh-bio-graft', graft.version, graftFixtureNames)
  await withMockGraft(payload, async (value, requests) => {
    assert.deepEqual(value.tools, GRAFT_TOOLS)
    assert.equal(value.capabilities, undefined)
    assert.ok(!requests.includes('/api/dsh-bio-graft/integration/v1/capabilities'))
  }, { advertise: false })
})

if (failures) process.exitCode = 1
else console.log('hosted-capabilities: all passed')
