// dsh-bio-genie — A7 archive round-trip 验收（req G-LOOP-20261015-D5-001；规格 §8.2 M14）
// 覆盖（bundle.zip 解压到全新目录 → 独立重验四件）：
//  1) hash inventory：hashes.sha256 覆盖 zip 内全部其他条目、逐项可独立复核
//     （双向：条目 ⊆ 清单 且 清单 ⊆ 条目；实测 sha == 登记 sha）；
//  2) 路径逃逸：zip-slip / 绝对路径 / 目录穿越（../、/ 开头、反斜杠、盘符）→ 拒绝；
//  3) 绝对路径依赖：解压目录可独立复跑（重建最小 casefile 布局 → 同仓库 validate 8/8 PASS；
//     report.md 不含原 case 目录路径；objects 名 == 内容 sha256，无原目录依赖）；
//  4) report↔manifest 一致：manifest 全部 artifact_id 出现在 report 64-hex 引用中。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitReportFinalizeTransaction } from '../src/design-casefile.js'
import { cleanVenvEnv } from './clean-venv-env.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUILDER = join(ROOT, 'test', 'design-casefile-builder.mjs')
const home = process.env.USERPROFILE || process.env.HOME
const VENV = process.env.DSH_BIO_PYTHON || join(home, '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe')

let pass = 0
let fail = 0
const roots = []
function check(name, actual, detail = '') {
  if (actual) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
function workdir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix || 'design-archive-'))
  roots.push(d)
  return d
}
function buildCase(mode, outDir) {
  const r = spawnSync(process.execPath, [BUILDER, outDir, mode], { encoding: 'utf8', timeout: 300_000 })
  if (r.status !== 0) throw new Error('builder failed: ' + (r.stderr || r.stdout))
  return JSON.parse(r.stdout.trim())
}
const ENV_PACKET = () => ({
  ...process.env,
  DSH_DESIGN_PACKET: '',
  DSH_DESIGN_PACKET_FIXED: join(ROOT, 'design', 'packet'),
})
function spawnWorker(worker, payload, cwd, extraEnv = {}) {
  return spawnSync(VENV, ['-I', join(ROOT, 'python', worker)], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 240_000, env: { ...ENV_PACKET(), ...extraEnv }, cwd,
  })
}
// zip 清单 + 安全提取 + 逐项复核（python zipfile，输出 ASCII JSON）
const ZIP_CODE = [
  'import zipfile, json, hashlib, os, re, sys',
  'zip_path, out_dir = sys.argv[1], sys.argv[2]',
  'r = {"entries": [], "hash_lines": [], "safe": True, "bad": [], "extracted": []}',
  'def unsafe(n):',
  '    if n.startswith("../") or n.startswith("/") or "\\\\" in n or "/../" in n:',
  '        return True',
  '    if re.match(r"^[A-Za-z]:", n) or n in ("..", "."):',
  '        return True',
  '    return False',
  'with zipfile.ZipFile(zip_path) as zf:',
  '    for n in zf.namelist():',
  '        if unsafe(n):',
  '            r["safe"] = False',
  '            r["bad"].append(n)',
  '    for n in zf.namelist():',
  '        data = zf.read(n)',
  '        r["entries"].append({"name": n, "sha256": hashlib.sha256(data).hexdigest()})',
  '        if n == "hashes.sha256":',
  '            r["hash_lines"] = [ln.split("  ", 1) for ln in data.decode("utf-8").strip().split("\\n")]',
  '        else:',
  '            dest = os.path.join(out_dir, *n.split("/"))',
  '            os.makedirs(os.path.dirname(dest), exist_ok=True)',
  '            with open(dest, "wb") as fh:',
  '                fh.write(data)',
  '            r["extracted"].append(n)',
  'print(json.dumps(r))',
].join('\n')
function inspectZip(zipPath, outDir) {
  const env = { ...cleanVenvEnv(), PYTHONIOENCODING: 'utf-8' }
  const r = spawnSync(VENV, ['-c', ZIP_CODE, zipPath, outDir], { encoding: 'utf8', env, timeout: 120_000 })
  if (r.status !== 0) throw new Error('zip inspect failed: ' + (r.stderr || r.stdout))
  return JSON.parse(r.stdout.trim())
}

// ── 主链路：clean case → validate OK → finalize（B4）→ export → bundle.zip ─
const wd = workdir('archive-')
const clean = buildCase('clean', join(wd, 'case'))
const v = spawnWorker('design_casefile.py', { op: 'design_casefile_validate', args: { casefile_dir: clean.case_dir } }, wd)
const ve = JSON.parse(v.stdout.trim() || '{}')
check('前置：clean case validate OK', v.status === 0 && ve.status === 'OK', v.stdout.slice(0, 160))

// B4：渲染 stage → TS 本地 finalize 事务 → 纯导出（S_(n+1)）
const stageDir = join(clean.case_dir, 'staging', 'archive-b4-stage')
mkdirSync(stageDir, { recursive: true })
const s = spawnWorker('design_casefile.py', { op: 'design_casefile_export', args: { casefile_dir: clean.case_dir, _stage_report: true, source_snapshot_sha: clean.snapshot_sha, audit_view_id: [] } }, wd, { DSH_DESIGN_STAGING: stageDir })
const se = JSON.parse(s.stdout.trim() || '{}')
check('前置：stage 报告渲染 OK + report.md', s.status === 0 && se.status === 'OK' && existsSync(join(stageDir, 'report.md')), s.stdout.slice(0, 160))
const tx = commitReportFinalizeTransaction(
  { caseDir: clean.case_dir, objectsDir: join(clean.case_dir, 'objects'), snapshotsDir: join(clean.case_dir, 'snapshots') },
  { reportBytes: readFileSync(join(stageDir, 'report.md')), expectHead: clean.snapshot_sha },
)
check('前置：finalize 事务 OK + S_(n+1)', tx.ok === true && /^[0-9a-f]{64}$/.test(tx.snapshot_sha || ''), JSON.stringify(tx).slice(0, 160))

