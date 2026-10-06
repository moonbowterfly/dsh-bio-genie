/**
 * R2-2 生产版 fig-viewer：refs 解析 / Turn 数据 / provider / 卡片 / tab。
 * Factory/adapter 作用域（无真实 DOM）；使用真实 R2-1 bundle 与真实会话样本。
 */
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const fixture = JSON.parse(readFileSync(new URL('./fixtures/fig-viewer-result-samples.json', import.meta.url), 'utf8'))
const bundleDir = new URL('./fixtures/fig-viewer-bundle/', import.meta.url)
const bundle = {
  'recipe.figview.json': readFileSync(new URL('recipe.figview.json', bundleDir)),
  'recipe.rows.json': readFileSync(new URL('recipe.rows.json', bundleDir)),
  'recipe.hits.json': readFileSync(new URL('recipe.hits.json', bundleDir)),
}
const SESSION = 'session-refs-test'
const MANIFEST = 'C:/virtual/work/recipe.figview.json'
const ADDRESS = 'dsh-resource://bio-figure/session/' + encodeURIComponent(SESSION) + '/' + encodeURIComponent(MANIFEST)

let count = 0
async function check(name, body) { await body(); count++; console.log(`PASS ${name}`) }

function load(href) {
  let plugin
  vm.runInNewContext(source, {
    URL, atob, TextDecoder, console, crypto: webcrypto,
    window: { location: { href }, __ModuleLoader__: { load({ id, factory }) {
      assert.equal(id, '@dsh-bio/dsh-bio-genie')
      plugin = factory(name => {
        assert.equal(name, 'react')
        return { createElement: (type, props, ...children) => ({ type, props, children }) }
      })
    } } },
  })
  return plugin
}

/** fake workspaceFiles.readBytes：按文件 basename 映射到 fixtures bundle。 */
function makeContext(opts = {}) {
  const entries = [], tabs = [], providers = [], opened = [], definitions = [], openedFiles = []
  const readCalls = []
  const remote = {
    workspaceFiles: {
      async readBytes(sessionId, path, options, signal) {
        readCalls.push({ sessionId, path, options })
        const name = String(path).split('/').pop()
        const data = opts.override?.[name] ?? bundle[name]
        if (!data) throw Object.assign(new Error('ENOENT ' + path), { code: 'workspace-file/not-found' })
        return { data: new Uint8Array(data), eof: true }
      },
    },
  }
  const ctx = {
    slots: { inject: (_n, register) => register(), register: (entry, component) => { entries.push({ entry, component }) } },
    uiConversation: { events: { register: def => { definitions.push(def) } } },
    sidebarRight: { openResource: url => opened.push(url) },
    sidebarRightTabs: { register: value => tabs.push(value) },
    resources: { register: value => providers.push(value) },
    remote: opts.noRemote ? {} : remote,
  }
  return { ctx, entries, tabs, providers, opened, definitions, openedFiles, readCalls }
}

async function framesOf(provider, address, signal) {
  const out = []
  for await (const frame of provider.open(address, { signal: signal || new AbortController().signal })) out.push(frame)
  return out
}

// ── 安装与降级 ──────────────────────────────────────────────────────────
const plugin = load('http://localhost/')
const world = makeContext()
plugin.apply(world.ctx)
await check('production viewer installs: definition + provider + tab + two slots (+ settings section)', () => {
  assert.deepEqual(world.definitions.map(d => d.kind), ['bio-figures'])
  assert.equal(world.providers.length, 1)
  assert.equal(world.providers[0].protocol, 'bio-figure')
  assert.equal(world.tabs.length, 1)
  assert.equal(world.tabs[0].id, 'bio-figure-viewer')
  assert.deepEqual(world.entries.map(({ entry }) => entry.name).sort(),
    ['conversation.chat.turnTail', 'settings.section', 'sidebar.right.pane.tab'])
})

