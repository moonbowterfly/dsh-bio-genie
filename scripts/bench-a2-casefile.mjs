#!/usr/bin/env node
/**
 * bench-a2-casefile.mjs — A2 casefile 库基准（协议 v1，见 design/benchmarks/a2-benchmark-protocol.md）
 *
 * 场景（默认重复数 / 预热 1 次，预热不计入统计）：
 *   S1 单工件事务提交  : commitTransaction(1 artifact)   × 50，每次全新 case
 *   S2 多工件事务提交  : commitTransaction(10 artifacts) × 20，每次全新 case
 *   S3 快照读取        : loadSnapshot(既有快照)           × 200
 *   S4 GC 扫描         : gcOrphans(dryRun) + gcOrphans()  × 10（每次构造 ~100 对象 + 2 快照 + 残留）
 *   S5 锁获取/释放     : acquireCaseLock + releaseCaseLock × 100（额外场景：锁是每次提交的固定开销）
 *
 * 用法：
 *   node scripts/bench-a2-casefile.mjs                 # 人类可读摘要表 + JSON
 *   node scripts/bench-a2-casefile.mjs --json          # 仅 JSON（机器可读）
 *   node scripts/bench-a2-casefile.mjs --out <file>    # JSON 另存到文件
 *   node scripts/bench-a2-casefile.mjs --repeat <n>    # 覆盖全部场景重复数
 *
 * 退出码：0 = 跑完（无性能硬门——退化判定属人/复核流程）；非 0 = 用法错误/操作失败/断言失败。
 * 纪律：只在系统临时目录建工作区（自清理）；不写仓库任何文件；无 git 写操作。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireCaseLock, commitTransaction, deriveCaseContentId, ensureCaseDir, gcOrphans,
  loadSnapshot, releaseCaseLock, writeSnapshot,
} from '../src/design-casefile.js'
import { validateDesignArtifact } from '../src/design-validate.js'

const BENCH_SCRIPT_VERSION = '1.0.1'
const REPO_ROOT = join(import.meta.dirname, '..')

// 所有场景工作区挂在共享根下（main 中创建，finally 中整体自清理）
let BENCH_ROOT = null

// ── 固定输入（冻结于协议 v1；全部来自仓库语料，确定性、无随机）─────────────────
const CORPUS = JSON.parse(
  readFileSync(join(REPO_ROOT, 'design', 'packet', 'schema-corpus', 'schema_cases.json'), 'utf8'),
)
function findCase(id) {
  const c = CORPUS.cases.find((x) => x.id === id)
  if (!c) throw new Error('corpus case not found: ' + id)
  return c
}

const POLICY = { policy_id: 'design-capability-policy', policy_version: '0', policy_hash: 'b'.repeat(64) }

// S1 夹具：1 工件（host_profile）
const FIX_S1 = () => [{ type: 'host_profile', value: findCase('hpf-01').doc, producer: 'bench', canonical_path: 'host.json' }]

// S2 夹具：10 工件（10 个不同合法类型；顺序固定）
const FIX_S2 = () => [
  { type: 'genome_ref', value: findCase('gvr-01').doc, producer: 'bench', canonical_path: 'genome.json' },
  { type: 'host_profile', value: findCase('hpf-01').doc, producer: 'bench', canonical_path: 'host.json' },
  { type: 'condition_card', value: findCase('ccd-01').doc, producer: 'bench', canonical_path: 'condition.json' },
  { type: 'evidence_item', value: findCase('evi-01').doc, producer: 'bench', canonical_path: 'evidence.json' },
  { type: 'metabolic_model_ref', value: findCase('mmr-01').doc, producer: 'bench', canonical_path: 'gem.json' },
  { type: 'coupling_profile', value: findCase('cpl-01').doc, producer: 'bench', canonical_path: 'coupling.json' },
  { type: 'circuit_design', value: findCase('cir-01').doc, producer: 'bench', canonical_path: 'circuit.json' },
  { type: 'kinetic_crn_ref', value: findCase('kcr-01').doc, producer: 'bench', canonical_path: 'kinetic.json' },
  { type: 'integration_candidate', value: findCase('itc-01').doc, producer: 'bench', canonical_path: 'integration.json' },
  { type: 'expression_scenario', value: findCase('exs-01').doc, producer: 'bench', canonical_path: 'expression.json' },
]

// ── CLI ─────────────────────────────────────────────────────────────
const USAGE = 'usage: node scripts/bench-a2-casefile.mjs [--json] [--out <file>] [--repeat <n>]'
const DEFAULTS = { S1: 50, S2: 20, S3: 200, S4: 10, S5: 100 }

function parseArgs(argv) {
  const opts = { json: false, out: null, repeat: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--repeat') {
      const v = Number(argv[++i])
      if (!Number.isInteger(v) || v < 1) throw new Error('--repeat 需要正整数')
      opts.repeat = v
    } else throw new Error('未知参数: ' + a + '\n' + USAGE)
  }
  return opts
}

// ── 统计（wall time，ms；nearest-rank 分位）──────────────────────────
function stats(durs) {
  const s = [...durs].sort((a, b) => a - b)
  const n = s.length
  const mean = s.reduce((x, y) => x + y, 0) / n
  const pct = (p) => s[Math.min(n - 1, Math.ceil((n * p) / 100) - 1)]
  return { n, mean: round(mean), p50: round(pct(50)), p95: round(pct(95)), samples: durs.map(round) }
}
const round = (x) => Math.round(x * 100) / 100

// ── 环境 ────────────────────────────────────────────────────────────
function gitHead() {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
    if (r.status === 0) return { commit: String(r.stdout || '').trim(), dirty: gitDirty() }
  } catch { /* best effort */ }
  return { commit: 'unknown', dirty: null }
}
function gitDirty() {
  try {
    const r = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
    if (r.status === 0) return String(r.stdout || '').trim().length > 0
  } catch { /* best effort */ }
  return null
}
function environment(os) {
  const cpu = os.cpus()
  return {
    node: process.version,
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu_model: cpu && cpu[0] ? cpu[0].model : 'unknown',
    cpu_count: cpu ? cpu.length : 0,
    tmpdir: os.tmpdir(),
    date_utc: new Date().toISOString(),
    script_version: BENCH_SCRIPT_VERSION,
    ...gitHead(),
  }
}

