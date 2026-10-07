/** Factory/adapter regression. Real host/browser acceptance is recorded separately. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
let count = 0
const check = (name, body) => { body(); count++; console.log(`PASS ${name}`) }
const address = 'dsh-resource://bio-figure/session/figview-r2-hello/hello'
function load(href) {
  let plugin
  vm.runInNewContext(source, { URL, window: {
    location: { href }, __ModuleLoader__: { load({ id, factory }) {
      assert.equal(id, manifest.name)
      plugin = factory(name => {
        assert.equal(name, 'react')
        return { createElement: (type, props, ...children) => ({ type, props, children }) }
      })
    } }
  } })
  return plugin
}
function context() {
  const entries = [], tabs = [], providers = [], opened = []
  const ctx = {
    slots: { inject: (_name, register) => register(), register: (entry, component) => { entries.push({entry, component}) } },
    uiConversation: {}, sidebarRight: { openResource: url => opened.push(url) },
    sidebarRightTabs: { register: value => tabs.push(value) },
    resources: { register: value => providers.push(value) },
  }
  return { ctx, entries, tabs, providers, opened }
}
const ordinary = context()
load('http://localhost/').apply(ordinary.ctx)
check('ordinary URL only contributes the existing settings section', () => {
  assert.deepEqual(ordinary.entries.map(({entry}) => entry.name), ['settings.section'])
  assert.equal(ordinary.tabs.length + ordinary.providers.length, 0)
})
const plugin = load('http://localhost/?figviewHello=1')
const probe = context()
plugin.apply(probe.ctx)
check('manifest uses the tested renderer dependency and removes legacy runtime', () => {
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer'))
  assert.ok(!manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-runtime'))
})
check('adapter rejects a missing or incompatible service before registering', () => {
  const broken = context(); broken.ctx.sidebarRight = {}
  assert.throws(() => plugin.apply(broken.ctx), /0\.2\.0 services: sidebarRight/)
  assert.equal(broken.entries.length + broken.tabs.length + broken.providers.length, 0)
})
const tail = probe.entries.find(({entry}) => entry.name === 'conversation.chat.turnTail')
const body = probe.entries.find(({entry}) => entry.name === 'sidebar.right.pane.tab' && entry.key === 'bio-figure-viewer')
const tab = probe.tabs.find(x => x.id === 'bio-figure-viewer')
check('sidebar body is selected by definition id, independently of kind', () => {
  assert.equal(body.entry.key, tab.id)
  assert.notEqual(tab.id, tab.kind)
})
check('claim accepts the explicit fixture and refuses ordinary files and future data', () => {
  assert.ok(tab.canOpen(address))
  assert.ok(!tab.canOpen('dsh-resource://file/session/s1/plot.png'))
  assert.ok(!tab.canOpen('dsh-resource://bio-figure/session/s1/real-figure'))
})
check('hello card stays in its test session', () => {
  assert.equal(tail.component({sessionId:'ordinary-session',turn:1}), null)
  assert.equal(tail.component({sessionId:'figview-r2-hello',turn:1}).props['data-turn'], 1)
})
check('card click requests the protocol address through the host sidebar action', () => {
  const card = tail.component({sessionId:'figview-r2-hello',turn:1})
  card.children.find(child => child.type === 'button').props.onClick()
  assert.deepEqual(probe.opened, [address])
})
const frames = []
for await (const frame of probe.providers[0].open(address, {signal:new AbortController().signal})) frames.push(frame)
check('provider publishes one explicitly marked fixture with three stable rows', () => {
  assert.equal(frames.length, 1)
  assert.ok(frames[0].ok && frames[0].value.fixture)
  assert.deepEqual(Array.from(frames[0].value.rows, row => row.row_id), ['r1','r2','r3'])
})
const failures = []
for await (const frame of probe.providers[0].open(address+'/other', {signal:new AbortController().signal})) failures.push(frame)
check('provider fails closed for an unsupported address', () => {
  assert.equal(failures[0].ok, false)
  assert.equal(failures[0].error.code, 'figview/hello-only')
})
const cancelled = []
for await (const frame of probe.providers[0].open(address, {signal:AbortSignal.abort()})) cancelled.push(frame)
check('already aborted resource open publishes no frame', () => assert.equal(cancelled.length, 0))
check('Figure body reads the selected tab address through useResource', () => {
  const seen = []
  const rendered = body.component({useTabInfo:()=>({tab:{contentId:address}}),useResource:url=>{seen.push(url);return {status:'live',value:frames[0].value}}})
  assert.deepEqual(seen, [address])
  assert.equal(rendered.props['data-figview-hello'], 'figure-tab')
  assert.equal(rendered.children.find(child=>child.type==='pre').props['data-figview-frame'], 'live')
})
console.log(`fig-viewer-hello: ${count}/${count} passed (factory/adapter scope; no real DOM)`)
