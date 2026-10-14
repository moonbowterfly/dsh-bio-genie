#!/usr/bin/env node
// conformance-report.mjs — G-LOOP-20261015-E2-001：双端 conformance 报告生成器
//   （c14n corpus + schema corpus 的双端一致性 + 运行环境版本；工作单 E2）
//
// 只读运行：不修改 packet / corpus / 实现 / 既有测试；只写 --out 与 --report 指定的文件。
//
// 用法：
//   node scripts/conformance-report.mjs --out <json-path> [--report <md-path>]
//     --out    机器可读 JSON 输出路径（缺省时 JSON 打到 stdout）
//     --report 人类可读 Markdown 报告路径（缺省 = <--out 同目录>/CONFORMANCE-REPORT.md）
//   无 --out 时：JSON → stdout，人类摘要 → stderr。
//
// 退出码：0 = 双端全等（PASS）；1 = 任一不一致 / 任一运行失败（FAIL，fail-closed）。
//
// 对比语义（复刻既有资产）：
//   schema corpus 批跑：src/design-validate.js --batch（TS/ajv）
//                        python/design_validate.py --batch（PY/jsonschema）——同 test/design-validation.mjs
//   c14n corpus 批跑：  design/packet/impl/c14n.mjs --batch（node）
//                        design/packet/impl/c14n.py --batch（python）——同 design/packet/corpus/run_corpus.py
//   硬失败项：双端判定（valid/status）不一致、sem 不一致、canonical 字节不一致、
//             vs 语料期望不一致、vs packet 冻结结果不一致、任一运行失败/结果缺失。
//   warn 项（不阻断）：c14n reject 的 code 双端不同（与 run_corpus.py 一致）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKET = join(ROOT, 'design', 'packet')
const SCHEMA_CORPUS = join(PACKET, 'schema-corpus', 'schema_cases.json')
const SCHEMA_FROZEN_NODE = join(PACKET, 'schema-corpus', 'results_schema_node.json')
const SCHEMA_FROZEN_PY = join(PACKET, 'schema-corpus', 'results_schema_python.json')
const C14N_CORPUS = join(PACKET, 'corpus', 'c14n_cases.json')
const EVIDENCE_FILE = join(PACKET, 'evidence', 'conformance-environment.txt')
const TS_IMPL = join(ROOT, 'src', 'design-validate.js')
const PY_IMPL = join(ROOT, 'python', 'design_validate.py')
const C14N_JS = join(PACKET, 'impl', 'c14n.mjs')
const C14N_PY = join(PACKET, 'impl', 'c14n.py')
const home = process.env.USERPROFILE || process.env.HOME
const VENV = process.env.DSH_BIO_PYTHON || join(home, '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe')
const REQ_ID = 'G-LOOP-20261015-E2-001'

const fwd = (p) => p.replaceAll('\\', '/')
const rel = (p) => fwd(relative(ROOT, p))
const relc = (p) => fwd(relative(process.cwd(), p) || p)

function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}
const outPath = arg('out')
const reportPath = arg('report') || (outPath ? join(dirname(outPath), 'CONFORMANCE-REPORT.md') : undefined)
const command = ['node', ...process.argv.slice(1).map((a) => (a.startsWith(ROOT) ? rel(a) : a))].join(' ')

// ── 运行辅助 ────────────────────────────────────────────────────────────────
function run(cmdArgs, opts = {}) {
  try {
    const r = spawnSync(cmdArgs[0], cmdArgs.slice(1), { encoding: 'utf8', timeout: opts.timeout || 300000, windowsHide: true, env: opts.env, cwd: opts.cwd })
    if (r.error) return { ok: false, status: null, stdout: '', stderr: '', error: String(r.error.message || r.error) }
    return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? String(r.error) : '' }
  } catch (e) {
    return { ok: false, status: null, stdout: '', stderr: '', error: String(e && e.message ? e.message : e) }
  }
}

function loadJson(p, what) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

// ── 1) 环境版本（真实采集，不硬编码）──────────────────────────────────────
const PY_ENV_PROBE = [
  'import sys, platform, json, unicodedata',
  'from importlib.metadata import version',
  'print(json.dumps({"python": sys.version.split()[0], "platform": platform.platform(),',
  '                  "unidata": unicodedata.unidata_version,',
  '                  "jsonschema": version("jsonschema"), "referencing": version("referencing")}))',
].join('\n')

