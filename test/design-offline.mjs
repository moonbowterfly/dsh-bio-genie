// dsh-bio-genie — A6 offline enforcement 验收（req G-LOOP-20261015-D5-001）
// 覆盖（照 design/offline-enforcement.md §2/§3/§4/§6）：
//  1) 拦截机制探针：sitecustomize 哨兵经 PYTHONPATH 预载（正探针激活标记 + 负探针
//     socket.create_connection 必须抛 OFFLINE_GUARD 特征 OSError）——真实断网，非 mock；
//  2) reference bundle 完整性：scripts/validate_reference_registry.py 7/7 PASS（离线可复跑）；
//  3) design 实现零 fetch 核证（worker/design js 无 urllib/requests/urlopen/socket import）；
//  4) 断网 E2E（guard env）：casefile stage（builder）→ validate → export；
//     含 consequence 时用 iML1515（冻结锚点 baseline growth=0.876997）；
//  5) fail-closed 声明核对：offline-enforcement.md 已登记拦截方式 + 本地缓存白名单。
// spawn 差异披露：A6 worker 不用 -I（-E 会忽略 PYTHONPATH 使哨兵不载入）；
// 其余语义（信封提取、exit）与设计通道 worker 契约一致。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUILDER = join(ROOT, 'test', 'design-casefile-builder.mjs')
const home = process.env.USERPROFILE || process.env.HOME
const VENV = process.env.DSH_BIO_PYTHON || join(home, '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe')

const IML = process.env.DESIGN_TEST_IML1515
  || 'D:\\Program\\dsh-plug-develop\\genie-synbio-design-20261012\\reference\\iML1515.xml'
const IML_SHA = '9c772d44ca43350e40dc7ee86c7aa148796856be1eea45e5406c6df8f7dcde28'
const BIOMASS = 'BIOMASS_Ec_iML1515_core_75p37M'
const IML_AVAILABLE = existsSync(IML)

let pass = 0
let fail = 0
let skip = 0
const roots = []
function check(name, actual, detail = '') {
  if (actual) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
function skipNote(name) {
  skip += 1
  console.log('  SKIP ' + name + '（iML1515 外置资产不可用）')
}
function workdir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix || 'design-offline-'))
  roots.push(d)
  return d
}
function buildCase(mode, outDir) {
  const r = spawnSync(process.execPath, [BUILDER, outDir, mode], { encoding: 'utf8', timeout: 300_000 })
  if (r.status !== 0) throw new Error('builder failed: ' + (r.stderr || r.stdout))
  return JSON.parse(r.stdout.trim())
}

// ── guard env 组装（照 design/offline-enforcement.md §2）────────────────────
function makeGuard() {
  const dir = workdir('offline-guard-')
  writeFileSync(join(dir, 'sitecustomize.py'), [
    'import socket as _socket',
    'import builtins',
    '',
    'def _block_connect(*_a, **_k):',
    '    raise OSError("OFFLINE_GUARD: socket connection blocked by A6 offline guard")',
    '',
    '_socket.socket.connect = _block_connect',
    '_socket.create_connection = _block_connect',
    'builtins._OFFLINE_GUARD_ACTIVE = True',
    '',
  ].join('\n'), 'utf8')
  return dir
}
function offlineEnv(guardDir) {
  return {
    ...process.env,
    DSH_DESIGN_PACKET: '',
    DSH_DESIGN_PACKET_FIXED: join(ROOT, 'design', 'packet'),
    PYTHONPATH: guardDir,
    HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '',
  }
}
function spawnWorker(worker, payload, env) {
  // 不用 -I：-E 会忽略 PYTHONPATH，哨兵 sitecustomize 无法预载（A6 spawn 差异点，已披露）
  return spawnSync(VENV, [join(ROOT, 'python', worker)], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 240_000, env,
  })
}

const guard = makeGuard()
const env = offlineEnv(guard)

// ── 1) 拦截机制探针（正 + 负）────────────────────────────────────────────
{
  const probe = spawnSync(VENV, ['-c', [
    'import socket, builtins',
    'active = getattr(builtins, "_OFFLINE_GUARD_ACTIVE", False)',
    'blocked = False',
    'try:',
    '    socket.create_connection(("1.2.3.4", 80), timeout=1)',
    'except OSError as e:',
    '    blocked = "OFFLINE_GUARD" in str(e)',
    'print("ACTIVE=" + str(active), "BLOCKED=" + str(blocked))',
  ].join('\n')], { encoding: 'utf8', env, timeout: 30_000 })
  check('正探针：哨兵经 PYTHONPATH 预载（非 mock）', /ACTIVE=True/.test(probe.stdout || ''), (probe.stdout || probe.stderr).slice(0, 200))
  check('负探针：socket.create_connection 被拒（OFFLINE_GUARD 特征）', /BLOCKED=True/.test(probe.stdout || ''), (probe.stdout || probe.stderr).slice(0, 200))
}