// ── 场景 ────────────────────────────────────────────────────────────
async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(String(e.message))
    process.exit(1)
  }
  const os = await import('node:os')
  const repeat = (k) => (opts.repeat === null ? DEFAULTS[k] : opts.repeat)
  BENCH_ROOT = mkdtempSync(join(os.tmpdir(), 'a2-bench-'))

  // 启动断言：夹具合法 + content id 派生成功（固定输入 → 确定性）
  const contentId = deriveCaseContentId({
    rootInputArtifactIds: ['a'.repeat(64), 'b'.repeat(64)],
    policyVersion: '0',
    canonicalParams: { capability_policy: 'design-capability-policy@0', design_tier: 'reference_profile' },
  })
  if (!contentId.ok) {
    console.error('FATAL deriveCaseContentId: ' + JSON.stringify(contentId))
    process.exit(1)
  }
  for (const a of [...FIX_S1(), ...FIX_S2()]) {
    const v = validateDesignArtifact(a.type, a.value)
    if (!v.ok) {
      console.error('FATAL 夹具校验失败 ' + a.type + ': ' + JSON.stringify(v.errors ? v.errors.slice(0, 2) : v))
      process.exit(1)
    }
  }

  const results = {}
  let totalT0 = performance.now()
  try {
    // S1 / S2：每次全新 case 的完整六步提交
    for (const [key, fixtures, cnt] of [
      ['S1_single_artifact_commit', FIX_S1, repeat('S1')],
      ['S2_multi_artifact_commit_10', FIX_S2, repeat('S2')],
    ]) {
      const warm = fixtures()
      results[key] = await runCommitScenario(key, fixtures, cnt, warm, contentId)
    }
    // S3：快照读取（setup 一次真实提交，读 200 次同一快照）
    {
      const h = freshCase('s3-setup')
      const tx = commitTransaction(h.handle, {
        caseContentId: contentId.case_content_id, policy: POLICY, newArtifacts: FIX_S1(),
      })
      if (!tx.ok) throw new Error('S3 setup commit failed: ' + JSON.stringify(tx).slice(0, 200))
      const sha = tx.snapshot_sha
      loadSnapshot(h.handle.snapshotsDir, sha) // 预热 1 次
      const durs = []
      for (let i = 0; i < repeat('S3'); i += 1) {
        const t0 = performance.now()
        const snap = loadSnapshot(h.handle.snapshotsDir, sha)
        if (!snap.ok) throw new Error('S3 loadSnapshot failed: ' + JSON.stringify(snap).slice(0, 200))
        durs.push(performance.now() - t0)
      }
      results.S3_snapshot_read = { ...stats(durs), snapshot_sha: sha, snapshot_bytes: statSync(join(h.handle.snapshotsDir, sha + '.json')).size }
    }
    // S4：GC 扫描（dryRun + 实删对照；每次构造 ~100 对象 + 2 快照 + tmp/staging 残留）
    {
      const fixture = buildGcFixture(contentId.case_content_id)
      const dry = [], real = []
      for (let i = 0; i < repeat('S4'); i += 1) {
        const h = freshCase('s4-rep-' + i)
        materializeGcFixture(h.handle, fixture)
        const t0 = performance.now()
        const g1 = gcOrphans(h.handle, { dryRun: true })
        if (!g1.ok) throw new Error('S4 gc dryRun failed: ' + JSON.stringify(g1).slice(0, 200))
        dry.push(performance.now() - t0)
        const t1 = performance.now()
        const g2 = gcOrphans(h.handle)
        if (!g2.ok) throw new Error('S4 gc failed: ' + JSON.stringify(g2).slice(0, 200))
        real.push(performance.now() - t1)
        assertGcRemoval(g1, g2, h.handle)
      }
      results.S4_gc_scan_dryRun = { ...stats(dry), fixture: fixture.summary }
      results.S4_gc_scan_real = { ...stats(real), fixture: fixture.summary }
    }
    // S5：锁获取/释放（每次全新 case；无竞争）
    {
      const h0 = freshCase('s5-warm')
      acquireCaseLock(h0.handle.caseDir); releaseCaseLock(h0.handle.caseDir)
      const durs = []
      for (let i = 0; i < repeat('S5'); i += 1) {
        const h = freshCase('s5-rep-' + i)
        const t0 = performance.now()
        const a = acquireCaseLock(h.handle.caseDir)
        if (!a.ok) throw new Error('S5 acquire failed: ' + JSON.stringify(a).slice(0, 200))
        const r = releaseCaseLock(h.handle.caseDir)
        if (!r.ok) throw new Error('S5 release failed: ' + JSON.stringify(r).slice(0, 200))
        durs.push(performance.now() - t0)
      }
      results.S5_lock_acquire_release = { ...stats(durs) }
    }
  } finally {
    try { rmSync(BENCH_ROOT, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  const env = environment(os)
  const out = {
    protocol: 'design/benchmarks/a2-benchmark-protocol.md',
    baseline_file: 'design/benchmarks/a2-benchmark-baseline.json',
    environment: env,
    defaults: DEFAULTS,
    repeat_override: opts.repeat,
    scenarios: results,
    total_wall_ms: round(performance.now() - totalT0),
    note: '退出码 0 仅表示跑完；退化判定见协议 §通过/退化标准（人/复核流程）。',
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  } else {
    printSummary(out)
    process.stdout.write('\n--- machine json ---\n')
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  }
  if (opts.out) writeFileSync(opts.out, JSON.stringify(out, null, 2) + '\n', 'utf8')
  process.exit(0)
}

// ── 工具 ────────────────────────────────────────────────────────────
function freshCase(label) {
  if (!BENCH_ROOT) throw new Error('BENCH_ROOT not initialized')
  const root = mkdtempSync(join(BENCH_ROOT, label + '-'))
  const handle = ensureCaseDir(root, 'case-' + label.replace(/[^A-Za-z0-9-]/g, '-'))
  if (!handle.ok) throw new Error('ensureCaseDir failed: ' + JSON.stringify(handle).slice(0, 200))
  return { root, handle }
}

async function runCommitScenario(key, fixtures, cnt, warmFixtures, contentId) {
  // 预热 1 次（不计入）
  {
    const h = freshCase(key + '-warm')
    const tx = commitTransaction(h.handle, {
      caseContentId: contentId.case_content_id, policy: POLICY, newArtifacts: warmFixtures,
    })
    if (!tx.ok) throw new Error(key + ' warmup failed: ' + JSON.stringify(tx).slice(0, 200))
  }
  const durs = []
  for (let i = 0; i < cnt; i += 1) {
    const h = freshCase(key + '-' + i)
    const t0 = performance.now()
    const tx = commitTransaction(h.handle, {
      caseContentId: contentId.case_content_id, policy: POLICY, newArtifacts: fixtures(),
    })
    if (!tx.ok) throw new Error(key + ' commit failed: ' + JSON.stringify(tx).slice(0, 200))
    durs.push(performance.now() - t0)
  }
  return { ...stats(durs), artifacts_per_tx: fixtures().length }
}

function buildGcFixture(contentId) {
  const f = freshCase('gc-fixture')
  const objects = []
  const referenced = []
  for (let i = 0; i < 100; i += 1) {
    const bytes = Buffer.from('{"bench":true,"n":' + i + '}', 'utf8')
    const sha = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(join(f.handle.objectsDir, sha), bytes)
    objects.push(sha)
    if (i < 60) referenced.push(sha)
  }
  const snap1 = writeSnapshot({
    snapshotsDir: f.handle.snapshotsDir,
    manifest: {
      schema_version: '1.0', case_content_id: contentId,
      artifacts: referenced.slice(0, 30).map((sha) => ({ artifact_id: sha, type: 'host_profile@1', inputs: [], producer: 'bench', schema_major: '1', canonical_path: 'host.json' })),
      policy: POLICY,
    },
    validate: (m) => validateDesignArtifact('case_manifest', m),
  })
  if (!snap1.ok) throw new Error('S4 fixture snapshot1 failed: ' + JSON.stringify(snap1).slice(0, 200))
  const snap2 = writeSnapshot({
    snapshotsDir: f.handle.snapshotsDir,
    manifest: {
      schema_version: '1.0', case_content_id: contentId,
      artifacts: referenced.slice(30, 60).map((sha) => ({ artifact_id: sha, type: 'genome_ref@1', inputs: [], producer: 'bench', schema_major: '1', canonical_path: 'genome.json' })),
      policy: POLICY,
    },
    validate: (m) => validateDesignArtifact('case_manifest', m),
  })
  if (!snap2.ok) throw new Error('S4 fixture snapshot2 failed: ' + JSON.stringify(snap2).slice(0, 200))
  const snapshotBytes = [readFileSync(snap1.path), readFileSync(snap2.path)]
  return {
    objectBytes: objects.map((sha) => ({ sha, bytes: readFileSync(join(f.handle.objectsDir, sha)) })),
    snapshotNames: [snap1.snapshot_sha + '.json', snap2.snapshot_sha + '.json'],
    snapshotBytes,
    summary: { objects_total: 100, referenced: 60, orphans: 40, snapshots: 2, tmp_files: 3, staging_dirs: 1 },
  }
}

function materializeGcFixture(handle, fixture) {
  for (const o of fixture.objectBytes) writeFileSync(join(handle.objectsDir, o.sha), o.bytes)
  for (let i = 0; i < 3; i += 1) writeFileSync(join(handle.objectsDir, 'dead' + i + '.tmp-bench'), 'x')
  for (let i = 0; i < 2; i += 1) writeFileSync(join(handle.snapshotsDir, fixture.snapshotNames[i]), fixture.snapshotBytes[i])
  mkdirSync(join(handle.caseDir, 'staging', 'dead-tx'), { recursive: true })
  writeFileSync(join(handle.caseDir, 'staging', 'dead-tx', 'leftover.bin'), 'x')
}

function assertGcRemoval(g1, g2, handle) {
  const orphanCount = (g) => g.removed.filter((x) => x.startsWith('object:')).length
  if (!(orphanCount(g1) === 40 && orphanCount(g2) === 40)) {
    throw new Error('S4 GC 移除数不符（期望 40）: dry=' + orphanCount(g1) + ' real=' + orphanCount(g2))
  }
  if (!g2.removed.some((x) => x.startsWith('tmp:')) || !g2.removed.some((x) => x === 'staging:dead-tx')) {
    throw new Error('S4 GC 未清理残留: ' + JSON.stringify(g2.removed.slice(0, 5)))
  }
  if (g2.kept !== 60) throw new Error('S4 GC kept 不符（期望 60）: ' + g2.kept)
  if (g1.dryRun !== true || g2.dryRun !== false) throw new Error('S4 dryRun 语义异常')
}

function printSummary(out) {
  const s = out.scenarios
  const rows = [
    ['S1 单工件事务提交', 'S1_single_artifact_commit'],
    ['S2 多工件事务提交(10)', 'S2_multi_artifact_commit_10'],
    ['S3 快照读取', 'S3_snapshot_read'],
    ['S4 GC 扫描 dryRun', 'S4_gc_scan_dryRun'],
    ['S4 GC 扫描 实删', 'S4_gc_scan_real'],
    ['S5 锁 获取/释放', 'S5_lock_acquire_release'],
  ]
  process.stdout.write('A2 casefile 基准 v' + out.environment.script_version + '  ' + out.environment.date_utc + '\n')
  process.stdout.write('node ' + out.environment.node + '  ' + out.environment.platform + '/' + out.environment.arch + '  commit ' + out.environment.commit + (out.environment.dirty ? ' (dirty)' : '') + '\n')
  process.stdout.write('-'.repeat(96) + '\n')
  for (const [label, key] of rows) {
    const v = s[key]
    process.stdout.write(
      '  ' + label.padEnd(24) +
      'n=' + String(v.n).padStart(4) +
      '  mean=' + String(v.mean).padStart(9) + 'ms' +
      '  p50=' + String(v.p50).padStart(9) + 'ms' +
      '  p95=' + String(v.p95).padStart(9) + 'ms\n',
    )
  }
  process.stdout.write('-'.repeat(96) + '\n')
  process.stdout.write('total wall: ' + out.total_wall_ms + ' ms\n')
}

main().catch((e) => {
  console.error('FATAL: ' + (e && e.stack ? e.stack : String(e)))
  process.exit(1)
})
