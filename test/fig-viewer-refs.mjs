/**
 * R2-2 生产版 fig-viewer：refs 解析 / Turn 数据 / provider / 卡片 / tab。
 * Factory/adapter 作用域（无真实 DOM）；使用真实 R2-1 bundle 与真实会话样本。
 * R2-2.1：preview 分支 / 缺 hash 拒绝 / 非法路径 / revision 绑定 / 预算与结构 / fig_export 链。
 * R2-2.2：内容摘要自洽核验 / 发布布局硬校验 / 预算对象修正（hits）/ 读取身份核验 /
 *         row_id 与 hits→rows 引用 / bundle 边界（absolutePath）/ parser 收紧 / fullRefKey。
 */
import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const fixture = JSON.parse(readFileSync(new URL('./fixtures/fig-viewer-result-samples.json', import.meta.url), 'utf8'))
const bundleDir = new URL('./fixtures/fig-viewer-bundle/', import.meta.url)
const bundle = {
  'recipe.figview.json': readFileSync(new URL('recipe.figview.json', bundleDir)),
  'recipe.rows.json': readFileSync(new URL('recipe.rows.json', bundleDir)),
  'recipe.hits.json': readFileSync(new URL('recipe.hits.json', bundleDir)),
  'recipe.png': readFileSync(new URL('recipe.png', bundleDir)),
}
const manifestObj = JSON.parse(bundle['recipe.figview.json'].toString('utf8'))
const REV = manifestObj.revision
const SESSION = 'session-refs-test'
const MANIFEST = 'C:/virtual/work/recipe/' + REV + '/recipe.figview.json'
const ADDRESS = 'dsh-resource://bio-figure/session/' + encodeURIComponent(SESSION) + '/' + encodeURIComponent(MANIFEST)
const NO_REV_MANIFEST = 'C:/virtual/work/recipe.figview.json'
const NO_REV_ADDRESS = 'dsh-resource://bio-figure/session/' + encodeURIComponent(SESSION) + '/' + encodeURIComponent(NO_REV_MANIFEST)
const OTHER_REV = 'f'.repeat(64)
const OTHER_REV_MANIFEST = 'C:/virtual/work/recipe/' + OTHER_REV + '/recipe.figview.json'
const OTHER_REV_ADDRESS = 'dsh-resource://bio-figure/session/' + encodeURIComponent(SESSION) + '/' + encodeURIComponent(OTHER_REV_MANIFEST)
const ANCESTOR_TRAP_MANIFEST = 'C:/virtual/work/' + REV + '/recipe/nothex/recipe.figview.json'
const ANCESTOR_TRAP_ADDRESS = 'dsh-resource://bio-figure/session/' + encodeURIComponent(SESSION) + '/' + encodeURIComponent(ANCESTOR_TRAP_MANIFEST)
const sha256hex = b => createHash('sha256').update(b).digest('hex')
const enc = s => new TextEncoder().encode(s)

/** 自洽 manifest：JS 序列化（保留成员序）→ 去 revision 取摘要 → 回填 revision（追加末尾）。 */
function buildManifestBytes(mutate) {
  const m = JSON.parse(JSON.stringify(manifestObj))
  if (mutate) mutate(m)
  delete m.revision
  const noRev = JSON.stringify(m)
  const rev = sha256hex(Buffer.from(noRev, 'utf8'))
  m.revision = rev
  return enc(JSON.stringify(m))
}
/** 组合 override：替换 bundle 文件字节 → 同步 manifest 的对应 sha → 自洽 revision。 */
function withBundle(files, mutateManifest) {
  const out = { ...bundle }
  for (const [k, v] of Object.entries(files || {})) out[k] = v
  const m = JSON.parse(JSON.stringify(manifestObj))
  if (files && files['recipe.rows.json']) m.data.sha256 = sha256hex(files['recipe.rows.json'])
  if (files && files['recipe.hits.json']) m.hitmap.sha256 = sha256hex(files['recipe.hits.json'])
  if (mutateManifest) mutateManifest(m)
  delete m.revision
  const noRev = JSON.stringify(m)
  m.revision = sha256hex(Buffer.from(noRev, 'utf8'))
  out['recipe.figview.json'] = enc(JSON.stringify(m))
  return out
}
function revOfBytes(b) { return JSON.parse(Buffer.from(b).toString('utf8')).revision }
function addrWithRev(rev) {
  return 'dsh-resource://bio-figure/session/' + encodeURIComponent(SESSION) + '/' +
    encodeURIComponent('C:/virtual/work/recipe/' + rev + '/recipe.figview.json')
}
function tamperManifestText(from, to) {
  const s = bundle['recipe.figview.json'].toString('utf8')
  assert.ok(s.includes(from), 'tamper anchor missing: ' + from)
  return enc(s.replace(from, to))
}

let count = 0
async function check(name, body) { await body(); count++; console.log(`PASS ${name}`) }

const testHooks = { stateCalls: [], effects: [] }

function load(href) {
  testHooks.stateCalls.length = 0
  testHooks.effects.length = 0
  let plugin
  vm.runInNewContext(source, {
    URL, atob, btoa, TextDecoder, TextEncoder, console, crypto: webcrypto,
    window: { location: { href }, __ModuleLoader__: { load({ id, factory }) {
      assert.equal(id, '@dsh-bio/dsh-bio-genie')
      plugin = factory(name => {
        assert.equal(name, 'react')
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          useState: v => {
            const init = typeof v === 'function' ? v() : v
            return [init, x => { testHooks.stateCalls.push(x) }]
          },
          useEffect: (fn, deps) => { testHooks.effects.push({ fn, deps }) },
          useRef: () => ({ current: null }),
          useMemo: f => f(),
          useCallback: f => f,
        }
      })
    } } },
  })
  return plugin
}

