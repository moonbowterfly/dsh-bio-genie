// design-replay-probe.mjs — M0 deterministic replay 门（req G-LOOP-20261015-E3-001）
// 规格：spec v0.3 §4.1（canonical 序列化必须剥离/拒绝 runtime metadata，如
//       provenance.js:96 注入的 _provenance.at，只进 receipt）+ §8 M0（不同临时目录/
//       启动时间两跑：canonical + content hashes 相同；receipt 可异）。
// 覆盖：
//   1) valid 纯度：fixture valid[] 全样本过系统扫描器（src/design-casefile.js
//      scanRuntimeMetadata）干净；
//   2) 双跑确定性：对 valid[] 各样本在**两次独立子进程**（不同启动时间；
//      canonicalizeViaPacket 每次 mkdtemp 不同临时目录）跑 canonical + content id
//      （manifest 形态样本加 snapshot sha）→ 逐位相同；
//   3) invalid 拒绝：invalid[] 各样本经系统路径（canonicalizeViaPacket /
//      deriveCaseContentId）必须被拒且码为 DETERMINISM_VIOLATION。
// 通过态不打印 DETERMINISM_VIOLATION（避免污染 runner 击杀判定）；失败态 exit 非零。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalizeViaPacket, deriveCaseContentId, computeSnapshotSha, scanRuntimeMetadata,
} from '../src/design-casefile.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FX_PATH = join(ROOT, 'test', 'fixtures', 'design', 'replay-probe-input.json')
const FX = JSON.parse(readFileSync(FX_PATH, 'utf8'))
const ANCHOR = '"title": "REPLAY_PROBE_PURE_MARKER"'
// 注入片段（与 design/mutation-matrix.json#M0 的 new 一致）：锚点后追加顶层
// runtime metadata 键，保持 fixture JSON 合法。
const INJECTED = '"title": "REPLAY_PROBE_PURE_MARKER", "_provenance": { "at": "2025-01-01T00:00:00Z" }'

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

// ── fixture 完整性 ──────────────────────────────────────────────────
{
  const raw = readFileSync(FX_PATH, 'utf8')
  check('fixture: valid[] ≥2 且 invalid[] ≥3', FX.valid?.length >= 2 && FX.invalid?.length >= 3,
    'valid=' + FX.valid?.length + ' invalid=' + FX.invalid?.length)
  check('fixture: 锚点唯一（"title": "REPLAY_PROBE_PURE_MARKER" 全文件恰 1 次）',
    (raw.match(/REPLAY_PROBE_PURE_MARKER/g) || []).length === 1)
  const injected = raw.replace(ANCHOR, INJECTED)
  let injectedOk = true
  try { JSON.parse(injected) } catch { injectedOk = false }
  check('fixture: 注入后仍为合法 JSON（runner replace_text 片段自洽）', injectedOk)
}

// ── 1) valid 纯度：系统扫描器全样本干净 ─────────────────────────────
{
  const tainted = []
  for (const s of FX.valid) {
    const hits = scanRuntimeMetadata(JSON.parse(JSON.stringify(s)))
    if (hits.length > 0) tainted.push(s.id + ':' + hits.join(','))
  }
  check('valid 纯度：valid[] 全样本过扫描器零命中（污染 → 门红 + DETERMINISM_VIOLATION）',
    tainted.length === 0, tainted.join('|'))
}