function collectEnvironment() {
  const env = {
    node: {
      version: process.version,
      icu: process.versions.icu ?? 'n/a',
      unicode: process.versions.unicode ?? 'n/a',
      v8: process.versions.v8 ?? 'n/a',
      platform: process.platform,
      arch: process.arch,
    },
    ajv: 'unavailable',
    python: null,
    python_interpreter: fwd(VENV),
    evidence_deltas: [],
  }
  try {
    env.ajv = loadJson(join(ROOT, 'node_modules', 'ajv', 'package.json'), 'ajv').version
  } catch { /* keep 'unavailable' */ }
  const r = run([VENV, '-c', PY_ENV_PROBE], { timeout: 60000 })
  if (r.ok && r.stdout.trim()) {
    try { env.python = JSON.parse(r.stdout.trim()) } catch { env.python = { probe_error: 'unparseable stdout' } }
  } else {
    env.python = { probe_error: r.error || `exit ${r.status}` }
  }
  // 与既有证据记录（F3.2）对比，如实披露差异
  if (existsSync(EVIDENCE_FILE)) {
    const text = readFileSync(EVIDENCE_FILE, 'utf8')
    const pats = [
      ['node', /node v([\d.]+)/], ['icu', /icu ([\d.]+)/], ['unicode', /unicode ([\d.]+)/],
      ['v8', /v8 ([\d.]+(?:-[A-Za-z0-9.]+)?)/], ['python', /python ([\d.]+)/], ['unidata', /unicodedata ([\d.]+)/],
    ]
    const prior = {}
    for (const [k, re] of pats) { const m = text.match(re); if (m) prior[k] = m[1] }
    env.evidence_file = rel(EVIDENCE_FILE)
    env.evidence_prior = prior
    const nowMap = {
      node: env.node.version.replace(/^v/, ''),
      icu: env.node.icu,
      unicode: env.node.unicode,
      v8: env.node.v8,
      python: env.python && env.python.python ? env.python.python : null,
      unidata: env.python && env.python.unidata ? env.python.unidata : null,
    }
    for (const [k, now] of Object.entries(nowMap)) {
      if (prior[k] !== undefined && now !== null && now !== undefined && String(prior[k]) !== String(now)) {
        env.evidence_deltas.push({ key: k, prior: prior[k], now: String(now) })
      }
    }
  }
  return env
}