/** fake workspaceFiles.readBytes：bundle 映射 + range 切片 + 注入点（rawReturn/override/abort/身份字段）。 */
function makeContext(opts = {}) {
  const entries = [], tabs = [], providers = [], opened = [], definitions = []
  const readCalls = []
  const controller = opts.controller || new AbortController()
  const remote = {
    workspaceFiles: {
      async readBytes(sessionId, path, options, signal) {
        readCalls.push({ sessionId, path, options })
        if (opts.rawReturn) {
          const r = typeof opts.rawReturn === 'function' ? opts.rawReturn(path, options) : opts.rawReturn
          if (r !== undefined) {
            if (opts.abortAfterFirstRead) { try { controller.abort() } catch (e) { /* noop */ } }
            return r
          }
        }
        const name = String(path).split('/').pop()
        const full = (opts.override && opts.override[name] !== undefined) ? opts.override[name] : bundle[name]
        if (full === undefined) throw Object.assign(new Error('ENOENT ' + path), { code: 'workspace-file/not-found' })
        const bytes = Buffer.isBuffer(full) ? full : Buffer.from(full)
        let data = bytes
        let eof = true
        let offset = 0
        if (options && options.range) {
          offset = options.range.offset | 0
          data = bytes.subarray(offset, Math.min(bytes.length, offset + options.range.length))
          eof = offset + data.length >= bytes.length
        }
        if (opts.abortAfterFirstRead) { try { controller.abort() } catch (e) { /* noop */ } }
        const res = { data: new Uint8Array(data), eof, offset, bytes: bytes.length }
        const absBase = 'C:/virtual/work/recipe/' + REV + '/'
        if (!opts.noAbs) res.absolutePath = (opts.absPaths && opts.absPaths[name]) ? opts.absPaths[name] : (absBase + name)
        if (opts.bytesHint) res.bytes = opts.bytesHint
        return res
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
  return { ctx, entries, tabs, providers, opened, definitions, readCalls, controller }
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

// ── refs 解析 ───────────────────────────────────────────────────────────
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

await check('fig_export results[].viewer chain is recognized (P1-6)', () => {
  const event = {
    type: 'tool/result', seq: 50, data: { turn: 4, step: 1, message: { role: 'tool', isError: false,
      source: { kind: 'tool', callId: 'call-export' },
      content: [{ type: 'text', text: JSON.stringify({ count: 1, results: [{
        path: 'C:/w/recipe.png', verdict: 'PASS',
        viewer: { available: true, manifest: 'C:/w/recipe/abc/recipe.figview.json', figure_id: 'recipe', inspect: 'points' },
      }] }) }] } },
  }
  const m = def.match(event)
  assert.equal(m.role, 'update')
  let st = def.start({}, { event: { data: { turn: 4 } } })
  st = def.update({ state: st }, { event, seq: 50 })
  assert.equal(st.figures.length, 1)
  assert.equal(st.figures[0].kind, 'sidecar')
  assert.ok(st.figures[0].manifest.endsWith('recipe.figview.json'))
})

await check('fig_export strictness: non-boolean available is not a sidecar; verdict gates preview', () => {
  const mkEvent = results => ({
    type: 'tool/result', seq: 51, data: { turn: 4, step: 2, message: { role: 'tool', isError: false,
      source: { kind: 'tool', callId: 'call-export-2' },
      content: [{ type: 'text', text: JSON.stringify({ count: results.length, results }) }] } },
  })
  assert.equal(def.match(mkEvent([{ path: 'C:/w/a.png', viewer: { available: 'false', manifest: 'C:/w/a.figview.json' } }])), null)
  assert.equal(def.match(mkEvent([{ path: 'C:/w/random.png' }])), null)
  const previewEvent = mkEvent([{ path: 'C:/w/a.png', verdict: 'PASS' }])
  assert.equal(def.match(previewEvent).role, 'update')
})

await check('update accumulates refs; preview and sidecar with identical path stay distinct; dedupe by kind+path', () => {
  let state = def.start({}, { event: { data: { turn: 1 } } })
  state = def.update({ state }, { event: evt(samples.sidecar_tool_constructed), seq: 12 })
  assert.equal(state.figures.length, 1)
  const same = def.update({ state }, { event: evt(samples.sidecar_tool_constructed), seq: 13 })
  assert.equal(same, state)
  state = def.update({ state }, { event: evt(samples.sidecar_tool), seq: 76 })
  assert.equal(state.figures.length, 2)
  state = def.update({ state }, { event: evt(samples.image_block), seq: 83 })
  assert.equal(state.figures.length, 2)
  // 同 path 不同 kind：不互相吞掉（P2-B）
  const bothKinds = { figures: [
    { kind: 'preview', imagePath: 'C:/w/same', manifest: null, figureId: null, name: null, seq: 1 },
  ] }
  const st2 = def.update({ state: { turn: 9, figures: bothKinds.figures } },
    { event: { type: 'tool/result', seq: 90, data: { turn: 9, step: 1, message: { isError: false,
      content: [{ type: 'text', text: JSON.stringify({ ok: true, result: { viewer_manifest: 'C:/w/same', figure_id: 'x' } }) }],
      source: { kind: 'tool', callId: 'c9' } } } }, seq: 90 })
  assert.equal(st2.figures.length, 2, '同 path 的 preview 与 sidecar 应并存（kind 区分）')
})

await check('buildLocationData publishes one stable Turn value (idempotent on repeat)', () => {
  const state = { turn: 1, figures: [{ kind: 'preview', imagePath: 'C:/x/a.png', manifest: null, figureId: null, name: null, seq: 1 }] }
  const data = def.buildLocationData({ state }, 'turn', null)
  assert.equal(data.kind, 'turn')
  assert.equal(data.key, 'bio-figures')
  assert.equal(def.buildLocationData({ state }, 'step', null), null)
  assert.equal(def.buildLocationData({ state }, 'turn', data), data)
})

// ── provider 主链路 ─────────────────────────────────────────────────────
await check('provider reads manifest/rows/hits, verifies sha256 and content digest (real bundle)', async () => {
  const frames = await framesOf(world.providers[0], ADDRESS)
  assert.equal(frames.length, 1)
  const v = frames[0].value
  assert.ok(frames[0].ok, frames[0].error && frames[0].error.message)
  assert.equal(v.manifest.figure_id, 'recipe')
  assert.equal(v.rows.rows.length, 9)
  assert.equal(v.hits.elements.length, 9)
  assert.ok(v.image && typeof v.image.dataBase64 === 'string' && v.image.dataBase64.indexOf('iVBOR') === 0,
    'PNG 图片应内嵌（base64）')
  assert.deepEqual(world.readCalls.map(c => c.path.split('/').pop()),
    ['recipe.figview.json', 'recipe.rows.json', 'recipe.hits.json', 'recipe.png'])
  assert.ok(world.readCalls[1].options.range, '有界读取应通过 range 段读实现')
})

await check('manifest content digest: byte-level tamper without revision update is rejected', async () => {
  const w = makeContext({ override: { 'recipe.figview.json': tamperManifestText('"figure_id":"recipe"', '"figure_id":"recipf"') } })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS)
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /内容摘要与 revision 不一致/)
})

await check('revision layout: direct parent must be the 64hex revision; ancestors cannot rescue or poison', async () => {
  // 直接父目录非 hex（祖先有 hex）：拒绝，不再被祖先误放行
  const f1 = await framesOf(world.providers[0], ANCESTOR_TRAP_ADDRESS)
  assert.equal(f1[0].ok, false)
  assert.match(f1[0].error.message, /缺少 revision 目录/)
  // 直接父目录是正确 hex：正常（错误 rev 值走另一 case）
  const okFrames = await framesOf(world.providers[0], ADDRESS)
  assert.ok(okFrames[0].ok)
  // 无 revision 目录：拒绝（生产入口不兼容非发布布局）
  const f2 = await framesOf(world.providers[0], NO_REV_ADDRESS)
  assert.equal(f2[0].ok, false)
  assert.match(f2[0].error.message, /缺少 revision 目录/)
})

await check('revision mismatch between path and manifest is rejected', async () => {
  const frames = await framesOf(world.providers[0], OTHER_REV_ADDRESS)
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /revision 与路径不一致/)
})

await check('tampered rows bytes fail closed with sha256 mismatch', async () => {
  const tampered = Buffer.from(bundle['recipe.rows.json'])
  const idx = tampered.length - 2
  tampered[idx] = tampered[idx] === 0x30 ? 0x31 : 0x30
  const w = makeContext({ override: { 'recipe.rows.json': new Uint8Array(tampered) } })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS)
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /sha256 校验失败/)
})

await check('manifest missing fields fails closed', async () => {
  const w = makeContext({ override: { 'recipe.figview.json': enc('{"schema_version":1}') } })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS)
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /缺少字段/)
})

// ── preview / 引用 / 路径 ───────────────────────────────────────────────
await check('preview branch (data/hitmap null, inspect=preview) is accepted (self-consistent manifest)', async () => {
  const ovPv = buildManifestBytes(m => {
    m.capabilities = { inspect: 'preview', reason: 'no-source-table', request_redraw: false }
    m.data = null
    m.hitmap = null
  })
  const w = makeContext({ override: { 'recipe.figview.json': ovPv } })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], addrWithRev(revOfBytes(ovPv)))
  assert.equal(frames.length, 1)
  assert.ok(frames[0].ok, frames[0].error && frames[0].error.message)
  assert.equal(frames[0].value.rows, null)
  assert.equal(frames[0].value.hits, null)
})

await check('points branch with null data/hitmap is rejected; bad capabilities rejected', async () => {
  const ov1 = buildManifestBytes(m => { m.data = null })
  const w = makeContext({ override: { 'recipe.figview.json': ov1 } })
  plugin.apply(w.ctx)
  const f1 = await framesOf(w.providers[0], addrWithRev(revOfBytes(ov1)))
  assert.match(f1[0].error.message, /data 为 null 但 capabilities\.inspect=points/)
  const ov2 = buildManifestBytes(m => { delete m.capabilities })
  const w2 = makeContext({ override: { 'recipe.figview.json': ov2 } })
  plugin.apply(w2.ctx)
  const f2 = await framesOf(w2.providers[0], addrWithRev(revOfBytes(ov2)))
  assert.match(f2[0].error.message, /缺少字段：capabilities/)
  const ov3 = buildManifestBytes(m => { m.capabilities.inspect = 'fancy' })
  const w3 = makeContext({ override: { 'recipe.figview.json': ov3 } })
  plugin.apply(w3.ctx)
  const f3 = await framesOf(w3.providers[0], addrWithRev(revOfBytes(ov3)))
  assert.match(f3[0].error.message, /capabilities\.inspect 非法/)
  const ov4 = buildManifestBytes(m => { m.image = null })
  const w4 = makeContext({ override: { 'recipe.figview.json': ov4 } })
  plugin.apply(w4.ctx)
  const f4 = await framesOf(w4.providers[0], addrWithRev(revOfBytes(ov4)))
  assert.match(f4[0].error.message, /image 不能为 null/)
})

await check('missing sha256 is rejected (fail-closed, not skipped)', async () => {
  const ovS = buildManifestBytes(m => { delete m.data.sha256 })
  const w = makeContext({ override: { 'recipe.figview.json': ovS } })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], addrWithRev(revOfBytes(ovS)))
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /缺少合法 sha256/)
})

await check('unsafe bundle-relative paths are rejected', async () => {
  for (const badPath of ['../recipe.rows.json', 'C:/outside/recipe.rows.json', 'a\\b.json', 'a%2eb.json', '/abs.json']) {
    const ovU = buildManifestBytes(m => { m.data.path = badPath })
    const w = makeContext({ override: { 'recipe.figview.json': ovU } })
    plugin.apply(w.ctx)
    const frames = await framesOf(w.providers[0], addrWithRev(revOfBytes(ovU)))
    assert.equal(frames[0].ok, false, '应拒绝: ' + badPath)
    assert.match(frames[0].error.message, /路径非法/, '应报路径非法: ' + badPath)
  }
})

// ── 预算 / 结构 / 引用完整性 ────────────────────────────────────────────
await check('points budget counts hits (not rows): rows>hits ok; 10001 hits rejected', async () => {
  // rows 10 行 > hits 9：不误拒
  const rowsObj = JSON.parse(bundle['recipe.rows.json'].toString('utf8'))
  const extra = JSON.parse(JSON.stringify(rowsObj.rows[0]))
  extra.row_id = extra.row_id + ':extra'
  rowsObj.rows.push(extra)
  const rowsBytes = Buffer.from(JSON.stringify(rowsObj))
  const ovB1 = withBundle({ 'recipe.rows.json': rowsBytes })
  const w1 = makeContext({ override: ovB1 })
  plugin.apply(w1.ctx)
  const f1 = await framesOf(w1.providers[0], addrWithRev(revOfBytes(ovB1['recipe.figview.json'])))
  assert.ok(f1[0].ok, f1[0].error && f1[0].error.message)
  assert.equal(f1[0].value.rows.rows.length, 10)
  // 10001 hits：拒绝
  const hitsObj = JSON.parse(bundle['recipe.hits.json'].toString('utf8'))
  hitsObj.elements = new Array(10001).fill({})
  const hitsBytes = Buffer.from(JSON.stringify(hitsObj))
  const ovB2 = withBundle({ 'recipe.hits.json': hitsBytes })
  const w2 = makeContext({ override: ovB2 })
  plugin.apply(w2.ctx)
  const f2 = await framesOf(w2.providers[0], addrWithRev(revOfBytes(ovB2['recipe.figview.json'])))
  assert.equal(f2[0].ok, false)
  assert.match(f2[0].error.message, /hits 点数超出预算/)
})

