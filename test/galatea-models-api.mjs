// galatea-models 端点回归测试（无 dsh 依赖：mock ctx/webServer + mock req/res）。
import { registerApiRoutes } from 'file:///D:/Program/Github/dsh-bio-genie/src/server.js'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dshHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
process.env.DSH_HOME = dshHome
delete process.env.GALATEA_MODELS_DIR

const routes = []
const ctx = { webServer: { register: (route) => { routes.push(route); return () => {} } } }
registerApiRoutes(ctx, {})
const route = routes.find((r) => r.path.endsWith('/galatea-models'))
if (!route) throw new Error('route /galatea-models not found')
console.log('[route] found')

function mockRes() {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status) { res.statusCode = status },
    end(chunk) { res.body += chunk },
  }
  return res
}
async function call(method, body) {
  const res = mockRes()
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url: '/api/dsh-bio-genie/galatea-models',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  }
  req[Symbol.asyncIterator] = async function* () {
    if (payload) yield Buffer.from(payload, 'utf8')
  }
  await route.handler(req, res)
  let json = null
  try { json = JSON.parse(res.body) } catch { /* keep null */ }
  return { status: res.statusCode, json }
}

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS', name) }
  else { fail += 1; console.log('  FAIL', name, extra ?? '') }
}

// 1) GET 初始（默认位置）
let r = await call('GET')
check('GET 初始默认', r.status === 200 && r.json.ok === true && r.json.value.source === 'default',
  JSON.stringify(r.json?.value ?? r.json))
const cfgPath = r.json.value.configPath
check('configPath 正确', cfgPath === join(dshHome, 'dsh-bio-galatea', 'config.json'), cfgPath)

// 2) POST 设置到"外盘"（临时目录模拟）+ 放一个假权重文件
const target = mkdtempSync(join(tmpdir(), 'models-'))
const targetPosix = target.replace(/\\/g, '/')
mkdirSync(join(target, 'mpnn'), { recursive: true })
writeFileSync(join(target, 'mpnn', 'proteinmpnn_v_48_020.pt'), 'x'.repeat(128))
r = await call('POST', { modelsDir: targetPosix })
check('POST 设置成功', r.status === 200 && r.json.value.source === 'config' && r.json.value.applied === true,
  JSON.stringify(r.json?.value ?? r.json))
const cfgRaw = readFileSync(cfgPath, 'utf8')
check('config.json 合法 JSON（无尾部垃圾）', (() => { try { JSON.parse(cfgRaw); return true } catch { return false } })())
check('config.json 含 modelsDir', JSON.parse(cfgRaw).modelsDir === targetPosix)

// 3) GET 复查
r = await call('GET')
check('GET 复查一致', r.json.value.dir === targetPosix && r.json.value.source === 'config', r.json.value.dir)
check('占用统计（mpnn 1 文件 128B）',
  r.json.value.listing.fileCount === 1 && r.json.value.listing.sizeBytes === 128,
  JSON.stringify(r.json.value.listing))

// 4) 其它字段合并保留
writeFileSync(cfgPath, JSON.stringify({ modelsDir: targetPosix, other: 42 }, null, 2))
r = await call('POST', { modelsDir: targetPosix })
check('合并写保留 other 字段', JSON.parse(readFileSync(cfgPath, 'utf8')).other === 42)

// 5) 相对路径拒绝
r = await call('POST', { modelsDir: 'relative/path' })
check('相对路径拒绝（400 invalid-path）', r.status === 400 && r.json.code === 'invalid-path', JSON.stringify(r.json))

// 6) 恢复默认（空串 → 删字段）
r = await call('POST', { modelsDir: '' })
check('恢复默认', r.json.value.source === 'default' && !('modelsDir' in JSON.parse(readFileSync(cfgPath, 'utf8'))), r.json.value.source)

// 7) 深层不存在目录 → 自动创建
const deep = join(tmpdir(), 'deep-' + Date.now(), 'a', 'b').replace(/\\/g, '/')
r = await call('POST', { modelsDir: deep })
check('深层目录自动创建', r.status === 200 && existsSync(deep), `${r.status} exists=${existsSync(deep)}`)

// 8) env 覆盖（GALATEA_MODELS_DIR 优先）
process.env.GALATEA_MODELS_DIR = 'G:/override'
r = await call('GET')
check('env 优先于 config', r.json.value.source === 'env' && r.json.value.dir === 'G:/override' && r.json.value.envOverride === true, JSON.stringify(r.json.value))
delete process.env.GALATEA_MODELS_DIR

// 9) 域端点 /protein 也存在（探针路）
const proteinRoute = routes.find((rr) => rr.path.endsWith('/protein'))
check('/protein 路由注册', !!proteinRoute)

console.log(`\n结果: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