await check('missing remote service degrades silently (no throw, no viewer registrations)', () => {
  const bare = makeContext({ noRemote: true })
  plugin.apply(bare.ctx)
  assert.equal(bare.definitions.length + bare.providers.length + bare.tabs.length, 0)
  assert.deepEqual(bare.entries.map(({ entry }) => entry.name), ['settings.section'])
})

// ── refs 解析（经 definition 全链路）─────────────────────────────────────
const def = world.definitions[0]
const samples = fixture.samples
const evt = s => JSON.parse(JSON.stringify(s))

await check('match routes turn/start and only figure-bearing results', () => {
  const routed = def.match({ type: 'turn/start', data: { turn: 2 } })
  assert.equal(routed.id, '2')
  assert.equal(routed.role, 'start')
  assert.equal(def.match(evt(samples.plain_text)), null)
  assert.equal(def.match(evt(samples.error_result)), null)
  const side = def.match(evt(samples.sidecar_tool_constructed))
  assert.equal(side.role, 'update')
  assert.equal(side.id, String(samples.sidecar_tool_constructed.data.turn))
  const img = def.match(evt(samples.image_block))
  assert.equal(img.role, 'update')
  assert.equal(img.id, String(samples.image_block.data.turn))
  assert.equal(def.match(evt(samples.sidecar_tool)).role, 'update')
})

await check('update accumulates sidecar + preview refs with dedupe and stable keys', () => {
  let state = def.start({}, { event: { data: { turn: 1 } } })
  state = def.update({ state }, { event: evt(samples.sidecar_tool_constructed), seq: 12 })
  assert.equal(state.figures.length, 1)
  assert.equal(state.figures[0].kind, 'sidecar')
  assert.ok(state.figures[0].manifest.endsWith('pUC19.figview.json'))
  assert.equal(state.figures[0].figureId, 'pUC19')
  const same = def.update({ state }, { event: evt(samples.sidecar_tool_constructed), seq: 13 })
  assert.equal(same, state) // 幂等：同 manifest 不再追加
  state = def.update({ state }, { event: evt(samples.sidecar_tool), seq: 76 })
  assert.equal(state.figures.length, 2) // 真实 out_file 样本 → preview 型
  assert.equal(state.figures[1].kind, 'preview')
  assert.ok(state.figures[1].imagePath.endsWith('pUC19_map.png'))
  state = def.update({ state }, { event: evt(samples.image_block), seq: 83 })
  assert.equal(state.figures.length, 2) // 同路径图片内容块 → dedupe
})

await check('buildLocationData publishes one stable Turn value (idempotent on repeat)', () => {
  const state = { turn: 1, figures: [{ kind: 'preview', imagePath: 'C:/x/a.png', manifest: null, figureId: null, name: null, seq: 1 }] }
  const data = def.buildLocationData({ state }, 'turn', null)
  assert.equal(data.kind, 'turn')
  assert.equal(data.turn, 1)
  assert.equal(data.key, 'bio-figures')
  assert.equal(data.value.figures.length, 1)
  assert.equal(def.buildLocationData({ state }, 'step', null), null)
  assert.equal(def.buildLocationData({ state }, 'turn', data), data)
})

// ── provider（真实 R2-1 bundle 全链路）──────────────────────────────────
await check('provider reads manifest/rows/hits through workspaceFiles and verifies sha256', async () => {
  const frames = await framesOf(world.providers[0], ADDRESS)
  assert.equal(frames.length, 1)
  const v = frames[0].value
  assert.ok(frames[0].ok)
  assert.equal(v.manifest.figure_id, 'recipe')
  assert.equal(v.manifest.schema_version, 1)
  assert.equal(v.rows.rows.length, 9)
  assert.equal(v.hits.elements.length, 9)
  assert.equal(v.hits.units, 'image-pixels')
  // 读取调用：manifest → rows(baseFile=manifest) → hits(baseFile=manifest)
  assert.deepEqual(world.readCalls.map(c => c.path.split('/').pop()),
    ['recipe.figview.json', 'recipe.rows.json', 'recipe.hits.json'])
  assert.equal(world.readCalls[1].options.baseFile, MANIFEST)
})