// ── 2) reference bundle 完整性（离线 7/7）───────────────────────────────
{
  const reg = spawnSync(VENV, [join(ROOT, 'scripts', 'validate_reference_registry.py')],
    { encoding: 'utf8', cwd: ROOT, env, timeout: 120_000 })
  check('reference registry 7/7 PASS（离线完整）', reg.status === 0 && /RESULT: PASS/.test(reg.stdout || ''), (reg.stdout || reg.stderr).slice(0, 200))
}

// ── 3) design 实现零 fetch 核证（防静默联网回归）─────────────────────────
{
  const files = [
    'python/design_consequence.py', 'python/design_host.py',
    'python/design_casefile.py', 'python/design_ops.py', 'python/design_validate.py',
    'src/design-validate.js', 'src/design-envelope.js', 'src/design-dispatch.js',
    'src/design-gate.js', 'src/design-ops.js',
  ]
  const pat = /urllib|import requests|from requests|urlopen|import socket|http\.client/
  const hits = []
  for (const f of files) {
    const p = join(ROOT, f)
    if (!existsSync(p)) continue
    const src = readFileSync(p, 'utf8')
    if (pat.test(src)) hits.push(f)
  }
  check('design 通道零 fetch（worker + design js 无网络 import）', hits.length === 0, hits.join(','))
}

// ── 4) 断网 E2E（guard env）：stage → validate → export（+ consequence/iML1515）──
{
  const wd = workdir('offline-e2e-')
  const clean = buildCase('clean', join(wd, 'case'))
  check('E2E 前置：stage（builder clean）成功', Boolean(clean.case_dir && clean.snapshot_sha))

  const v = spawnWorker('design_casefile.py', { op: 'design_casefile_validate', args: { casefile_dir: clean.case_dir } }, env)
  const ve = JSON.parse(v.stdout.trim() || '{}')
  check('E2E validate（guard env）→ OK 信封', v.status === 0 && ve.status === 'OK', v.stdout.slice(0, 160))
  check('E2E validate checks 8/8 PASS（断网下完整重验）',
    Array.isArray(ve.checks) && ve.checks.length === 8 && ve.checks.every((c) => c.status === 'PASS'), v.stdout.slice(0, 160))

  const x = spawnWorker('design_casefile.py', { op: 'design_casefile_export', args: { casefile_dir: clean.case_dir, format: 'both' } }, env)
  const xe = JSON.parse(x.stdout.trim() || '{}')
  check('E2E export（guard env）→ OK + 2 产物（zip + report）',
    v.status === 0 && xe.status === 'OK' && Array.isArray(xe.artifact_refs) && xe.artifact_refs.length === 2, x.stdout.slice(0, 160))
}

if (IML_AVAILABLE) {
  const wd = workdir('offline-e2e-cons-')
  const card = join(wd, 'card.json')
  writeFileSync(card, JSON.stringify({ schema_version: 'v0-test', model_sha256: IML_SHA }), 'utf8')
  const args = {
    sbml_path: IML, expected_sbml_sha256: IML_SHA, card_path: card, medium: [],
    coupling_profile: { rules: [{ rule_id: 'r1', reaction_id: 'EX_glc__D_e', operation: 'set_lower_bound', derived_bound: -5 }] },
    scenarios: [{ scenario_id: 'glc5', target_reaction: BIOMASS }],
  }
  const c = spawnWorker('design_consequence.py', { op: 'design_consequence', args }, env)
  const ce = JSON.parse(c.stdout.trim() || '{}')
  check('E2E consequence（guard env，iML1515 锚点）→ OK',
    c.status === 0 && ce.ok !== false && ce.status === 'OK', c.stdout.slice(0, 200))
  const b = ce.consequence_run?.baseline?.objective_value
  check('E2E consequence baseline 冻结锚点 0.876997（bundle 资产离线驱动）',
    typeof b === 'number' && Math.abs(b - 0.876997) < 1e-4, 'baseline=' + b)
} else {
  skipNote('E2E consequence（iML1515）')
}

// ── 5) fail-closed 声明核对（文档登记完整性）────────────────────────────
{
  const doc = readFileSync(join(ROOT, 'design', 'offline-enforcement.md'), 'utf8')
  check('offline-enforcement.md 登记拦截方式（socket guard + PYTHONPATH 预载）',
    /socket guard/.test(doc) && /sitecustomize/.test(doc) && /PYTHONPATH/.test(doc))
  check('offline-enforcement.md 登记本地缓存白名单（逐条）',
    /白名单/.test(doc) && /design\/packet/.test(doc) && /validate_reference_registry\.py/.test(doc))
  check('offline-enforcement.md 登记未声明 fetch fail-closed 口径（DEPENDENCY_UNAVAILABLE/BLOCKED）',
    /DEPENDENCY_UNAVAILABLE/.test(doc) && /BLOCKED/.test(doc))
}

for (const root of roots) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* cleanup does not change verdict */ }
}
console.log(`design-offline: ${pass} passed, ${skip} skipped, ${fail} failed`)
if (fail) process.exit(1)