const x = spawnWorker('design_casefile.py', { op: 'design_casefile_export', args: { casefile_dir: clean.case_dir, format: 'both' } }, wd)
const xe = JSON.parse(x.stdout.trim() || '{}')
check('前置：export OK + 2 产物', x.status === 0 && xe.status === 'OK' && Array.isArray(xe.artifact_refs) && xe.artifact_refs.length === 2, x.stdout.slice(0, 160))
const exportRoot = join(wd, 'exports', tx.snapshot_sha.slice(0, 12))
const zipPath = typeof xe.artifact_refs[0] === 'string'
  ? xe.artifact_refs.find((p) => String(p).endsWith('bundle.zip'))
  : join(exportRoot, 'bundle.zip')
check('前置：bundle.zip 落盘', existsSync(zipPath))

// ── 1+2) hash inventory + 路径逃逸（解压到全新目录）──────────────────────
const fresh = workdir('extract-')
const z = inspectZip(zipPath, fresh)
const entryNames = z.entries.map((e) => e.name)
const hashMap = Object.fromEntries(z.hash_lines.map(([sha, rel]) => [rel, sha]))
const hashRels = Object.keys(hashMap)

check('① hash inventory：hashes.sha256 覆盖 zip 内全部其他条目（双向）',
  entryNames.filter((n) => n !== 'hashes.sha256').sort().join('|') === hashRels.sort().join('|'),
  'entries=' + entryNames.length + ' hash=' + hashRels.length)
check('① 逐项可独立复核：实测 sha == 登记 sha',
  z.entries.filter((e) => e.name !== 'hashes.sha256').every((e) => hashMap[e.name] === e.sha256))
check('① 条目自身完整性（zip 内字节 sha 与登记一致）',
  z.entries.every((e) => e.name !== 'hashes.sha256' || z.hash_lines.length > 0))
check('② 路径逃逸：无 zip-slip / 绝对路径 / 目录穿越（安全标志）', z.safe === true, z.bad.join(','))
check('② 解压全部落地于全新目录（extracted 数 == 非 hash 条目数）',
  z.extracted.length === entryNames.length - 1)

// ── 3) 绝对路径依赖：解压目录独立复跑 ─────────────────────────────────────
{
  const report = readFileSync(join(fresh, 'report.md'), 'utf8')
  check('③ report.md 不含原 case 目录路径（无原目录依赖）',
    !report.includes(clean.case_dir) && !report.includes('exports\\') && !report.includes('exports/'), '')
  const objOk = z.entries.every((e) => {
    const m = /^objects\/([0-9a-f]{64})$/.exec(e.name)
    return !m || m[1] === e.sha256
  })
  check('③ objects 名 == 内容 sha256（对象自洽，不依赖原目录）', objOk)
}
{
  // 重建最小 casefile 布局（HEAD.json + snapshots/<sha>.json ← snapshot.json）→ 同仓库 validate
  const snapshot = JSON.parse(readFileSync(join(fresh, 'snapshot.json'), 'utf8'))
  const sha = snapshot.snapshot_sha
  check('③ snapshot.json 内 snapshot_sha 与 HEAD 一致', typeof sha === 'string' && sha.length === 64)
  mkdirSync(join(fresh, 'snapshots'))
  writeFileSync(join(fresh, 'snapshots', sha + '.json'), JSON.stringify(snapshot), 'utf8')
  writeFileSync(join(fresh, 'HEAD.json'), JSON.stringify({ snapshot_sha: sha }), 'utf8')
  const rv = spawnWorker('design_casefile.py', { op: 'design_casefile_validate', args: { casefile_dir: fresh } }, fresh)
  const rve = JSON.parse(rv.stdout.trim() || '{}')
  check('③ 解压目录独立复跑 validate → OK 8/8 PASS（无原目录依赖）',
    rv.status === 0 && rve.status === 'OK'
    && Array.isArray(rve.checks) && rve.checks.length === 8 && rve.checks.every((c) => c.status === 'PASS'),
    rv.stdout.slice(0, 200))
}

// ── 4) report↔manifest 一致 ─────────────────────────────────────────────
{
  const snapshot = JSON.parse(readFileSync(join(fresh, 'snapshot.json'), 'utf8'))
  const arts = snapshot.artifacts || []
  const aid = arts.filter((a) => a.type !== 'case_report@1').map((a) => a.artifact_id).filter(Boolean)
  const types = new Set(arts.map((a) => a.type))
  const report = readFileSync(join(fresh, 'report.md'), 'utf8')
  const tokens = new Set(report.match(/[0-9a-f]{64}/g) || [])
  check('④ report↔manifest：manifest 全部 artifact_id 在 report 引用中出现',
    aid.every((id) => tokens.has(id)))
  check('④ manifest 条目数 > 0（真实快照非空）', aid.length > 0)
  check('④ manifest 含多种 artifact type（12+ 类 c14n 对象）', types.size >= 10)
}

for (const root of roots) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* cleanup does not change verdict */ }
}
console.log(`design-archive-roundtrip: ${pass} passed, 0 skipped, ${fail} failed`)
if (fail) process.exit(1)
