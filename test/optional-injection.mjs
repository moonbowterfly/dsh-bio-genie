/**
 * dsh-bio-genie — 可选 webServer 动态注入验证（2026-09-19 审计修复的回归门）。
 *
 * 背景：webServer 曾经在静态 inject 数组里——缺少它的部署（非 web 宿主）中整个
 * 插件保持 pending、apply() 永不执行、62 个工具注册为 0。修复=webServer 改为
 * apply() 内动态注入（ctx.inject(['webServer'], cb)，gem 插件同款模式）：
 *   - 无 webServer：工具/skill 照常注册（本文件的 ctx 桩不提供 webServer 回调）
 *   - 有 webServer：面板路由被注册到 webServer 上
 *
 * Run: node --import ./test/register-dsh-tools.mjs test/optional-injection.mjs
 */
import assert from 'node:assert/strict'

const plugin = await import('../src/index.js')

// ① 静态注入不得包含可选服务 webServer
assert.deepEqual(plugin.inject, ['tools', 'skills', 'systemPrompt'])

let toolRegistrations = 0
let skillRegistrations = 0
const onEvents = []
let dynamicInjection = null
const ctx = {
  tools: { register: () => { toolRegistrations += 1; return () => {} } },
  skills: { register: () => { skillRegistrations += 1; return () => {} } },
  systemPrompt: { section: () => {} },
  on: (event) => { onEvents.push(event); return () => {} },
  get: () => undefined,
  logger: { warn: () => {}, info: () => {} },
  effect: (callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : (() => {}) },
  inject: (deps, callback) => { dynamicInjection = { deps, callback }; return () => {} },
}

plugin.apply(ctx, { warmUp: false })

// ② 无 webServer 环境下：工具与 skill 已注册、rigor-guard 事件已挂
assert.equal(toolRegistrations, 62, `expected 62 tool registrations, got ${toolRegistrations}`)
assert.equal(skillRegistrations, 50, `expected 50 skill registrations, got ${skillRegistrations}`)
assert.ok(onEvents.includes('tools/post-execute'), 'rigor-guard post-execute hook missing')
assert.ok(onEvents.includes('agent/turn-stopping'), 'rigor-guard turn-stopping hook missing')

// ③ webServer 走动态注入（而不是静态 inject）
assert.deepEqual(dynamicInjection?.deps, ['webServer'], 'webServer dynamic injection not declared')

// ④ webServer 可用时：面板路由注册到 webServer
const routes = []
const webCtx = {
  webServer: {
    register: (route) => { routes.push(route); return () => {} },
  },
  effect: (callback) => { const dispose = callback(); return typeof dispose === 'function' ? dispose : (() => {}) },
}
dynamicInjection.callback(webCtx)
assert.ok(routes.length >= 1, 'no API routes registered on webServer')
assert.ok(routes.every((route) => typeof route.path === 'string' && route.path.startsWith('/api/dsh-bio-genie/')),
  `unexpected route paths: ${JSON.stringify(routes.map((r) => r.path))}`)

console.log(`✓ optional webServer injection: ${toolRegistrations} tools + ${skillRegistrations} skills active without webServer; ${routes.length} routes registered with webServer`)