// ── 2) schema corpus（99 例）双端判定比对 ──────────────────────────────────
function runSchemaCorpus(work) {
  const res = {
    corpus: rel(SCHEMA_CORPUS),
    case_count: 0,
    expect_dist: {},
    ts_side: null,
    py_side: null,
    verdict_equal: false, verdict_mismatches: [],
    core_valid_equal: false, core_valid_mismatches: [],
    sem_equal: false, sem_mismatches: [],
    c14n_layer_equal: false, c14n_layer_mismatches: [],
    expect_equal: false, expect_mismatches: [],
    frozen_node_equal: false, frozen_py_equal: false, frozen_mismatches: [],
    missing: [],
    run_failures: [],
  }
  const cases = loadJson(SCHEMA_CORPUS, 'schema corpus').cases
  res.case_count = cases.length
  for (const c of cases) res.expect_dist[c.expect] = (res.expect_dist[c.expect] || 0) + 1

  const tsOut = join(work, 'schema-ts.json')
  const pyOut = join(work, 'schema-py.json')
  const r1 = run([process.execPath, TS_IMPL, '--batch', SCHEMA_CORPUS, '--out', tsOut])
  if (!r1.ok) res.run_failures.push('TS schema batch: ' + (r1.error || `exit ${r1.status}`) + ' | ' + r1.stderr.slice(-200))
  const r2 = run([VENV, PY_IMPL, '--batch', SCHEMA_CORPUS, '--out', pyOut])
  if (!r2.ok) res.run_failures.push('PY schema batch: ' + (r2.error || `exit ${r2.status}`) + ' | ' + r2.stderr.slice(-200))

  let ts = [], py = [], fnd = [], fpy = []
  try { if (r1.ok) { const j = loadJson(tsOut, 'ts results'); ts = j.results; res.ts_side = j.side || 'ts' } } catch (e) { res.run_failures.push('TS schema results unreadable: ' + e.message) }
  try { if (r2.ok) { const j = loadJson(pyOut, 'py results'); py = j.results; res.py_side = j.side || 'py' } } catch (e) { res.run_failures.push('PY schema results unreadable: ' + e.message) }
  try { fnd = loadJson(SCHEMA_FROZEN_NODE, 'frozen node').results } catch (e) { res.run_failures.push('frozen node results unreadable: ' + e.message) }
  try { fpy = loadJson(SCHEMA_FROZEN_PY, 'frozen py').results } catch (e) { res.run_failures.push('frozen py results unreadable: ' + e.message) }

  const byId = (arr) => new Map(arr.map((x) => [x.id, x]))
  const tsM = byId(ts), pyM = byId(py), fndM = byId(fnd), fpyM = byId(fpy)
  const bothRan = r1.ok && r2.ok
  for (const c of cases) {
    const a = tsM.get(c.id), b = pyM.get(c.id)
    if (!a || !b) { if (bothRan) res.missing.push({ id: c.id, detail: `missing result: ts=${!!a} py=${!!b}` }); continue }
    if (a.valid !== b.valid) res.verdict_mismatches.push({ id: c.id, ts: a.valid, py: b.valid })
    if (a.core_valid !== b.core_valid) res.core_valid_mismatches.push({ id: c.id, ts: a.core_valid, py: b.core_valid })
    if (JSON.stringify(a.sem) !== JSON.stringify(b.sem)) res.sem_mismatches.push({ id: c.id, ts: a.sem, py: b.sem })
    if (JSON.stringify(a.c14n || []) !== JSON.stringify(b.c14n || [])) res.c14n_layer_mismatches.push({ id: c.id, ts: a.c14n, py: b.c14n })
    if (a.valid !== (c.expect === 'valid')) res.expect_mismatches.push({ id: c.id, expect: c.expect, ts_valid: a.valid, py_valid: b.valid })
    for (const [label, f] of [['node', fndM.get(c.id)], ['python', fpyM.get(c.id)]]) {
      if (f && (a.valid !== f.valid || JSON.stringify(a.sem) !== JSON.stringify(f.sem))) {
        res.frozen_mismatches.push({ id: c.id, side: label, ts_valid: a.valid, frozen_valid: f.valid, ts_sem: a.sem, frozen_sem: f.sem })
      }
    }
  }
  res.verdict_equal = res.verdict_mismatches.length === 0
  res.core_valid_equal = res.core_valid_mismatches.length === 0
  res.sem_equal = res.sem_mismatches.length === 0
  res.c14n_layer_equal = res.c14n_layer_mismatches.length === 0
  res.expect_equal = res.expect_mismatches.length === 0
  res.frozen_node_equal = res.frozen_py_equal = res.frozen_mismatches.length === 0
  return res
}