await check('tampered rows bytes fail closed with sha256 mismatch', async () => {
  const tampered = Buffer.from(bundle['recipe.rows.json'])
  tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x30 ? 0x31 : 0x30
  const w = makeContext({ override: { 'recipe.rows.json': new Uint8Array(tampered) } })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS)
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /sha256 校验失败/)
})

await check('manifest missing required fields fails closed', async () => {
  const w = makeContext({ override: { 'recipe.figview.json': new TextEncoder().encode('{"schema_version":1}') } })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS)
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /缺少必需字段/)
})

await check('unsupported address and pre-aborted signal produce the right outcomes', async () => {
  const bad = await framesOf(world.providers[0], 'dsh-resource://bio-figure/absolute/whatever')
  assert.equal(bad[0].error.code, 'figview/unsupported-address')
  const none = await framesOf(world.providers[0], ADDRESS, AbortSignal.abort())
  assert.equal(none.length, 0)
})

// ── tab 类型 ────────────────────────────────────────────────────────────
await check('tab claims only well-formed bio-figure session addresses; title derives from stem', () => {
  const tab = world.tabs[0]
  assert.ok(tab.canOpen(ADDRESS))
  assert.ok(!tab.canOpen('dsh-resource://file/session/s1/plot.png'))
  assert.ok(!tab.canOpen('dsh-resource://bio-figure/absolute/x'))
  assert.equal(tab.title(ADDRESS), 'recipe')
})

// ── turnTail 卡片 ───────────────────────────────────────────────────────
await check('figure card renders rows and opens sidecar via encoded address / preview via openFile', () => {
  const tail = world.entries.find(({ entry }) => entry.name === 'conversation.chat.turnTail')
  const figures = { figures: [
    { kind: 'sidecar', manifest: 'C:/w/a.figview.json', imagePath: null, figureId: 'a', name: 'Panel A', seq: 5 },
    { kind: 'preview', imagePath: 'C:/w/b.png', manifest: null, figureId: null, name: null, seq: 6 },
  ] }
  const files = []
  const props = { sessionId: SESSION, seq: 9, turn: { data: { get: k => (k === 'bio-figures' ? figures : undefined) } }, openFile: p => files.push(p) }
  const card = tail.component(props)
  assert.equal(card.props['data-figview'], 'turn-card')
  const list = card.children.find(Array.isArray)
  assert.equal(list.length, 2)
  const buttons = list.map(r => (r.children || []).find(c => c && c.type === 'button'))
  assert.ok(buttons[0] && buttons[1])
  buttons[0].props.onClick()
  assert.equal(world.opened.length, 1)
  const m = /^dsh-resource:\/\/bio-figure\/session\/([^/]+)\/(.+)$/.exec(world.opened[0])
  assert.equal(decodeURIComponent(m[1]), SESSION)
  assert.equal(decodeURIComponent(m[2]), 'C:/w/a.figview.json')
  buttons[1].props.onClick()
  assert.deepEqual(files, ['C:/w/b.png'])
  assert.equal(tail.component({ sessionId: SESSION, turn: { data: { get: () => undefined } } }), null)
})

// ── pane.tab 查看器 ─────────────────────────────────────────────────────
await check('viewer tab renders summary + preview payload and handles error frame', async () => {
  const body = world.entries.find(({ entry }) => entry.name === 'sidebar.right.pane.tab')
  const frames = await framesOf(world.providers[0], ADDRESS)
  const ok = body.component({ useTabInfo: () => ({ tab: { contentId: ADDRESS } }), useResource: () => ({ status: 'live', value: frames[0].value }) })
  assert.equal(ok.props['data-figview'], 'pane-v1')
  const err = body.component({ useTabInfo: () => ({ tab: { contentId: ADDRESS } }), useResource: () => ({ status: 'error', error: { code: 'x', message: 'boom' } }) })
  assert.equal(err.props['data-figview'], 'pane-error')
})

console.log(`fig-viewer-refs: ${count}/${count} passed (factory/adapter scope; real fixture bundle; no real DOM)`)