await check('malformed rows rejected; hits row_id references validated', async () => {
  const badRows = Buffer.from(JSON.stringify({ schema_version: 1, columns: [], rows: {} }))
  const ovR = withBundle({ 'recipe.rows.json': badRows })
  const w = makeContext({ override: ovR })
  plugin.apply(w.ctx)
  const f1 = await framesOf(w.providers[0], addrWithRev(revOfBytes(ovR['recipe.figview.json'])))
  assert.match(f1[0].error.message, /rows 结构非法/)
  // hits 引用不存在的 row_id
  const hitsObj = JSON.parse(bundle['recipe.hits.json'].toString('utf8'))
  hitsObj.elements[0] = { ...hitsObj.elements[0], row_ids: ['NOT-IN-ROWS'] }
  const hitsBytes = Buffer.from(JSON.stringify(hitsObj))
  const ovH = withBundle({ 'recipe.hits.json': hitsBytes })
  const w2 = makeContext({ override: ovH })
  plugin.apply(w2.ctx)
  const f2 = await framesOf(w2.providers[0], addrWithRev(revOfBytes(ovH['recipe.figview.json'])))
  assert.equal(f2[0].ok, false)
  assert.match(f2[0].error.message, /hits 引用不存在的 row_id/)
})

// ── 读取身份与完整性 ────────────────────────────────────────────────────
await check('read identity: oversized size hint rejected pre-read; offset mismatch rejected', async () => {
  const raw = new Uint8Array(bundle['recipe.figview.json'])
  const w1 = makeContext({ rawReturn: { ok: true, value: { data: raw, eof: false, offset: 0, bytes: 9 * 1024 * 1024 } } })
  plugin.apply(w1.ctx)
  const f1 = await framesOf(w1.providers[0], ADDRESS)
  assert.equal(f1[0].ok, false)
  assert.match(f1[0].error.message, /超出预算（文件/)
  const w2 = makeContext({ rawReturn: { ok: true, value: { data: raw, eof: true, offset: 999, bytes: raw.length } } })
  plugin.apply(w2.ctx)
  const f2 = await framesOf(w2.providers[0], ADDRESS)
  assert.equal(f2[0].ok, false)
  assert.match(f2[0].error.message, /读取 offset 不符/)
})

await check('short read with eof:false continues to completion (two-segment manifest)', async () => {
  const raw = Buffer.from(bundle['recipe.figview.json'])
  const half = Math.floor(raw.length / 2)
  const absPath = 'C:/virtual/work/recipe/' + REV + '/recipe.figview.json'
  const w = makeContext({ rawReturn: (path, options) => {
    if (!String(path).includes('figview.json')) return undefined
    const off = options && options.range ? options.range.offset : 0
    if (off === 0) return { ok: true, value: { data: new Uint8Array(raw.subarray(0, half)), eof: false, offset: 0, bytes: raw.length, absolutePath: absPath } }
    return { ok: true, value: { data: new Uint8Array(raw.subarray(off)), eof: true, offset: off, bytes: raw.length, absolutePath: absPath } }
  } })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS)
  assert.ok(frames[0].ok, frames[0].error && frames[0].error.message)
  assert.equal(frames[0].value.manifest.figure_id, 'recipe')
})

await check('bundle boundary: final path outside the manifest directory is rejected', async () => {
  const w = makeContext({
    absPaths: { 'recipe.rows.json': 'C:/outside/recipe.rows.json' },
  })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS)
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /bundle 之外/)
})

await check('malformed envelope and invalid byte arrays are rejected', async () => {
  const w1 = makeContext({ rawReturn: { ok: 'malformed', value: { data: new Uint8Array(bundle['recipe.figview.json']), eof: true } } })
  plugin.apply(w1.ctx)
  const f1 = await framesOf(w1.providers[0], ADDRESS)
  assert.match(f1[0].error.message, /信封非法/)
  const w2 = makeContext({ rawReturn: (path) => {
    if (String(path).includes('figview.json')) return { ok: true, value: { data: new Uint8Array(bundle['recipe.figview.json']), eof: true, offset: 0, bytes: bundle['recipe.figview.json'].length, absolutePath: 'C:/virtual/work/recipe/' + REV + '/recipe.figview.json' } }
    if (String(path).includes('rows')) return { ok: true, value: { data: [104, 101, 300], eof: true, offset: 0 } }
    return undefined
  } })
  plugin.apply(w2.ctx)
  const f2 = await framesOf(w2.providers[0], ADDRESS)
  assert.equal(f2[0].ok, false)
  assert.match(f2[0].error.message, /字节数组元素非法/)
})

await check('mid-read abort stops further IO and emits no success frame', async () => {
  const w = makeContext({ abortAfterFirstRead: true })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS, w.controller.signal)
  assert.equal(frames.length, 0)
  assert.equal(w.readCalls.length, 1, '取消后不应继续读 rows/hits')
})

await check('renderer guard: malformed value renders without throwing', async () => {
  const body = world.entries.find(({ entry }) => entry.name === 'sidebar.right.pane.tab')
  const weird = { manifest: { figure_id: 'w', revision: 'r', capabilities: {} },
    rows: { schema_version: 1, columns: [], rows: {} }, hits: null }
  const rendered = body.component({ useTabInfo: () => ({ tab: { contentId: 'x' } }),
    useResource: () => ({ status: 'live', value: weird }) })
  assert.equal(rendered.props['data-figview'], 'pane-v2')
})

await check('unsupported address and pre-aborted signal produce the right outcomes', async () => {
  const bad = await framesOf(world.providers[0], 'dsh-resource://bio-figure/absolute/whatever')
  assert.equal(bad[0].error.code, 'figview/unsupported-address')
  const none = await framesOf(world.providers[0], ADDRESS, AbortSignal.abort())
  assert.equal(none.length, 0)
})

// ── R2-2.3：结构病理 / 完成性 / schema 残余 / 路径规范化 ────────────────
const BYTES_ABS = 'C:/virtual/work/recipe/' + REV + '/recipe.figview.json'

await check('R223 structural: duplicate keys (top / nested / escaped-equivalent) are rejected', async () => {
  const cases = [
    tamperManifestText('"figure_id":"recipe"', '"figure_id":"recipe","figure_id":"recipe2"'),
    tamperManifestText('"kind":"dataframe"', '"kind":"dataframe","kind":"file"'),
    tamperManifestText('"figure_id":"recipe"', '"figure_id":"recipe","figure_' + String.fromCharCode(92) + 'u0069d":"recipe2"'),
  ]
  for (const bytes of cases) {
    const w = makeContext({ override: { 'recipe.figview.json': bytes } })
    plugin.apply(w.ctx)
    const frames = await framesOf(w.providers[0], ADDRESS)
    assert.equal(frames[0].ok, false, '应拒绝重复键变体')
    assert.match(frames[0].error.message, /重复键|结构非法/)
  }
})

await check('R223 structural: invalid UTF-8 byte is rejected', async () => {
  const b = Buffer.from(bundle['recipe.figview.json'])
  const pos = b.indexOf('"figure_id":"recipe"')
  assert.ok(pos >= 0)
  b[pos + 13] = 0xFF
  const w = makeContext({ override: { 'recipe.figview.json': new Uint8Array(b) } })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS)
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /非合法 UTF-8/)
})

await check('R223 structural: non-finite number (1e999) is rejected', async () => {
  const w = makeContext({ override: { 'recipe.figview.json': tamperManifestText('"width":958', '"width":1e999') } })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS)
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /非有限|非法数值/)
})

await check('R223 read completion: endless eof:false stream is rejected (no silent concat)', async () => {
  const w = makeContext({ rawReturn: (path, options) => {
    if (!String(path).includes('figview.json')) return undefined
    const off = options && options.range ? options.range.offset : 0
    return { ok: true, value: { data: enc(' '), eof: false, offset: off, bytes: 500000, absolutePath: BYTES_ABS } }
  } })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS)
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /未达到 EOF/)
})

await check('R223 read completion: declared size mismatch at eof is rejected', async () => {
  const raw = Buffer.from(bundle['recipe.figview.json'])
  const w = makeContext({ rawReturn: { ok: true, value: { data: new Uint8Array(raw), eof: true, offset: 0, bytes: raw.length + 100, absolutePath: BYTES_ABS } } })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS)
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /累计字节与文件大小不符/)
})

