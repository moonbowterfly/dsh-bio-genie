/** Render the browser bundle with a minimal React shim to exercise the new tab. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const hooks = []
let hookIndex = 0
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children } }
  },
  useState(initial) {
    const index = hookIndex++
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], (value) => {
      hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
    }]
  },
}

const requests = []
const responses = {
  '/metabolic?probe=install': { ok: true, value: { installed: false } },
  '/editing?probe=install': { ok: true, value: { installed: false } },
  '/protein?probe=install': { ok: true, value: { installed: false } },
  '/domain-overview': {
    ok: true,
    value: {
      domains: [
        {
          id: 'genie', label: 'BioGenie 宿主', packageName: '@dsh-bio/dsh-bio-genie',
          installed: true, state: 'host', health: { state: 'self' },
          availability: { coverage: 'insufficient', counts: { available: null, probing: null, missing: null },
            reason: '粒度不足', operations: [] },
          assets: [],
        },
        {
          id: 'gem', label: '代谢建模', packageName: '@dsh-bio/dsh-bio-gem',
          installed: false, state: 'not-installed', health: { state: 'not-requested' },
          availability: { coverage: 'insufficient', counts: { available: null, probing: null, missing: null },
            reason: '插件未安装，能力计数不可得。', operations: [] },
          assets: [{ label: '模型', tab: 'metabolic', endpoint: '/api/dsh-bio-genie/metabolic' }],
        },
      ],
    },
  },
}
const fetch = (url) => {
  const path = url.replace('/api/dsh-bio-genie', '')
  requests.push(path)
  assert.ok(path in responses, `unexpected UI request: ${url}`)
  return Promise.resolve({ status: 200, json: () => Promise.resolve(responses[path]) })
}

let plugin
const window = { __ModuleLoader__: { load({ factory }) {
  plugin = factory((name) => {
    assert.equal(name, 'react')
    return React
  })
} } }
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window, fetch })
let section
plugin.apply({ slots: {
  inject(_name, register) { register() },
  register(_entry, component) { section = component },
} })
assert.equal(typeof section, 'function')

function expand(node) {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || node === undefined || node === false) return []
  if (typeof node !== 'object') return [node]
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return [{ ...node, children: expand(node.props.children) }]
}
function render() {
  hookIndex = 0
  return expand(section())
}
function flatten(nodes) {
  return nodes.flatMap((node) => node && typeof node === 'object'
    ? [node, ...flatten(node.children ?? [])] : [node])
}
function label(node) {
  return flatten(node.children ?? []).filter((value) => typeof value !== 'object').join('')
}

let elements = flatten(render())
const domainsTab = elements.find((node) => node?.type === 'button' && node.props.role === 'tab'
  && label(node) === '域总览')
assert.ok(domainsTab, 'domain overview tab is always visible')
assert.ok(!elements.some((node) => node?.type === 'button' && node.props.role === 'tab'
  && label(node) === '代谢建模'), 'uninstalled gem detail tab stays hidden')

domainsTab.props.onClick()
await new Promise((resolve) => setImmediate(resolve))
elements = flatten(render())
const text = elements.filter((value) => typeof value !== 'object').join(' ')
assert.match(text, /域插件未安装；integration 未探测；能力计数不可得/)
assert.match(text, /不可得 · 粒度不足/)
const modelAsset = elements.find((node) => node?.type === 'button' && label(node) === '模型')
assert.ok(modelAsset?.props.disabled, 'uninstalled gem asset navigation is disabled')
assert.equal(requests.filter((path) => path === '/domain-overview').length, 1)
assert.ok(!requests.some((path) => /\/integration\//.test(path)))
console.log('domain-overview-ui: uninstalled gem card and fixed tab passed')