// ── 3) c14n corpus（58 例）双端 canonical 字节比对 ────────────────────────
function runC14nCorpus(work) {
  const res = {
    corpus: rel(C14N_CORPUS),
    case_count: 0,
    expect_dist: {},
    accept_count: 0,
    reject_count: 0,
    js_side: null,
    py_side: null,
    status_equal: false, status_mismatches: [],
    canonical_equal: false, canonical_mismatches: [],
    frozen_canonical_equal: false, frozen_canonical_mismatches: [],
    expect_equal: false, expect_mismatches: [],
    code_diff_warns: [],
    missing: [],
    run_failures: [],
  }
  const cases = loadJson(C14N_CORPUS, 'c14n corpus').cases
  res.case_count = cases.length
  for (const c of cases) res.expect_dist[c.expect] = (res.expect_dist[c.expect] || 0) + 1
  res.accept_count = res.expect_dist.accept || 0
  res.reject_count = res.expect_dist.reject || 0

  const env = { ...process.env, PACKET_ROOT: PACKET }
  const jsOut = join(work, 'c14n-js.json')
  const pyOut = join(work, 'c14n-py.json')
  const r1 = run([process.execPath, C14N_JS, '--batch', C14N_CORPUS, '--out', jsOut], { env, timeout: 120000 })
  if (!r1.ok) res.run_failures.push('JS c14n batch: ' + (r1.error || `exit ${r1.status}`) + ' | ' + r1.stderr.slice(-200))
  const r2 = run([VENV, C14N_PY, '--batch', C14N_CORPUS, '--out', pyOut], { env, timeout: 120000 })
  if (!r2.ok) res.run_failures.push('PY c14n batch: ' + (r2.error || `exit ${r2.status}`) + ' | ' + r2.stderr.slice(-200))

  let js = [], py = []
  try { if (r1.ok) { const j = loadJson(jsOut, 'c14n js results'); js = j.results; res.js_side = j.side || 'js' } } catch (e) { res.run_failures.push('JS c14n results unreadable: ' + e.message) }
  try { if (r2.ok) { const j = loadJson(pyOut, 'c14n py results'); py = j.results; res.py_side = j.side || 'py' } } catch (e) { res.run_failures.push('PY c14n results unreadable: ' + e.message) }

  const byId = (arr) => new Map(arr.map((x) => [x.id, x]))
  const jsM = byId(js), pyM = byId(py)
  const bothRan = r1.ok && r2.ok
  for (const c of cases) {
    const a = jsM.get(c.id), b = pyM.get(c.id)
    if (!a || !b) { if (bothRan) res.missing.push({ id: c.id, detail: `missing result: js=${!!a} py=${!!b}` }); continue }
    if (a.status !== b.status) res.status_mismatches.push({ id: c.id, js: a.status, py: b.status })
    if (a.status !== c.expect || b.status !== c.expect) res.expect_mismatches.push({ id: c.id, expect: c.expect, js: a.status, py: b.status })
    if (a.status === 'accept') {
      if (a.canonical !== b.canonical) res.canonical_mismatches.push({ id: c.id, js: a.canonical, py: b.canonical })
      if (c.canonical !== undefined && (a.canonical !== c.canonical || b.canonical !== c.canonical)) {
        res.frozen_canonical_mismatches.push({ id: c.id, frozen: c.canonical, js: a.canonical, py: b.canonical })
      }
    } else if (a.status === 'reject' && a.code !== b.code) {
      res.code_diff_warns.push({ id: c.id, js: a.code, py: b.code })
    }
  }
  res.status_equal = res.status_mismatches.length === 0
  res.canonical_equal = res.canonical_mismatches.length === 0
  res.frozen_canonical_equal = res.frozen_canonical_mismatches.length === 0
  res.expect_equal = res.expect_mismatches.length === 0
  return res
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
function conclude(env, schema, c14n) {
  const failures = []
  for (const f of schema.run_failures) failures.push('[schema] ' + f)
  for (const f of c14n.run_failures) failures.push('[c14n] ' + f)
  for (const m of schema.missing) failures.push(`[schema] ${m.id}: ${m.detail}`)
  for (const m of c14n.missing) failures.push(`[c14n] ${m.id}: ${m.detail}`)
  for (const m of schema.verdict_mismatches) failures.push(`[schema] verdict mismatch ${m.id}: ts=${m.ts} py=${m.py}`)
  for (const m of schema.core_valid_mismatches) failures.push(`[schema] core_valid mismatch ${m.id}: ts=${m.ts} py=${m.py}`)
  for (const m of schema.sem_mismatches) failures.push(`[schema] sem mismatch ${m.id}: ts=${JSON.stringify(m.ts)} py=${JSON.stringify(m.py)}`)
  for (const m of schema.c14n_layer_mismatches) failures.push(`[schema] c14n-layer mismatch ${m.id}: ts=${JSON.stringify(m.ts)} py=${JSON.stringify(m.py)}`)
  for (const m of schema.expect_mismatches) failures.push(`[schema] vs-expect mismatch ${m.id}: expect=${m.expect} ts=${m.ts_valid} py=${m.py_valid}`)
  for (const m of schema.frozen_mismatches) failures.push(`[schema] vs-frozen(${m.side}) mismatch ${m.id}: valid ${m.ts_valid}!=${m.frozen_valid} sem ${JSON.stringify(m.ts_sem)}!=${JSON.stringify(m.frozen_sem)}`)
  for (const m of c14n.status_mismatches) failures.push(`[c14n] status mismatch ${m.id}: js=${m.js} py=${m.py}`)
  for (const m of c14n.canonical_mismatches) failures.push(`[c14n] canonical mismatch ${m.id}: js=${m.js} py=${m.py}`)
  for (const m of c14n.expect_mismatches) failures.push(`[c14n] vs-expect mismatch ${m.id}: expect=${m.expect} js=${m.js} py=${m.py}`)
  for (const m of c14n.frozen_canonical_mismatches) failures.push(`[c14n] vs-frozen-canonical mismatch ${m.id}: frozen=${m.frozen} js=${m.js} py=${m.py}`)
  const warnings = []
  for (const m of c14n.code_diff_warns) warnings.push(`[c14n] reject code differs (warn) ${m.id}: js=${m.js} py=${m.py}`)
  if (env.python && env.python.probe_error) failures.push('[env] python version probe failed: ' + env.python.probe_error)
  const warningsEnv = env.evidence_deltas.map((d) => `[env] evidence delta ${d.key}: prior=${d.prior} now=${d.now}`)
  return { failures, warnings: [...warnings, ...warningsEnv] }
}

function now() {
  const d = new Date()
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  return { iso: d.toISOString(), date }
}

// ── Markdown 报告（全部数值来自本次运行数据）──────────────────────────────
function renderMarkdown(env, schema, c14n, conclusion, failures, warnings, meta) {
  const L = []
  const push = (s = '') => L.push(s)
  push(`# 双端 Conformance 报告（c14n + schema corpus + 环境版本）`)
  push()
  push(`- req_id：${REQ_ID}`)
  push(`- 日期：${meta.date}（生成时刻 UTC：${meta.iso}）`)
  push(`- 生成命令：\`${command}\``)
  push(`- 结论：**${conclusion}**（退出码 ${conclusion === 'PASS' ? 0 : 1}；双端全等 = PASS，任一不一致 = FAIL fail-closed）`)
  push()
  push(`## 1. 运行环境版本表（本次运行实测）`)
  push()
  push(`| 侧 | 组件 | 版本 |`)
  push(`| --- | --- | --- |`)
  push(`| node | node | ${env.node.version} |`)
  push(`| node | ICU | ${env.node.icu} |`)
  push(`| node | Unicode 数据版本（\`process.versions.unicode\`） | ${env.node.unicode} |`)
  push(`| node | V8 | ${env.node.v8} |`)
  push(`| node | ajv（\`node_modules/ajv\`） | ${env.ajv} |`)
  if (env.python && !env.python.probe_error) {
    push(`| python | python | ${env.python.python} |`)
    push(`| python | 平台 | ${env.python.platform} |`)
    push(`| python | Unicode 数据版本（\`unicodedata.unidata_version\`） | ${env.python.unidata} |`)
    push(`| python | jsonschema | ${env.python.jsonschema} |`)
    push(`| python | referencing | ${env.python.referencing} |`)
  } else {
    push(`| python | （版本探测失败） | ${env.python ? env.python.probe_error : 'n/a'} |`)
  }
  push(`| 平台 | node \`${env.node.platform}\`/${env.node.arch} · python \`${env.python && !env.python.probe_error ? env.python.platform : 'n/a'}\` | |`)
  push()
  if (env.evidence_file) {
    push(`> 与既有证据记录 \`${env.evidence_file}\`（2026-10-13）对比：`)
    if (env.evidence_deltas.length === 0) {
      push(`> 全部版本一致，无差异。`)
    } else {
      for (const d of env.evidence_deltas) push(`> 差异：**${d.key}** 记录 ${d.prior} → 本次实测 ${d.now}。`)
    }
    push()
  }
  push(`## 2. schema corpus（${schema.case_count} 例）双端一致性`)
  push()
  push(`- 语料：\`${schema.corpus}\`（${schema.case_count} 例；期望分布：${Object.entries(schema.expect_dist).map(([k, v]) => `${k} ${v}`).join(' / ')}）`)
  push(`- TS 侧：\`node ${rel(TS_IMPL)} --batch\`（${schema.ts_side}，ajv ${env.ajv}）`)
  push(`- PY 侧：\`python ${rel(PY_IMPL)} --batch\`（${schema.py_side}，jsonschema ${env.python ? env.python.jsonschema : 'n/a'}）`)
  push(`- 判定（valid/invalid）双端全等：${schema.verdict_equal ? '是' : '否'}（不一致 ${schema.verdict_mismatches.length} 例${schema.verdict_mismatches.length ? '，见下' : ''}）`)
  push(`- core_valid 双端全等：${schema.core_valid_equal ? '是' : '否'}（不一致 ${schema.core_valid_mismatches.length} 例）`)
  push(`- sem 双端全等：${schema.sem_equal ? '是' : '否'}（不一致 ${schema.sem_mismatches.length} 例）`)
  push(`- c14n 层双端全等：${schema.c14n_layer_equal ? '是' : '否'}（不一致 ${schema.c14n_layer_mismatches.length} 例）`)
  push(`- vs 语料期望全等：${schema.expect_equal ? '是' : '否'}（不一致 ${schema.expect_mismatches.length} 例）`)
  push(`- vs packet 冻结结果（node/python 双侧）全等：${schema.frozen_node_equal && schema.frozen_py_equal ? '是' : '否'}（不一致 ${schema.frozen_mismatches.length} 例）`)
  push(`- 不一致清单：${schema.verdict_mismatches.length + schema.core_valid_mismatches.length + schema.sem_mismatches.length + schema.c14n_layer_mismatches.length + schema.expect_mismatches.length + schema.frozen_mismatches.length === 0 ? '**空**' : ''}`)
  for (const [label, list] of [
    ['判定不一致', schema.verdict_mismatches], ['core_valid 不一致', schema.core_valid_mismatches],
    ['sem 不一致', schema.sem_mismatches], ['c14n 层不一致', schema.c14n_layer_mismatches],
    ['vs 期望不一致', schema.expect_mismatches], ['vs 冻结不一致', schema.frozen_mismatches],
  ]) {
    if (list.length) { push(`  - ${label}：`); for (const m of list) push(`    - \`${JSON.stringify(m)}\``) }
  }
  push()
  push(`## 3. c14n corpus（${c14n.case_count} 例）双端一致性`)
  push()
  push(`- 语料：\`${c14n.corpus}\`（${c14n.case_count} 例；期望分布：accept ${c14n.accept_count} / reject ${c14n.reject_count}）`)
  push(`- JS 侧：\`node ${rel(C14N_JS)} --batch\`（${c14n.js_side}）`)
  push(`- PY 侧：\`python ${rel(C14N_PY)} --batch\`（${c14n.py_side}）`)
  push(`- 判定（accept/reject）双端全等：${c14n.status_equal ? '是' : '否'}（不一致 ${c14n.status_mismatches.length} 例${c14n.status_mismatches.length ? '，见下' : ''}）`)
  push(`- canonical 字节双端全等（accept ${c14n.accept_count} 例）：${c14n.canonical_equal ? '是' : '否'}（不一致 ${c14n.canonical_mismatches.length} 例${c14n.canonical_mismatches.length ? '，见下' : ''}）`)
  push(`- vs 语料期望（status）全等：${c14n.expect_equal ? '是' : '否'}（不一致 ${c14n.expect_mismatches.length} 例）`)
  push(`- vs 冻结 canonical 全等：${c14n.frozen_canonical_equal ? '是' : '否'}（不一致 ${c14n.frozen_canonical_mismatches.length} 例）`)
  push(`- reject code 双端差异（warn，不阻断）：${c14n.code_diff_warns.length} 例`)
  push(`- 不一致清单：${c14n.status_mismatches.length + c14n.canonical_mismatches.length + c14n.expect_mismatches.length + c14n.frozen_canonical_mismatches.length === 0 ? '**空**' : ''}`)
  for (const [label, list] of [
    ['判定不一致', c14n.status_mismatches], ['canonical 不一致', c14n.canonical_mismatches],
    ['vs 期望不一致', c14n.expect_mismatches], ['vs 冻结 canonical 不一致', c14n.frozen_canonical_mismatches],
    ['reject code 差异（warn）', c14n.code_diff_warns],
  ]) {
    if (list.length) { push(`  - ${label}：`); for (const m of list) push(`    - \`${JSON.stringify(m)}\``) }
  }
  push()
  push(`## 4. 失败 / 警告明细`)
  if (failures.length) { push(`- 失败（${failures.length}）：`); for (const f of failures) push(`  - ${f}`) } else { push('- 失败：无') }
  if (warnings.length) { push(`- 警告（${warnings.length}）：`); for (const w of warnings) push(`  - ${w}`) } else { push('- 警告：无') }
  push()
  push(`## 5. 方法 / 边界披露`)
  push()
  push(`- 复跑命令：\`${command}\`（重跑即重新生成本报告与 JSON）`)
  push(`- fail-closed 判定：双端任一不一致（判定 / sem / canonical 字节 / vs 语料期望 / vs packet 冻结结果）或任一运行失败、结果缺失 → 结论 FAIL、退出码 1；c14n reject code 双端差异与既有证据记录的环境版本差异仅警告不阻断。`)
  push(`- Unicode 数据版本不对称：node ICU ${env.node.icu}（Unicode ${env.node.unicode}）vs python unicodedata ${env.python ? env.python.unidata : 'n/a'}；本报告的全等结论仅对该环境组合成立，任一版本变化需重跑。`)
  push(`- 范围：本次运行只新增本报告与 \`scripts/conformance-report.mjs\`；未修改 \`design/packet\`、\`design/acceptance*\`、\`design/capability-policy\` 字节，未改动既有测试与实现，未执行 git 操作。`)
  return L.join('\n') + '\n'
}

// ── 人类可读摘要 ───────────────────────────────────────────────────────────
function printSummary(env, schema, c14n, conclusion, failures, warnings, outFile, repFile) {
  const lines = []
  lines.push(`conformance-report: ${conclusion}`)
  lines.push(`  schema corpus (${schema.case_count}): verdict ${schema.verdict_equal ? '=' : '!='} (${schema.verdict_mismatches.length} mm) | sem ${schema.sem_equal ? '=' : '!='} (${schema.sem_mismatches.length} mm) | expect ${schema.expect_equal ? '=' : '!='} | frozen ${schema.frozen_node_equal && schema.frozen_py_equal ? '=' : '!='}`)
  lines.push(`  c14n corpus (${c14n.case_count}): status ${c14n.status_equal ? '=' : '!='} (${c14n.status_mismatches.length} mm) | canonical ${c14n.canonical_equal ? '=' : '!='} (${c14n.canonical_mismatches.length} mm) | expect ${c14n.expect_equal ? '=' : '!='} | code-warns ${c14n.code_diff_warns.length}`)
  lines.push(`  env: node ${env.node.version} (unicode ${env.node.unicode} / icu ${env.node.icu}) | ajv ${env.ajv} | python ${env.python && !env.python.probe_error ? env.python.python + ' (unidata ' + env.python.unidata + ', jsonschema ' + env.python.jsonschema + ')' : 'probe failed'} | ${env.node.platform}/${env.node.arch}`)
  if (env.evidence_deltas.length) lines.push(`  evidence deltas: ${env.evidence_deltas.map((d) => `${d.key} ${d.prior}->${d.now}`).join(', ')}`)
  if (failures.length) { lines.push('  failures:'); for (const f of failures) lines.push('    - ' + f) }
  if (warnings.length) { lines.push('  warnings:'); for (const w of warnings) lines.push('    - ' + w) }
  if (outFile) lines.push(`  out: ${relc(outFile)}`)
  if (repFile) lines.push(`  report: ${relc(repFile)}`)
  return lines.join('\n')
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const work = mkdtempSync(join(tmpdir(), 'conformance-e2-'))
  const meta = now()
  const env = collectEnvironment()
  const schema = runSchemaCorpus(work)
  const c14n = runC14nCorpus(work)
  const { failures, warnings } = conclude(env, schema, c14n)
  const conclusion = failures.length === 0 ? 'PASS' : 'FAIL'
  const report = {
    req_id: REQ_ID,
    title: 'dual-end conformance report (c14n + schema corpus + environment versions)',
    generated_at: meta.iso,
    date: meta.date,
    command,
    environment: env,
    schema_corpus: schema,
    c14n_corpus: c14n,
    conclusion,
    failures,
    warnings,
  }
  rmSync(work, { recursive: true, force: true })

  let outFile = null, repFile = null
  if (outPath) {
    outFile = outPath
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  }
  if (reportPath) {
    repFile = reportPath
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, renderMarkdown(env, schema, c14n, conclusion, failures, warnings, meta), 'utf8')
  }

  const summary = printSummary(env, schema, c14n, conclusion, failures, warnings, outFile, repFile)
  if (outPath) {
    console.log(summary)
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.stderr.write(summary + '\n')
  }
  process.exitCode = conclusion === 'PASS' ? 0 : 1
}

main()
