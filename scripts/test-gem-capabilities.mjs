/**
 * Hosted-gem capabilities consumption tests.
 *
 * 验证 handleDomainRequest 的「能力单源」消费路径（gem ≥0.1.13）：
 *   ① status.features 声明 'capabilities' 时 → 拉取 /v1/capabilities 并透传给 shapeLive；
 *   ② capabilities 拉取失败 → 静默降级（capabilities=undefined，不影响主展示）；
 *   ③ 旧版 gem（features 无 capabilities）→ 不发起 capabilities 请求（向后兼容）。
 *
 * 用本地 mock integration server + 固定已安装探测值，单仓检出也可运行。
 * Run: node scripts/test-gem-capabilities.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'

const adapter = await import('../src/domain-adapter.js')

let failed = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`✗ ${name}`)
    console.error(error.stack || error.message)
  }
}

const GEM_TOOLS_COUNT = 23

function integrationOk(value) {
  return JSON.stringify({ ok: true, value })
}

/** 起一个 mock gem integration server；requestLog 记录收到的路径。 */
function startMockGem({ withCapabilities = true, capabilitiesBroken = false,
  pluginId = 'dsh-bio-gem' } = {}) {
  const requestLog = []
  const server = http.createServer((req, res) => {
    requestLog.push(req.url)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/dsh-bio-gem/integration/health') {
      return res.end(integrationOk({
        pluginId,
        pluginVersion: '0.1.13',
        protocolMajor: 1,
        protocolMinors: [0],
        features: withCapabilities
          ? ['status', 'capabilities', 'model-store', 'ledger', 'exports']
          : ['status', 'model-store', 'ledger', 'exports'],
      }))
    }
    if (req.url === '/api/dsh-bio-gem/integration/v1/status') {
      return res.end(integrationOk({
        state: 'ready',
        generatedAt: '2026-09-21T00:00:00.000Z',
        pluginVersion: '0.1.13',
        features: withCapabilities ? ['status', 'capabilities'] : ['status'],
        checks: [
          { id: 'python.cobra', status: 'ok', detail: 'cobra 0.32.1' },
          { id: 'runtime.carveme', status: 'ok', detail: 'ok' },
          { id: 'runtime.gapseq', status: 'ok', detail: 'ok' },
        ],
        data: {},
        env: {},
        remediations: [],
      }))
    }
    if (req.url === '/api/dsh-bio-gem/integration/v1/capabilities') {
      if (capabilitiesBroken) {
        res.statusCode = 500
        return res.end(JSON.stringify({ ok: false, code: 'internal', message: 'boom' }))
      }
      const tools = Array.from({ length: 25 }, (_, i) => ({
        name: i < 21 ? `gem_tool_${i}` : `gem_new_${i}`,
        capability: `gem.some.${i}`,
        category: 'analysis',
        cost_class: 'medium',
        network: 'none',
        mutability: 'read_only',
        status: 'ready',
        summary: `tool ${i}`,
      }))
      return res.end(integrationOk({
        contract_version: '1',
        plugin_id: 'dsh-bio-gem',
        plugin_version: '0.1.13',
        tool_count: tools.length,
        tools,
      }))
    }
    res.statusCode = 404
    res.end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requestLog, port: server.address().port })
    })
  })
}

function makeReq(url, port) {
  return { url, headers: { host: `127.0.0.1:${port}` }, method: 'GET' }
}

function makeRes() {
  const state = { statusCode: null, body: null }
  return {
    state,
    writeHead(code) { state.statusCode = code },
    end(body) { state.body = body },
  }
}

const silentLog = { warn() {}, error() {}, log() {} }

async function callDomain(mock, { shapeLive } = {}) {
  const res = makeRes()
  let captured = null
  await adapter.handleDomainRequest(
    adapter.domainById('gem'),
    makeReq('/', mock.port),
    res,
    {
      log: silentLog,
      detect: () => ({ installed: true, version: '0.1.13', detectedBy: 'test' }),
      shapeLegacy: (probe) => ({ legacy: true, version: probe.version }),
      shapeLive: (...args) => { captured = args; return shapeLive ? shapeLive(...args) : { args } },
    },
  )
  return { res, captured, payload: JSON.parse(res.state.body) }
}

const withCaps = await startMockGem({ withCapabilities: true })
const brokerCaps = await startMockGem({ withCapabilities: true, capabilitiesBroken: true })
const oldGem = await startMockGem({ withCapabilities: false })
const foreignGem = await startMockGem({ pluginId: 'dsh-bio-graft' })

try {
  await test('passes capabilities through to shapeLive when gem advertises the feature', async () => {
    const { captured, payload } = await callDomain(withCaps)
    const [, classification, , , capabilities] = captured
    assert.equal(classification.state, 'ready')
    assert.ok(capabilities, 'capabilities should be fetched')
    assert.equal(capabilities.tool_count, 25)
    assert.equal(capabilities.tools.length, 25)
    assert.equal(payload.value.args[4].tools[24].name, 'gem_new_24')
    assert.ok(withCaps.requestLog.includes('/api/dsh-bio-gem/integration/v1/capabilities'))
  })

  await test('degrades silently (capabilities=undefined) when the capabilities fetch fails', async () => {
    const { captured } = await callDomain(brokerCaps)
    const [, classification, , status, capabilities] = captured
    assert.equal(classification.state, 'ready')
    assert.ok(status, 'status must still be delivered')
    assert.equal(capabilities, undefined)
    assert.ok(brokerCaps.requestLog.includes('/api/dsh-bio-gem/integration/v1/capabilities'))
  })

  await test('does not request capabilities from a legacy gem without the feature flag', async () => {
    const { captured } = await callDomain(oldGem)
    const [, classification, , , capabilities] = captured
    assert.equal(classification.state, 'ready')
    assert.equal(capabilities, undefined)
    assert.ok(!oldGem.requestLog.includes('/api/dsh-bio-gem/integration/v1/capabilities'),
      'capabilities endpoint must not be requested when the feature is not advertised')
  })

  await test('static tool manifest remains the documented fallback size', async () => {
    assert.equal(adapter.GEM_TOOLS.length, GEM_TOOLS_COUNT)
  })

  await test('foreign health identity stops before status and capabilities', async () => {
    const { captured } = await callDomain(foreignGem)
    assert.equal(captured[1].state, 'installed-unavailable')
    assert.equal(captured[2], undefined, 'foreign health must not affect displayed version')
    assert.deepEqual(foreignGem.requestLog, ['/api/dsh-bio-gem/integration/health'])
  })
} finally {
  withCaps.server.close()
  brokerCaps.server.close()
  oldGem.server.close()
  foreignGem.server.close()
}

if (failed > 0) {
  console.error(`\ntest-gem-capabilities: ${failed} failed`)
  process.exitCode = 1
} else {
  console.log('\ntest-gem-capabilities: all passed')
}
