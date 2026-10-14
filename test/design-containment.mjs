// B0 containment 负测 — raw POST / callBio / dispatch 顺序（v3 §B0 / §P0 证明②）
// 证据形态：假 venv + sitecustomize 哨兵（进程一启动即写 marker）——
// 「无 marker」= 进程未启动；阳性对照证明哨兵灵敏（benign op 必写 marker）。
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerApiRoutes } from '../src/server.js'
import { callBio } from '../src/python.js'
import { DESIGN_OPS } from '../src/design-ops.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'design-contain-home-'))

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS', name) }
  else { fail += 1; console.log('  FAIL', name, extra ?? '') }
}

// ── 假 venv + spawn 哨兵 ──────────────────────────────────────────────
const home = process.env.USERPROFILE || process.env.HOME
const uv = join(home, '.dsh', 'dsh-bio-genie', 'bin', 'uv.exe')
const fakeEnv = mkdtempSync(join(tmpdir(), 'design-contain-'))
let tripwireReady = false
let tripwireDetail = ''
{
  let r = spawnSync(uv, ['venv', fakeEnv], { encoding: 'utf8' })
  if (r.status !== 0) {
    // 回退：用系统 python -m venv
    r = spawnSync('python', ['-m', 'venv', fakeEnv], { encoding: 'utf8' })
  }
  tripwireReady = r.status === 0
  tripwireDetail = String(r.stderr || '').slice(0, 120)
  if (tripwireReady) {
    const sp = join(fakeEnv, 'Lib', 'site-packages')
    mkdirSync(sp, { recursive: true })
    writeFileSync(join(sp, 'sitecustomize.py'),
      'import os\n' +
      'try:\n' +
      "    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'SPAWN_MARKER.txt'), 'w').write('spawned')\n" +
      'except Exception:\n' +
      '    pass\n')
  }
}
check('tripwire venv ready (uv venv + sitecustomize)', tripwireReady, tripwireDetail)
if (!tripwireReady) {
  console.log('design-containment: cannot establish tripwire — aborting')
  process.exit(1)
}
const fakePy = join(fakeEnv, 'Scripts', 'python.exe')
const marker = join(fakeEnv, 'SPAWN_MARKER.txt')
const clearMarker = () => rmSync(marker, { force: true })
const markerExists = () => existsSync(marker)

// ── 路由挂载（mock ctx/webServer + mock req/res，模式同 galatea-models-api.mjs）──
const routes = []
const ctx = { webServer: { register: (route) => { routes.push(route); return () => {} } } }
registerApiRoutes(ctx, { pythonEnvDir: fakeEnv })
const route = routes.find((r) => r.path.endsWith('/execute-tool'))
check('execute-tool route found', !!route)

function mockRes() {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status) { res.statusCode = status },
    end(chunk) { res.body += chunk },
  }
  return res
}
async function post(body) {
  const res = mockRes()
  const payload = JSON.stringify(body)
  const req = {
    method: 'POST',
    url: '/api/dsh-bio-genie/execute-tool',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
  }
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(payload, 'utf8')
  }
  await route.handler(req, res)
  let json = null
  try { json = JSON.parse(res.body) } catch { /* keep null */ }
  return { status: res.statusCode, json }
}

// ── 1) 六个 design op raw POST → 403 PANEL_OP_NOT_ALLOWED + 无进程 ──
for (const op of DESIGN_OPS) {
  clearMarker()
  const r = await post({ op, args: {} })
  check(`raw POST ${op} -> PANEL_OP_NOT_ALLOWED`, r.status === 403 && r.json?.code === 'PANEL_OP_NOT_ALLOWED', JSON.stringify(r))
  check(`raw POST ${op} -> python 未启动`, !markerExists())
}

// ── 2) 阳性对照：benign op 确实 spawn（哨兵灵敏性证明）──
clearMarker()
{
  const r = await post({ op: 'env_status', args: {} })
  check('positive control: benign op spawns (marker present)', markerExists(), JSON.stringify(r))
  check('positive control: 非 panel 拒绝路径', r.status !== 403)
  clearMarker()
}

// ── 3) callBio 守卫 ──
clearMarker()
{
  const res = await callBio(fakePy, 'design_chassis_profile', {})
  check('callBio design op -> DESIGN_TOOL_REQUIRED', res.ok === false && res.code === 'DESIGN_TOOL_REQUIRED', JSON.stringify(res))
  check('callBio design op -> python 未启动', !markerExists())
}
clearMarker()
{
  await callBio(fakePy, 'env_status', {})
  check('positive control callBio: benign op spawns (marker present)', markerExists())
  clearMarker()
}

// ── 4) dispatch 顺序：gate 先行（真代码路径，整仓副本 + 子进程）──
const dispatchWork = mkdtempSync(join(tmpdir(), 'design-dispatch-'))
function makeGenieCopy(name) {
  const dir = join(dispatchWork, name)
  mkdirSync(dir, { recursive: true })
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true })
  cpSync(join(ROOT, 'design'), join(dir, 'design'), { recursive: true })
  cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'))
  return dir
}
const child = fileURLToPath(new URL('./design-dispatch-child.mjs', import.meta.url))
function runChild(dir, op) {
  const r = spawnSync(process.execPath, [child, dir, fakePy, op || 'design_chassis_profile'], { encoding: 'utf8', timeout: 120000 })
  let out = null
  try { out = JSON.parse(r.stdout.trim().split('\n').pop()) } catch { /* keep null */ }
  return { out, stdout: r.stdout, stderr: r.stderr }
}
{
  const dir = makeGenieCopy('pristine')
  clearMarker()
  const { out } = runChild(dir)
  check('dispatch pristine: gate 通过 -> spawn 发生（marker）', markerExists(), JSON.stringify(out))
  check('dispatch pristine: 返回 dispatch_id（staging 已建）', !!out?.dispatch_id, JSON.stringify(out))
  clearMarker()
}
{
  const dir = makeGenieCopy('tampered')
  const f = join(dir, 'design', 'packet', 'schemas', 'claim.json')
  writeFileSync(f, readFileSync(f, 'utf8') + ' ')
  clearMarker()
  const { out } = runChild(dir)
  check('dispatch tampered: CONTRACT_PACKET_UNREVIEWED', out?.code === 'CONTRACT_PACKET_UNREVIEWED', JSON.stringify(out))
  check('dispatch tampered: python 未启动（gate 先行）', !markerExists())
  check('dispatch tampered: 无 staging 残留', !existsSync(join(dir, 'staging')), '')
}
{
  const dir = makeGenieCopy('nonop')
  clearMarker()
  const { out } = runChild(dir, 'env_status')
  check('dispatch 非 design op -> NOT_A_DESIGN_OP', out?.code === 'NOT_A_DESIGN_OP', JSON.stringify(out))
  check('dispatch 非 design op -> no spawn', !markerExists())
}

console.log('design-containment: %d passed, %d failed', pass, fail)
rmSync(fakeEnv, { recursive: true, force: true })
rmSync(dispatchWork, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