// ── 2) 双跑确定性：两次独立子进程 canonical/content id/snapshot sha 逐位相同 ──
{
  const work = mkdtempSync(join(tmpdir(), 'design-replay-probe-'))
  try {
    const worker = join(work, 'worker.mjs')
    const srcUrl = 'file://' + join(ROOT, 'src', 'design-casefile.js').replaceAll('\\', '/')
    writeFileSync(worker, `
import { createHash } from 'node:crypto'
import { canonicalizeViaPacket, deriveCaseContentId, computeSnapshotSha } from ${JSON.stringify(srcUrl)}
const s = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'))
const out = { id: s.id }
if (s.id === 'pure-manifest-1') {
  // manifest 形态：canonical 由 computeSnapshotSha 内部注解（case_manifest 注解派生）
  const ss = computeSnapshotSha(JSON.parse(JSON.stringify(s.doc)))
  out.canonical_ok = ss.ok
  out.canonical = ss.ok ? ss.canonical_without : String(ss.problems || '')
  out.snapshot_sha = ss.ok ? ss.snapshot_sha : null
} else {
  const canon = canonicalizeViaPacket(JSON.stringify(s.doc), {})
  out.canonical_ok = canon.ok
  out.canonical = canon.ok ? canon.canonical : canon.code
  out.snapshot_sha = null
}
const cid = deriveCaseContentId({
  rootInputArtifactIds: s.root_input_artifact_ids || [],
  policyVersion: s.policy_version || '1',
  canonicalParams: s.canonical_params || {},
})
out.cid_ok = cid.ok
out.content_id = cid.ok ? cid.case_content_id : String(cid.problems || '')
out.canonical_sha = out.canonical_ok ? createHash('sha256').update(out.canonical).digest('hex') : null
console.log(JSON.stringify(out))
`)
    const runOnce = (sample, seed) => {
      const r = spawnSync(process.execPath, [worker, Buffer.from(JSON.stringify(sample)).toString('base64')],
        { encoding: 'utf8', cwd: ROOT, timeout: 120000, env: { ...process.env, DSH_REPLAY_PROBE_SEED: String(seed) } })
      let parsed = null
      try { parsed = JSON.parse(r.stdout) } catch { /* asserted below */ }
      return { status: r.status, parsed, stderr: String(r.stderr || '') }
    }
    for (const s of FX.valid) {
      const a = runOnce(s, 'first-run')
      check('双跑确定性：' + s.id + ' 第一跑 worker 正常（canonical/content id 可求）',
        a.status === 0 && a.parsed?.canonical_ok === true && a.parsed?.cid_ok === true,
        'status=' + a.status + ' stderr=' + a.stderr.slice(-160) + ' out=' + JSON.stringify(a.parsed).slice(0, 140))
      const b = runOnce(s, 'second-run')
      check('双跑确定性：' + s.id + ' 第二跑 worker 正常',
        b.status === 0 && b.parsed?.canonical_ok === true && b.parsed?.cid_ok === true,
        'status=' + b.status + ' stderr=' + b.stderr.slice(-160))
      check('双跑确定性：' + s.id + ' 两次独立子进程输出逐位相同（分叉 → 门红 + DETERMINISM_VIOLATION）',
        JSON.stringify(a.parsed) === JSON.stringify(b.parsed),
        'runA=' + JSON.stringify(a.parsed).slice(0, 200) + ' runB=' + JSON.stringify(b.parsed).slice(0, 200))
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ── 3) invalid 拒绝：系统路径必须 DETERMINISM_VIOLATION ─────────────
{
  for (const s of FX.invalid) {
    const canon = canonicalizeViaPacket(JSON.stringify(s), {})
    check('invalid 拒绝：' + s.id + ' 经 canonicalizeViaPacket 拒绝 DETERMINISM_VIOLATION',
      canon.ok === false && canon.code === 'DETERMINISM_VIOLATION', JSON.stringify(canon))
    if (s.canonical_params) {
      // canonical_params 污染向量：deriveCaseContentId 组装 doc 后经 canonicalizeViaPacket 拒绝
      const cid = deriveCaseContentId({
        rootInputArtifactIds: s.root_input_artifact_ids || [],
        policyVersion: s.policy_version || '1',
        canonicalParams: s.canonical_params,
      })
      check('invalid 拒绝：' + s.id + ' 经 deriveCaseContentId 拒绝 DETERMINISM_VIOLATION',
        cid.ok === false && String(cid.problems || '').includes('DETERMINISM_VIOLATION'),
        JSON.stringify(cid))
    }
  }
}

console.log('design-replay-probe: %d passed, %d failed', pass, fail)
process.exit(fail === 0 ? 0 : 1)