await check('R223 schema: missing row_ids / wrong doc versions / bad object types are rejected', async () => {
  const h = JSON.parse(bundle['recipe.hits.json'].toString('utf8'))
  delete h.elements[0].row_ids
  const ovH2 = withBundle({ 'recipe.hits.json': Buffer.from(JSON.stringify(h)) })
  const w1 = makeContext({ override: ovH2 })
  plugin.apply(w1.ctx)
  const f1 = await framesOf(w1.providers[0], addrWithRev(revOfBytes(ovH2['recipe.figview.json'])))
  assert.match(f1[0].error.message, /缺少 row_ids/)

  const r = JSON.parse(bundle['recipe.rows.json'].toString('utf8'))
  r.schema_version = 2
  const ovR2 = withBundle({ 'recipe.rows.json': Buffer.from(JSON.stringify(r)) })
  const w2 = makeContext({ override: ovR2 })
  plugin.apply(w2.ctx)
  const f2 = await framesOf(w2.providers[0], addrWithRev(revOfBytes(ovR2['recipe.figview.json'])))
  assert.match(f2[0].error.message, /rows schema_version 非法/)

  const ovS = buildManifestBytes(m => { m.source = null })
  const w3 = makeContext({ override: { 'recipe.figview.json': ovS } })
  plugin.apply(w3.ctx)
  const f3 = await framesOf(w3.providers[0], addrWithRev(revOfBytes(ovS)))
  assert.match(f3[0].error.message, /source 类型非法/)

  const ovE = buildManifestBytes(m => { m.capabilities.reason = '' })
  const w4 = makeContext({ override: { 'recipe.figview.json': ovE } })
  plugin.apply(w4.ctx)
  const f4 = await framesOf(w4.providers[0], addrWithRev(revOfBytes(ovE)))
  assert.match(f4[0].error.message, /reason 非法/)
})

await check('R223 path normalization: dot-dot traversal rejected; drive-letter case-insensitive', async () => {
  const w1 = makeContext({ absPaths: { 'recipe.rows.json': 'C:/virtual/work/recipe/' + REV + '/../outside/recipe.rows.json' } })
  plugin.apply(w1.ctx)
  const f1 = await framesOf(w1.providers[0], ADDRESS)
  assert.equal(f1[0].ok, false)
  assert.match(f1[0].error.message, /bundle 之外/)

  const w2 = makeContext({ absPaths: { 'recipe.rows.json': 'c:/virtual/work/recipe/' + REV + '/recipe.rows.json' } })
  plugin.apply(w2.ctx)
  const f2 = await framesOf(w2.providers[0], ADDRESS)
  assert.ok(f2[0].ok, f2[0].error && f2[0].error.message)
})

await check('R223 boundary requires host-provided canonical path (no silent skip)', async () => {
  const w = makeContext({ noAbs: true })
  plugin.apply(w.ctx)
  const frames = await framesOf(w.providers[0], ADDRESS)
  assert.equal(frames[0].ok, false)
  assert.match(frames[0].error.message, /未提供规范路径/)
})

// ── R2-2.4：rows/hits 严格路径 / 类型严格 / UNC / eof 严格 ──────────────
await check('R224 rows/hits strict JSON: duplicate keys and invalid UTF-8 rejected even with matching sha', async () => {
  const rowsText = bundle['recipe.rows.json'].toString('utf8')
  const dup = Buffer.from(rowsText.replace('"schema_version":1', '"schema_version":1,"schema_version":1'))
  const ovDup = withBundle({ 'recipe.rows.json': dup })
  const w1 = makeContext({ override: ovDup })
  plugin.apply(w1.ctx)
  const f1 = await framesOf(w1.providers[0], addrWithRev(revOfBytes(ovDup['recipe.figview.json'])))
  assert.equal(f1[0].ok, false)
  assert.match(f1[0].error.message, /rows 结构非法：重复键/)

  const bad = Buffer.from(rowsText)
  const pos = bad.indexOf('schema_version')
  assert.ok(pos >= 0)
  bad[pos] = 0xFF
  const ovU = withBundle({ 'recipe.rows.json': bad })
  const w2 = makeContext({ override: ovU })
  plugin.apply(w2.ctx)
  const f2 = await framesOf(w2.providers[0], addrWithRev(revOfBytes(ovU['recipe.figview.json'])))
  assert.equal(f2[0].ok, false)
  assert.match(f2[0].error.message, /rows 非合法 UTF-8/)
})

await check('R224 type strictness: schema_version true and array parent_revision are rejected', async () => {
  const w1 = makeContext({ override: { 'recipe.figview.json': tamperManifestText('"schema_version":1', '"schema_version":true') } })
  plugin.apply(w1.ctx)
  const f1 = await framesOf(w1.providers[0], ADDRESS)
  assert.equal(f1[0].ok, false)
  assert.match(f1[0].error.message, /不支持的 schema_version/)

  const ovP = buildManifestBytes(m => { m.parent_revision = ['a'.repeat(64)] })
  const w2 = makeContext({ override: { 'recipe.figview.json': ovP } })
  plugin.apply(w2.ctx)
  const f2 = await framesOf(w2.providers[0], addrWithRev(revOfBytes(ovP)))
  assert.equal(w2 && f2[0].ok, false)
  assert.match(f2[0].error.message, /parent_revision 非法/)
})

await check('R224 host eof is required; UNC case-insensitive placement accepted', async () => {
  const raw = Buffer.from(bundle['recipe.figview.json'])
  const w1 = makeContext({ rawReturn: (path) => {
    if (!String(path).includes('figview.json')) return undefined
    return { ok: true, value: { data: new Uint8Array(raw), offset: 0, bytes: raw.length, absolutePath: BYTES_ABS } }
  } })
  plugin.apply(w1.ctx)
  const f1 = await framesOf(w1.providers[0], ADDRESS)
  assert.equal(f1[0].ok, false)
  assert.match(f1[0].error.message, /缺少布尔 eof/)

  const w2 = makeContext({ absPaths: {
    'recipe.figview.json': '//SERVER/SHARE/b/' + REV + '/recipe.figview.json',
    'recipe.rows.json': '//server/share/b/' + REV + '/recipe.rows.json',
    'recipe.hits.json': '//server/share/b/' + REV + '/recipe.hits.json',
  } })
  plugin.apply(w2.ctx)
  const f2 = await framesOf(w2.providers[0], ADDRESS)
  assert.ok(f2[0].ok, f2[0].error && f2[0].error.message)
})

// ── R2-3：画布变换与命中数学 ────────────────────────────────────────
await check('R23 math: fit / center / zoom-anchor invariance / inverse roundtrip / clamp', () => {
  const M = plugin.__figureViewerMath
  assert.ok(M, '数学钩子应已暴露')
  const f = M.fitView(1000, 500, 500, 500)
  assert.ok(Math.abs(f.scale - 0.49) < 1e-12)
  assert.ok(Math.abs(f.tx - 5) < 1e-12)
  assert.ok(Math.abs(f.ty - 127.5) < 1e-12)
  const one = M.viewAtScale(1000, 500, 500, 500, 1)
  assert.ok(Math.abs(one.tx + 250) < 1e-12 && Math.abs(one.ty) < 1e-12)
  const v0 = { scale: 0.5, tx: 10, ty: 20 }
  const z = M.zoomAt(v0, 1.5, 123, 45)
  const before = M.toImageCoords(v0, 123, 45)
  const after = M.toImageCoords(z, 123, 45)
  assert.ok(Math.abs(before.u - after.u) < 1e-9 && Math.abs(before.v - after.v) < 1e-9, '缩放锚点处的图像坐标应不变')
  const p = M.toImageCoords(z, 200, 100)
  assert.ok(Math.abs(p.u * z.scale + z.tx - 200) < 1e-9)
  assert.ok(Math.abs(p.v * z.scale + z.ty - 100) < 1e-9)
  assert.equal(M.zoomAt({ scale: 50, tx: 0, ty: 0 }, 2, 5, 5).scale, 64)
})

await check('R23 math: hit test radius (css 8px at scale) / ordering / zorder tie / junk skip', () => {
  const M = plugin.__figureViewerMath
  const els = [
    { element_id: 'a', zorder: 5, geometry: { kind: 'point', center: [100, 100], radius: 3 } },
    { element_id: 'b', zorder: 1, geometry: { kind: 'point', center: [104, 100], radius: 3 } },
    { element_id: 'c', zorder: 9, geometry: { kind: 'point', center: [500, 500], radius: 3 } },
  ]
  const hit = M.hitTestElements(els, 105.5, 100, 8, 2)
  assert.equal(hit.length, 2)
  assert.equal(hit[0].el.element_id, 'b')
  assert.equal(hit[1].el.element_id, 'a')
  const lone = [els[0]]
  assert.equal(M.hitTestElements(lone, 107.6, 100, 8, 2).length, 0, '半径边界外应不命中')
  assert.equal(M.hitTestElements(lone, 106.9, 100, 8, 2).length, 1, '半径边界内应命中')
  const tie = [
    { element_id: 'lo', zorder: 1, geometry: { center: [10, 10], radius: 0 } },
    { element_id: 'hi', zorder: 7, geometry: { center: [10, 10], radius: 0 } },
  ]
  assert.equal(M.hitTestElements(tie, 10, 10, 8, 1)[0].el.element_id, 'hi')
  assert.equal(M.hitTestElements([{ element_id: 'x' }, null], 0, 0, 8, 1).length, 0)
})

