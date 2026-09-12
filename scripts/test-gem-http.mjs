/**
 * node:http transport tests for the hosted GEM adapter.
 *
 * Run: node scripts/test-gem-http.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'

const adapter = await import('../src/server.js')

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

async function withServer(handler, fn) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    const fail = (error) => { server.off('error', fail); reject(error) }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail)
      resolve()
    })
  })
  try {
    const address = server.address()
    return await fn({ headers: { host: `127.0.0.1:${address.port}` } })
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

await test('node:http transport accepts a valid integration envelope', async () => {
  assert.equal(typeof adapter.fetchGemIntegration, 'function')
  await withServer((req, res) => {
    assert.equal(req.headers.accept, 'application/json')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, value: { protocolMajor: 1 } }))
  }, async (request) => {
    assert.deepEqual(await adapter.fetchGemIntegration(request, '/integration/health', 500), { protocolMajor: 1 })
  })
})

await test('node:http transport rejects a non-2xx integration response', async () => {
  await withServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'offline' }))
  }, async (request) => {
    await assert.rejects(() => adapter.fetchGemIntegration(request, '/integration/health', 500), /HTTP 503/)
  })
})

await test('node:http transport rejects malformed JSON', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{invalid json')
  }, async (request) => {
    await assert.rejects(() => adapter.fetchGemIntegration(request, '/integration/health', 500), /invalid JSON/)
  })
})

await test('node:http transport rejects a response that exceeds its bounded body size', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(`{"ok":true,"value":{"payload":"${'x'.repeat(1_000_001)}"}}`)
  }, async (request) => {
    await assert.rejects(() => adapter.fetchGemIntegration(request, '/integration/health', 500), /too large/)
  })
})

await test('node:http transport rejects a server that does not respond before timeout', async () => {
  await withServer(() => {
    // Deliberately leave the socket open until the client-side timeout destroys it.
  }, async (request) => {
    await assert.rejects(() => adapter.fetchGemIntegration(request, '/integration/health', 75), /request timeout/)
  })
})

if (failed) process.exitCode = 1