// ── R2-3.1：clip 合同 / 平局顺序 / 数值防护 / fit 下限 / 无图回退 ─────
await check('R231 hit: off-clip markers cannot be selected; inside-clip works', () => {
  const M = plugin.__figureViewerMath
  const clipped = [
    { element_id: 'in', zorder: 0, geometry: { center: [50, 50], radius: 3 }, clip: [0, 0, 100, 100] },
    { element_id: 'out', zorder: 9, geometry: { center: [150, 150], radius: 3 }, clip: [0, 0, 100, 100] },
  ]
  assert.equal(M.hitTestElements(clipped, 150, 150, 8, 1).length, 0, '完全 off-clip 的点不可选中')
  assert.equal(M.hitTestElements(clipped, 50, 50, 8, 1)[0].el.element_id, 'in')
  const partial = [{ element_id: 'p', zorder: 0, geometry: { center: [98, 95], radius: 3 }, clip: [0, 0, 100, 100] }]
  assert.equal(M.hitTestElements(partial, 98, 95, 8, 1).length, 1, 'clip 内点击命中')
  assert.equal(M.hitTestElements(partial, 106, 95, 8, 1).length, 0, 'clip 外点击即使进入半径也不命中')
})

await check('R231 hit: draw_order and element_id break remaining ties (not JSON order)', () => {
  const M = plugin.__figureViewerMath
  const dtie = [
    { element_id: 'bottom', draw_order: 0, zorder: 1, geometry: { center: [10, 10], radius: 0 } },
    { element_id: 'top', draw_order: 1, zorder: 1, geometry: { center: [10, 10], radius: 0 } },
  ]
  assert.equal(M.hitTestElements(dtie, 10, 10, 8, 1)[0].el.element_id, 'top')
  const rev = [dtie[1], dtie[0]]
  assert.equal(M.hitTestElements(rev, 10, 10, 8, 1)[0].el.element_id, 'top', '输入顺序不决定结果')
})

await check('R231 hit: malformed numeric geometry never throws (skipped)', () => {
  const M = plugin.__figureViewerMath
  assert.equal(M.hitTestElements([{ element_id: 'bad', geometry: { center: [{ toString: null }, 0], radius: 3 } }], 0, 0, 8, 1).length, 0)
  assert.equal(M.hitTestElements([{ element_id: 'bd', geometry: { center: [10, 10], radius: 'x' } }], 10, 10, 8, 1).length, 1, 'radius 非数按 0 处理')
  assert.equal(M.hitTestElements([{ element_id: 'inf', geometry: { center: [Infinity, 0], radius: 3 } }], 0, 0, 8, 1).length, 0)
})

await check('R231 zoom: shrink never increases scale below fit floor', () => {
  const M = plugin.__figureViewerMath
  const fit = M.fitView(10000, 5000, 100, 220)
  assert.ok(fit.scale < 0.02)
  const z = M.zoomAt(fit, 1 / 1.2, 0, 0)
  assert.ok(z.scale <= fit.scale + 1e-12, '缩小操作不得放大')
  assert.equal(M.zoomAt({ scale: 50, tx: 0, ty: 0 }, 2, 5, 5).scale, 64)
})

await check('R231 fallback: omitted image renders row browser instead of canvas', async () => {
  const body = world.entries.find(({ entry }) => entry.name === 'sidebar.right.pane.tab')
  const frames = await framesOf(world.providers[0], ADDRESS)
  const noImg = { manifest: frames[0].value.manifest, rows: frames[0].value.rows, hits: frames[0].value.hits,
    image: { omitted: true, reason: 'missing' } }
  const rendered = body.component({ useTabInfo: () => ({ tab: { contentId: 'x' } }),
    useResource: () => ({ status: 'live', value: noImg }) })
  assert.equal(rendered.props['data-figview'], 'pane-v2')
  const found = []
  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    const attrs = node.props || {}
    if (attrs['data-figview']) found.push(attrs['data-figview'])
    ;(node.children || []).forEach(walk)
  }
  walk(rendered)
  assert.ok(found.indexOf('no-image') !== -1, '无图回退节点存在')
  assert.ok(found.indexOf('row-browser') !== -1, '源表浏览器存在')
})

// ── R2-3.2：分页 / 平局 point_order / 稳定地板 / clip 数值防护 ────────
await check('R232 pager: 60-row fallback shows page 1 of 2 with prev/next controls', async () => {
  const body = world.entries.find(({ entry }) => entry.name === 'sidebar.right.pane.tab')
  const rows60 = { schema_version: 1, columns: [{ name: 'gene', type: 'string', unit: null, precision: 'p', dtype: 'object' }], rows: [] }
  for (let i = 0; i < 60; i++) rows60.rows.push({ row_id: 'r' + i, values: { gene: 'g' + i } })
  const value = { manifest: manifestObj, rows: rows60, hits: null, image: { omitted: true, reason: 'test' } }
  const tree = body.component({ useTabInfo: () => ({ tab: { contentId: 'x' } }),
    useResource: () => ({ status: 'live', value }) })
  let pager = null
  let tbody = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const a = n.props || {}
    if (a['data-figview'] === 'row-pager') pager = n
    if (n.type === 'tbody' && !tbody) tbody = n
    ;(n.children || []).forEach(walk)
  })(tree)
  assert.ok(pager, '分页控件存在')
  const flat = Array.isArray(tbody.children[0]) ? tbody.children[0] : tbody.children
  const trs = flat.filter(c => c && c.type === 'tr')
  assert.equal(trs.length, 50, '首屏 50 行')
  const btns = (pager.children || []).filter(c => c && c.type === 'button')
  assert.equal(btns.length, 2, '上一页/下一页按钮')
  assert.equal(btns[0].props.disabled, true, '首页禁上一页')
})

await check('R232 hit: point_order breaks draw_order ties (later point wins)', () => {
  const M = plugin.__figureViewerMath
  const tie = [
    { element_id: 'a', zorder: 1, draw_order: 0, point_order: 0, geometry: { center: [10, 10], radius: 0 } },
    { element_id: 'b', zorder: 1, draw_order: 0, point_order: 1, geometry: { center: [10, 10], radius: 0 } },
  ]
  assert.equal(M.hitTestElements(tie, 10, 10, 8, 1)[0].el.element_id, 'b')
  assert.equal(M.hitTestElements([tie[1], tie[0]], 10, 10, 8, 1)[0].el.element_id, 'b', '输入顺序不决定结果')
})

await check('R232 zoom: floor is stable across steps (zoom-in then out returns)', () => {
  const M = plugin.__figureViewerMath
  const fit = { scale: 0.0098, tx: 0, ty: 0 }
  const zIn = M.zoomAt(fit, 1.2, 0, 0, 0.0098)
  const zOut = M.zoomAt(zIn, 1 / 1.2, 0, 0, 0.0098)
  assert.ok(Math.abs(zOut.scale - 0.0098) < 1e-12, '放大后缩回应回到地板')
  const fit2 = M.fitView(10000, 5000, 100, 220)
  const back2 = M.zoomAt(M.zoomAt(fit2, 1.2, 0, 0, fit2.scale), 1 / 1.2, 0, 0, fit2.scale)
  assert.ok(Math.abs(back2.scale - fit2.scale) < 1e-12)
})

await check('R232 hit: malformed clip never throws (element skipped)', () => {
  const M = plugin.__figureViewerMath
  const bad = [
    { element_id: 'b1', geometry: { center: [10, 10], radius: 3 }, clip: [0, 0, { toString: null }, 1000] },
    { element_id: 'b2', geometry: { center: [10, 10], radius: 3 }, clip: [0, 0, 100] },
    { element_id: 'b3', geometry: { center: [10, 10], radius: 3 }, clip: [100, 0, 0, 100] },
  ]
  assert.equal(M.hitTestElements(bad, 10, 10, 8, 1).length, 0)
  const okOne = [{ element_id: 'ok', geometry: { center: [10, 10], radius: 3 }, clip: [0, 0, 100, 100] }]
  assert.equal(M.hitTestElements(okOne, 10, 10, 8, 1).length, 1)
})

// ── R2-3.3：renderer 必填（onLoad 注入）/ 清理 effect 依赖就绪 ────────
await check('R233 dims: renderer size required — missing/string rejected at load', async () => {
  const body = world.entries.find(({ entry }) => entry.name === 'sidebar.right.pane.tab')
  const frames = await framesOf(world.providers[0], ADDRESS)
  const base = frames[0].value
  const mw = base.manifest.image.width
  const mh = base.manifest.image.height
  function runOnLoad(hitsVar) {
    const vv = { manifest: base.manifest, rows: base.rows, hits: hitsVar, image: base.image }
    const tree = body.component({ useTabInfo: () => ({ tab: { contentId: 'x' } }),
      useResource: () => ({ status: 'live', value: vv }) })
    let img = null
    ;(function walk(n) {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (n.props && n.props['data-figview'] === 'figure-img') { img = n; return }
      ;(n.children || []).forEach(walk)
    })(tree)
    assert.ok(img, 'img rendered')
    const b4 = testHooks.stateCalls.length
    img.props.onLoad({ target: { naturalWidth: mw, naturalHeight: mh, parentElement: null } })
    return testHooks.stateCalls.slice(b4)
  }
  const h1 = JSON.parse(JSON.stringify(base.hits)); h1.renderer_height = '5000'
  assert.ok(runOnLoad(h1).indexOf('error') !== -1, 'string renderer_height 拒绝')
  const h2 = JSON.parse(JSON.stringify(base.hits)); delete h2.renderer_height
  assert.ok(runOnLoad(h2).indexOf('error') !== -1, 'missing renderer_height 拒绝')
  const h3 = JSON.parse(JSON.stringify(base.hits)); delete h3.renderer_width; delete h3.renderer_height
  assert.ok(runOnLoad(h3).indexOf('error') !== -1, '双轴缺失拒绝')
  const good = runOnLoad(base.hits)
  assert.ok(good.indexOf('error') === -1 && good.indexOf('loaded') !== -1, '正常路径 loaded')
})

await check('R233 lifecycle: cleanup effect deps ready at render (boolean + status)', async () => {
  const body = world.entries.find(({ entry }) => entry.name === 'sidebar.right.pane.tab')
  const frames = await framesOf(world.providers[0], ADDRESS)
  const v = frames[0].value
  const b1 = testHooks.effects.length
  body.component({ useTabInfo: () => ({ tab: { contentId: 'x' } }),
    useResource: () => ({ status: 'live', value: v }) })
  const ready = testHooks.effects.slice(b1).some(e => Array.isArray(e.deps) && e.deps.length === 2
    && e.deps[0] === true && typeof e.deps[1] === 'string')
  assert.ok(ready, '有图场景：deps=[true, imgStatus]')
  const von = { manifest: v.manifest, rows: v.rows, hits: v.hits, image: { omitted: true, reason: 'x' } }
  const b2 = testHooks.effects.length
  body.component({ useTabInfo: () => ({ tab: { contentId: 'x' } }),
    useResource: () => ({ status: 'live', value: von }) })
  const ready2 = testHooks.effects.slice(b2).some(e => Array.isArray(e.deps) && e.deps.length === 2
    && e.deps[0] === false && typeof e.deps[1] === 'string')
  assert.ok(ready2, 'omitted 场景：deps=[false, imgStatus]')
})

await check('R233b cleanup: effect body clears selection when image absent, keeps it otherwise', async () => {
  const body = world.entries.find(({ entry }) => entry.name === 'sidebar.right.pane.tab')
  const frames = await framesOf(world.providers[0], ADDRESS)
  const v = frames[0].value
  // omitted 态：清理 effect 提交 → setSel(null)
  const von = { manifest: v.manifest, rows: v.rows, hits: v.hits, image: { omitted: true, reason: 'x' } }
  const b1 = testHooks.effects.length
  body.component({ useTabInfo: () => ({ tab: { contentId: 'x' } }),
    useResource: () => ({ status: 'live', value: von }) })
  const clr1 = testHooks.effects.slice(b1).find(e => Array.isArray(e.deps) && e.deps.length === 2
    && typeof e.deps[0] === 'boolean' && e.fn)
  assert.ok(clr1, '清理 effect 已注册（omitted）')
  const c1 = testHooks.stateCalls.length
  clr1.fn()
  assert.ok(testHooks.stateCalls.slice(c1).indexOf(null) !== -1, 'omitted 提交 → setSel(null)')
  // 有图 idle 态：清理 effect 提交 → 不清选择
  const b2 = testHooks.effects.length
  body.component({ useTabInfo: () => ({ tab: { contentId: 'x' } }),
    useResource: () => ({ status: 'live', value: v }) })
  const clr2 = testHooks.effects.slice(b2).find(e => Array.isArray(e.deps) && e.deps.length === 2
    && typeof e.deps[0] === 'boolean' && e.fn)
  assert.ok(clr2, '清理 effect 已注册（有图）')
  const c2 = testHooks.stateCalls.length
  clr2.fn()
  assert.equal(testHooks.stateCalls.slice(c2).indexOf(null), -1, '有图 idle 提交 → 不清选择')
})

await check('R232b pager: next button invokes page advance with correct argument', async () => {
  const body = world.entries.find(({ entry }) => entry.name === 'sidebar.right.pane.tab')
  const rows60 = { schema_version: 1, columns: [{ name: 'gene', type: 'string' }], rows: [] }
  for (let i = 0; i < 60; i++) rows60.rows.push({ row_id: 'r' + i, values: { gene: 'g' + i } })
  const value = { manifest: manifestObj, rows: rows60, hits: null, image: { omitted: true, reason: 'test' } }
  const tree = body.component({ useTabInfo: () => ({ tab: { contentId: 'x' } }),
    useResource: () => ({ status: 'live', value }) })
  let pager = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const a = n.props || {}
    if (a['data-figview'] === 'row-pager') pager = n
    ;(n.children || []).forEach(walk)
  })(tree)
  assert.ok(pager, 'pager')
  const btns = (pager.children || []).filter(c => c && c.type === 'button')
  assert.equal(btns.length, 2)
  assert.equal(btns[0].props.disabled, true, '首页禁上一页')
  assert.equal(btns[1].props.disabled, false, '首页允许下一页')
  const c1 = testHooks.stateCalls.length
  btns[1].props.onClick()
  assert.ok(testHooks.stateCalls.slice(c1).indexOf(1) !== -1, '下一页 → setPage(1)')
  const c2 = testHooks.stateCalls.length
  btns[0].props.onClick()
  assert.equal(testHooks.stateCalls.slice(c2).length, 0, '首页点上一页 → 无状态变更')
})

await check('R234b dims: illegal renderer object rejected AND error text stays string-safe', async () => {
  const body = world.entries.find(({ entry }) => entry.name === 'sidebar.right.pane.tab')
  const frames = await framesOf(world.providers[0], ADDRESS)
  const base = frames[0].value
  const mw = base.manifest.image.width
  const mh = base.manifest.image.height
  const h4 = JSON.parse(JSON.stringify(base.hits)); h4.renderer_width = { toString: null }
  const vv = { manifest: base.manifest, rows: base.rows, hits: h4, image: base.image }
  const tree = body.component({ useTabInfo: () => ({ tab: { contentId: 'x' } }),
    useResource: () => ({ status: 'live', value: vv }) })
  let img = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.props && n.props['data-figview'] === 'figure-img') { img = n; return }
    ;(n.children || []).forEach(walk)
  })(tree)
  assert.ok(img, 'img rendered')
  const b4 = testHooks.stateCalls.length
  img.props.onLoad({ target: { naturalWidth: mw, naturalHeight: mh, parentElement: null } })
  const calls = testHooks.stateCalls.slice(b4)
  assert.ok(calls.indexOf('error') !== -1, '非法 renderer 对象被拒')
  const mm = calls.filter(x => x && typeof x === 'object' && x.got)
  assert.ok(mm.length >= 1, 'setMismatch 被调用')
  const gw = mm[0].got.w
  const s1 = '实际 ' + gw + ' 期望 ' + mm[0].expect.w   // 模拟渲染拼接：修复前（原始对象）此处抛 TypeError
  assert.ok(typeof s1 === 'string', '错误文案拼接安全')
  const s2 = '实际 ' + mm[0].got.h + ' 期望 ' + mm[0].expect.h
  assert.ok(typeof s2 === 'string')
})

// ── R2-4：重绘闭环（请求文本 / 回填 adapter / 表单 / 集成） ──────────
await check('R24 redraw: request text carries ids, patch and the no-source-change requirement', () => {
  const M = plugin.__figureViewerMath
  const m = { figure_id: 'figX', revision: 'abc123',
    redraw: { recipe_id: 'volcano_r1', allowed_parameters: ['alpha'], parameters: { alpha: 0.05 } },
    source: { snapshot_sha256: 'deadbeef' } }
  const text = M.buildRedrawRequest(m, { alpha: { from: 0.05, to: '0.1' } }, '标题改为Y')
  assert.ok(text.includes('figure_id: figX'))
  assert.ok(text.includes('base_revision: abc123'))
  assert.ok(text.includes('recipe_id: volcano_r1'))
  assert.ok(text.includes('deadbeef'))
  assert.ok(text.includes('alpha: 0.05 -> ' + JSON.stringify('0.1')))
  assert.ok(text.includes('备注: 标题改为Y'))
  assert.ok(text.includes('allowed_parameters: ["alpha"]'), '含白名单审计字段')
  assert.ok(text.includes('新 revision'), '要求以新 revision 导出')
  assert.ok(text.includes('源表/原始行不动'), '声明不改源数据')
})

await check('R24 redraw: fill prefers insert, preserves existing draft on fallback, reports no-channel/errors', () => {
  const M = plugin.__figureViewerMath
  const calls = []
  const a1 = { captureInsertion: () => ({ start: 1, end: 1, draftRev: 7 }),
    insertText: (tx, span) => { calls.push(['ins', tx, span.draftRev]); return true },
    setDraft: (tx) => calls.push(['set', tx]) }
  const r1 = M.applyRedrawFill(a1, null, 'TXT')
  assert.equal(r1.ok, true)
  assert.equal(r1.mode, 'insert')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'ins')
  const calls2 = []
  const a2 = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText: () => false,
    setDraft: (tx) => calls2.push(tx) }
  const r2 = M.applyRedrawFill(a2, { draft: '已有草稿' }, 'TXT')
  assert.equal(r2.ok, true)
  assert.equal(r2.mode, 'setDraft')
  assert.ok(calls2[0].includes('已有草稿') && calls2[0].includes('TXT'), '保留旧草稿并追加')
  const r3 = M.applyRedrawFill(null, null, 'T')
  assert.equal(r3.ok, false)
  assert.equal(r3.reason, 'no-channel')
  const a4 = { captureInsertion: () => { throw new Error('boom') }, insertText: () => true }
  const r4 = M.applyRedrawFill(a4, null, 'T')
  assert.equal(r4.ok, false)
  assert.equal(r4.reason, 'error')
  const r5 = M.applyRedrawFill({}, null, 'T')
  assert.equal(r5.ok, false)
  assert.equal(r5.reason, 'no-method')
  const r6 = M.applyRedrawFill({ setDraft: () => {} }, null, 'T')
  assert.equal(r6.ok, false)
  assert.equal(r6.reason, 'no-draft-info', '无草稿信息时不盲写（不覆盖风险）')
})

await check('R24 redraw: form renders whitelist params, buttons, preview; fill button calls insertText', async () => {
  const M = plugin.__figureViewerMath
  const frames = await framesOf(world.providers[0], ADDRESS)
  const value = frames[0].value
  const calls = []
  const mockActions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 3 }),
    insertText: (tx) => { calls.push(tx); return true },
    setDraft: () => {} }
  const form = M.RedrawForm({ value, inputActions: mockActions, useInput: () => ({ draft: '' }) })
  assert.equal(form.props['data-figview'], 'redraw-form')
  const found = { params: [], buttons: [], preview: null }
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const a = n.props || {}
    if (a['data-redraw-param']) found.params.push(a['data-redraw-param'])
    if (a['data-figview'] === 'redraw-fill') found.buttons.push(n)
    if (a['data-figview'] === 'redraw-preview') found.preview = n
    ;(n.children || []).forEach(walk)
  })(form)
  const allowed = value.manifest.redraw.allowed_parameters
  assert.equal(found.params.length, allowed.length, '每个白名单参数一行输入')
  assert.equal(found.buttons.length, 1, '回填按钮存在')
  assert.ok(found.preview, '预览存在')
  const previewText = JSON.stringify(found.preview.children || [])
  assert.ok(previewText.includes(value.manifest.figure_id), '预览含 figure_id')
  found.buttons[0].props.onClick()
  assert.equal(calls.length, 1, 'fill 调用了 insertText')
  assert.ok(calls[0].includes('【图重绘请求】'))
})

await check('R24 redraw: viewer tab exposes the redraw toggle', async () => {
  const body = world.entries.find(({ entry }) => entry.name === 'sidebar.right.pane.tab')
  const frames = await framesOf(world.providers[0], ADDRESS)
  const tree = body.component({ useTabInfo: () => ({ tab: { contentId: 'x' } }),
    useResource: () => ({ status: 'live', value: frames[0].value }) })
  let toggle = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const a = n.props || {}
    if (a['data-figview'] === 'redraw-toggle') toggle = n
    ;(n.children || []).forEach(walk)
  })(tree)
  assert.ok(toggle, '重绘按钮在查看器工具栏')
  assert.ok(String((toggle.children || [])[0]).includes('重绘'))
})

// ── R2-6：来源行 / 元素列表 / 数据编辑 ──────────────────────────────
await check('R26 edit: buildEditRequest carries ids, edits and audit requirement', () => {
  const M = plugin.__figureViewerMath
  const m = { figure_id: 'figX', revision: 'abc123',
    source: { kind: 'file', label: 'data.csv', path: 'C:/w/data.csv', file_sha256: 'f'.repeat(64) } }
  const text = M.buildEditRequest(m,
    { deletes: ['r1:0'], sets: [{ row_id: 'r2:0', column: 'pvalue', from: 0.2, to: '0.05' }] },
    '剔除离群点',
    [{ name: 'pvalue', type: 'number' }])
  assert.ok(text.includes('figure_id: figX'))
  assert.ok(text.includes('base_revision: abc123'))
  assert.ok(text.includes('source_path: C:/w/data.csv'))
  assert.ok(text.includes('删除行 r1:0'))
  assert.ok(text.includes('修改行 r2:0 的 pvalue [type=number]: 0.2 -> ' + JSON.stringify('0.05')))
  assert.ok(text.includes('source_file_sha256: ' + 'f'.repeat(64)))
  assert.ok(text.includes('parent_revision=base_revision'))
  assert.ok(text.includes('备注: 剔除离群点'))
  assert.ok(text.includes('审计'), '要求保留审计')
})

await check('R26 edit: EditPanel renders edits; generate fills via insertText', () => {
  const M = plugin.__figureViewerMath
  const m = { figure_id: 'figX', revision: 'r1', source: { kind: 'file', path: 'C:/w/d.csv' } }
  const calls = []
  const actions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText: tx => { calls.push(tx); return true }, setDraft: () => {} }
  const panel = M.EditPanel({ manifest: m,
    editSet: { deletes: ['r1:0'], sets: [{ row_id: 'r2:0', column: 'x', from: 1, to: '2' }] },
    inputActions: actions, onClear: () => {} })
  assert.equal(panel.props['data-figview'], 'edit-panel')
  const items = { del: 0, set: 0, gen: null }
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const a = n.props || {}
    if (a['data-figview'] === 'edit-delete-item') items.del += 1
    if (a['data-figview'] === 'edit-set-item') items.set += 1
    if (a['data-figview'] === 'edit-generate') items.gen = n
    ;(n.children || []).forEach(walk)
  })(panel)
  assert.equal(items.del, 1)
  assert.equal(items.set, 1)
  assert.ok(items.gen, '生成按钮存在')
  items.gen.props.onClick()
  assert.equal(calls.length, 1, 'generate 调 insertText')
  assert.ok(calls[0].includes('【图数据编辑请求】'))
})

await check('R26 list: ElementsPanel renders rows and picks by click', () => {
  const M = plugin.__figureViewerMath
  const hits = { elements: [
    { element_id: 'ns:1', kind: 'point', row_ids: ['a:0'], geometry: { center: [10, 20], radius: 2 } },
    { element_id: 'up:2', kind: 'point', row_ids: [], geometry: { center: [30, 40], radius: 2 } },
  ] }
  const picked = []
  const panel = M.ElementsPanel({ hits, sel: { elementId: 'ns:1' }, onPick: el => picked.push(el) })
  assert.equal(panel.props['data-figview'], 'elements-panel')
  const rows = []
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const a = n.props || {}
    if (a['data-figview'] === 'element-row') rows.push(n)
    ;(n.children || []).forEach(walk)
  })(panel)
  assert.equal(rows.length, 2, '两个元素两行')
  rows[1].props.onClick()
  assert.equal(picked.length, 1)
  assert.equal(picked[0].element_id, 'up:2')
})

await check('R26 viewer: list toggle, source line and copy button present', async () => {
  const body = world.entries.find(({ entry }) => entry.name === 'sidebar.right.pane.tab')
  const frames = await framesOf(world.providers[0], ADDRESS)
  const tree = body.component({ useTabInfo: () => ({ tab: { contentId: 'x' } }),
    useResource: () => ({ status: 'live', value: frames[0].value }) })
  const found = { list: false, src: false }
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const a = n.props || {}
    if (a['data-figview'] === 'list-toggle') found.list = true
    if (a['data-figview'] === 'source-line') found.src = true
    ;(n.children || []).forEach(walk)
  })(tree)
  assert.ok(found.list, '列表按钮在工具栏')
  assert.ok(found.src, '来源行渲染')
})

// ── R2-4.1：选区折叠 / === true / canRedraw 门 / proto 键 ────────────
await check('R241 fill: non-collapsed selection folds to its end (never replaces)', () => {
  const M = plugin.__figureViewerMath
  const seen = []
  const actions = {
    captureInsertion: () => ({ start: 0, end: 5, draftRev: 3 }),
    insertText: (tx, span) => { seen.push(span); return true },
    setDraft: () => {},
  }
  const r = M.applyRedrawFill(actions, null, 'TXT')
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'insert')
  assert.equal(seen[0].start, 5, '折叠到选区末端')
  assert.equal(seen[0].end, 5)
  assert.equal(seen[0].draftRev, 3, 'draftRev 保留')
  // 折叠光标不动
  const seen2 = []
  const a2 = { captureInsertion: () => ({ start: 2, end: 2, draftRev: 8 }),
    insertText: (tx, span) => { seen2.push(span); return true }, setDraft: () => {} }
  M.applyRedrawFill(a2, null, 'T')
  assert.equal(seen2[0].start, 2)
  // 返回值非严格 true 不算成功（宿主合同）
  const r3 = M.applyRedrawFill({ captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }),
    insertText: () => 1, setDraft: () => {} }, null, 'T')
  assert.equal(r3.ok, false)
  assert.equal(r3.reason, 'no-draft-info')
})

await check('R241 form: request_redraw=false disables fill with reason notice', async () => {
  const M = plugin.__figureViewerMath
  const frames = await framesOf(world.providers[0], ADDRESS)
  const base = frames[0].value
  const m2 = JSON.parse(JSON.stringify(base.manifest))
  m2.capabilities.request_redraw = false
  const v2 = { manifest: m2, rows: base.rows, hits: base.hits, image: base.image }
  const form = M.RedrawForm({ value: v2, inputActions: null, useInputState: null })
  const found = { fill: null, notice: false }
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const a = n.props || {}
    if (a['data-figview'] === 'redraw-fill') found.fill = n
    if (a['data-figview'] === 'redraw-unavailable') found.notice = true
    ;(n.children || []).forEach(walk)
  })(form)
  assert.ok(found.notice, '不可重绘提示')
  assert.equal(found.fill.props.disabled, true, '回填按钮禁用')
})

await check('R241 form: proto keys do not leak inherited values into preview', async () => {
  const M = plugin.__figureViewerMath
  const frames = await framesOf(world.providers[0], ADDRESS)
  const base = frames[0].value
  const m3 = JSON.parse(JSON.stringify(base.manifest))
  m3.redraw.allowed_parameters = ['constructor']
  const v3 = { manifest: m3, rows: base.rows, hits: base.hits, image: base.image }
  const form = M.RedrawForm({ value: v3, inputActions: null, useInputState: null })
  let preview = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const a = n.props || {}
    if (a['data-figview'] === 'redraw-preview') preview = n
    ;(n.children || []).forEach(walk)
  })(form)
  assert.ok(preview, '预览存在')
  const text = JSON.stringify(preview.children || [])
  assert.ok(!text.includes('function Object'), '不泄漏继承值')
})

await check('R241b: explicit null from stays literal; missing from shows placeholder', () => {
  const M = plugin.__figureViewerMath
  const m = { figure_id: 'f', revision: 'r', redraw: { recipe_id: 'x', allowed_parameters: ['a', 'b'], parameters: {} },
    source: { snapshot_sha256: 'd'.repeat(64) } }
  const t1 = M.buildRedrawRequest(m, { a: { from: null, to: 'Y' } })
  assert.ok(t1.includes('a: null -> ' + JSON.stringify('Y')), '真实 null 原值字面显示')
  const t2 = M.buildRedrawRequest(m, { b: { from: undefined, to: 'Z' } })
  assert.ok(t2.includes('b: (当前值) -> ' + JSON.stringify('Z')), '未提供显示当前值占位')
  assert.ok(!t2.includes('b: null'), '不把未提供写成 null')
})

await check('R261 list: pager reaches element 301; row cap raised to 500', () => {
  const M = plugin.__figureViewerMath
  const els = []
  for (let i = 0; i < 301; i++) els.push({ element_id: 'ns:' + (1000 + i), kind: 'point', row_ids: [], geometry: { center: [0, 0], radius: 0 } })
  els.push({ element_id: 'ns:1', kind: 'point', row_ids: [], geometry: { center: [0, 0], radius: 0 } })
  const hits = { elements: els }
  // 第 1 页：300 行 + 分页器
  const p0 = M.ElementsPanel({ hits, sel: null, page: 0, onPage: () => {}, onPick: () => {} })
  let pager = null
  let rowCount = 0
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const a = n.props || {}
    if (a['data-figview'] === 'elements-pager') pager = n
    if (a['data-figview'] === 'element-row') rowCount += 1
    ;(n.children || []).forEach(walk)
  })(p0)
  assert.equal(rowCount, 300, '第 1 页 300 行')
  assert.ok(pager, '分页器（当 >300 时）')
  // 第 2 页：最后 2 个元素可达（含第 301 个）
  const p1 = M.ElementsPanel({ hits, sel: null, page: 1, onPage: () => {}, onPick: () => {} })
  const texts = []
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if ((n.props || {})['data-figview'] === 'element-row') texts.push(JSON.stringify(n.children || []))
    ;(n.children || []).forEach(walk)
  })(p1)
  assert.ok(texts.some(x => x.includes('ns:1 ·')), '第 301 个元素在第 2 页可达（精确行标记）')
  assert.ok(!texts.some(x => x.includes('ns:1000 ·')), '第 2 页不含第 1 页元素')
})

await check('R261 chain: viewer source/script paths flow from tool event to card buttons', () => {
  const tail = world.entries.find(({ entry }) => entry.name === 'conversation.chat.turnTail')
  const event = {
    type: 'tool/result', seq: 60, data: { turn: 6, step: 1, message: { role: 'tool', isError: false,
      source: { kind: 'tool', callId: 'call-x' },
      content: [{ type: 'text', text: JSON.stringify({ count: 1, results: [{
        path: 'C:/w/recipe.png', verdict: 'PASS',
        viewer: { available: true, manifest: 'C:/w/recipe/abc/recipe.figview.json', figure_id: 'recipe',
          source_path: 'C:/w/data.csv', script_path: 'C:/w/recipe/abc/recipe.py' },
      }] }) }] } },
  }
  let st = def.start({}, { event: { data: { turn: 6 } } })
  st = def.update({ state: st }, { event, seq: 60 })
  assert.equal(st.figures[0].sourcePath, 'C:/w/data.csv')
  assert.equal(st.figures[0].scriptPath, 'C:/w/recipe/abc/recipe.py')
  const loc = def.buildLocationData({ state: st }, 'turn', null)
  const files = []
  const card = tail.component({ sessionId: SESSION, seq: 60,
    turn: { data: { get: k => (k === 'bio-figures' ? loc.value : undefined) } },
    openFile: p2 => files.push(p2) })
  const list = card.children.find(Array.isArray)
  const btns = []
  ;(function walk(n) {
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n && typeof n === 'object') {
      if (n.type === 'button') btns.push(n)
      ;(n.children || []).forEach(walk)
    }
  })(list[0])
  const srcBtn = btns.find(b => String((b.children || [])[0]).includes('源数据'))
  const scrBtn = btns.find(b => String((b.children || [])[0]).includes('脚本'))
  assert.ok(srcBtn && scrBtn, '链末端按钮存在（事件驱动，非手工构造）')
  srcBtn.props.onClick()
  scrBtn.props.onClick()
  assert.deepEqual(files, ['C:/w/data.csv', 'C:/w/recipe/abc/recipe.py'])
  // 后续 update 补全来源元数据（同 ref）
  let st2 = def.start({}, { event: { data: { turn: 7 } } })
  const evNoSrc = { type: 'tool/result', seq: 61, data: { turn: 7, step: 1, message: { role: 'tool', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ count: 1, results: [{ path: 'C:/w/r.png', verdict: 'PASS',
      viewer: { available: true, manifest: 'C:/w/r/abc/r.figview.json', figure_id: 'r' } }] }) }] } } }
  st2 = def.update({ state: st2 }, { event: evNoSrc, seq: 61 })
  assert.equal(st2.figures[0].sourcePath, null)
  const evSrc = { type: 'tool/result', seq: 62, data: { turn: 7, step: 2, message: { role: 'tool', isError: false,
    content: [{ type: 'text', text: JSON.stringify({ count: 1, results: [{ path: 'C:/w/r.png', verdict: 'PASS',
      viewer: { available: true, manifest: 'C:/w/r/abc/r.figview.json', figure_id: 'r', source_path: 'C:/w/r.csv' } }] }) }] } } }
  st2 = def.update({ state: st2 }, { event: evSrc, seq: 62 })
  assert.equal(st2.figures[0].sourcePath, 'C:/w/r.csv', '后续 update 补全来源元数据')
})

// ── tab / 卡片 / 查看器 ─────────────────────────────────────────────────
await check('tab claims only well-formed bio-figure session addresses; title derives from stem', () => {
  const tab = world.tabs[0]
  assert.ok(tab.canOpen(ADDRESS))
  assert.ok(!tab.canOpen('dsh-resource://file/session/s1/plot.png'))
  assert.ok(!tab.canOpen('dsh-resource://bio-figure/absolute/x'))
  assert.equal(tab.title(ADDRESS), 'recipe')
})

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
  const flatButtons = r => {
    const out = []
    ;(function walk(n) {
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (n && typeof n === 'object') {
        if (n.type === 'button') out.push(n)
        ;(n.children || []).forEach(walk)
      }
    })(r.children || [])
    return out
  }
  const buttons = list.map(flatButtons)
  assert.ok(buttons[0].length >= 1 && buttons[1].length >= 1)
  buttons[0][0].props.onClick()
  assert.equal(world.opened.length, 1)
  buttons[1][0].props.onClick()
  assert.deepEqual(files, ['C:/w/b.png'])
  // R2-6：sidecar 行带 sourcePath 时出现「源数据」按钮，点击走 openFile
  const figures2 = { figures: [
    { kind: 'sidecar', manifest: 'C:/w/a.figview.json', imagePath: null, figureId: 'a',
      sourcePath: 'C:/w/data.csv', scriptPath: 'C:/w/a.figview-bundle/recipe.py', seq: 5 },
  ] }
  const files2 = []
  const card2 = tail.component({ sessionId: SESSION, seq: 9,
    turn: { data: { get: k => (k === 'bio-figures' ? figures2 : undefined) } },
    openFile: p => files2.push(p) })
  const list2 = card2.children.find(Array.isArray)
  const btns2 = flatButtons(list2[0])
  const srcBtn = btns2.find(b => String((b.children || [])[0]).includes('源数据'))
  const scrBtn = btns2.find(b => String((b.children || [])[0]).includes('脚本'))
  assert.ok(srcBtn, '源数据按钮存在')
  assert.ok(scrBtn, '脚本按钮存在')
  srcBtn.props.onClick()
  scrBtn.props.onClick()
  assert.deepEqual(files2, ['C:/w/data.csv', 'C:/w/a.figview-bundle/recipe.py'])
  assert.equal(tail.component({ sessionId: SESSION, turn: { data: { get: () => undefined } } }), null)
})

await check('viewer tab renders summary + preview payload and handles failure frame', async () => {
  const body = world.entries.find(({ entry }) => entry.name === 'sidebar.right.pane.tab')
  const frames = await framesOf(world.providers[0], ADDRESS)
  const ok = body.component({ useTabInfo: () => ({ tab: { contentId: ADDRESS } }), useResource: () => ({ status: 'live', value: frames[0].value }) })
  assert.equal(ok.props['data-figview'], 'pane-v2')
  const err = body.component({ useTabInfo: () => ({ tab: { contentId: ADDRESS } }), useResource: () => ({ status: 'failed', failure: { code: 'x', message: 'boom' } }) })
  assert.equal(err.props['data-figview'], 'pane-error')
})

console.log(`fig-viewer-refs: ${count}/${count} passed (factory/adapter scope; real fixture bundle; no real DOM)`)
