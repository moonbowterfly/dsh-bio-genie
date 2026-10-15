/**
 * dsh-bio-genie — 工具层（合并版）
 *
 * 分层策略：
 *  - bio_python  — 任意代码执行器（兜底长尾 Biopython 功能，覆盖 100%）
 *  - bio_env     — 环境诊断/重建
 *  - bio_* 语义化工具 — 高频稳定操作（省 token、参数校验、结构化输出）
 *
 * @module dsh-bio-genie/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureEnvironment, venvPython, resolveEnvDir, ensureExtraDeps } from './runtime.js'
import { runBridge, callBio, spawnPython } from './python.js'
import { join, resolve, isAbsolute, basename } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolveWorkdir, fallbackWorkspace } from './workdir.js'
import { cacheGet, cacheSet, throttle } from './throttle.js'
import { detectDomain, domainById } from './domain-adapter.js'
import { appendLog, codeHash, readLogs } from './log.js'
import {
  codeSignature, errorSignature, rememberSuccess, rememberLesson,
  readPatterns, readLessons, searchMemory,
} from './memory.js'
import { stampProvenance } from './provenance.js'
import { verifyDesignPacket, PACKET_DIR } from './design-gate.js'
import { DESIGN_OPS } from './design-ops.js'
import { deriveDesignInputHash, finalizeDesignResult } from './design-envelope.js'
import { dispatchDesignOp } from './design-dispatch.js'
import { ingestExternalInput } from './design-ingress.js'
import {
  appendReceipt, commitReportFinalizeTransaction, commitTransaction, deriveCaseContentId, ensureCaseDir, loadArtifact, loadSnapshot, readHead, resolveCaseContext,
} from './design-casefile.js'
import { loadCapabilityPolicy } from './design-capability.js'

/** 引导可能耗时数分钟；工具执行期间等待引导完成。 */
const BOOT_WAIT_MS = 600_000

/** 「失败挂起」队列：signature → 失败信息，等待同意图的成功来配对成经验（上限 20 防膨胀）。 */
const pendingFixes = new Map()

/** 确保 Python 环境就绪并返回 python 路径；失败抛错。 */
async function requireEnv(config) {
  const env = await ensureEnvironment(config)
  if (!env.ready || !env.python) {
    throw new Error(`dsh-bio-genie Python 环境引导失败: ${env.error ?? 'unknown'}（可运行 bio_env 查看详情）`)
  }
  return env.python
}

/**
 * 深度设计器（dsh-bio-graft）是否已安装 —— 带 60s 缓存，供工具级语义标签注入使用。
 * 只做包探测（require.resolve + 读 package.json），**不 spawn 进程**；探测失败一律当未安装
 * （宁少说能力，不多说）。
 */
let advancedEditorCache = { at: 0, installed: false }
function advancedEditorInstalled() {
  if (Date.now() - advancedEditorCache.at < 60_000) return advancedEditorCache.installed
  let installed = false
  try {
    installed = detectDomain(domainById('graft')).installed === true
  } catch {
    installed = false
  }
  advancedEditorCache = { at: Date.now(), installed }
  return installed
}

/** 定义语义化工具（async 执行，统一 env 确保 + callBio 调用）。 */
function bioTool(config, opts) {
  const callTimeout = opts.timeoutMs ?? 240_000
  return defineTool({
    name: opts.name,
    description: opts.description,
    parameters: opts.parameters,
    timeoutMs: callTimeout + BOOT_WAIT_MS,
    output: {
      schema: opts.outputSchema ?? { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('aborted')
      // 缓存：查询类 op 相同参数命中缓存直接返回，不发网络请求（命中也要记日志，保可复现）
      const cacheKey = opts.cache ? `${opts.op}:${JSON.stringify(args)}` : null
      if (cacheKey) {
        const hit = cacheGet(cacheKey)
        if (hit !== undefined) {
          if (config.enableLog !== false) {
            appendLog({ kind: 'op', op: opts.op, ok: true, duration_ms: 0, cache_hit: true })
          }
          return hit
        }
      }
      // 限流：不足最小间隔先等待（spawn 之前，省进程启动）
      await throttle(opts.op)
      const py = await requireEnv(config)
      // 第二层按需依赖（EXTRA_DEPS）：op 声明的额外包缺失时自动 uv pip install
      // Explicit legacy Welch uses the base SciPy stack; it must not require PyDESeq2.
      const dependencyOp = opts.op === 'deseq2' && args.backend === 'legacy_welch' ? null : opts.op
      const deps = await ensureExtraDeps(dependencyOp, py)
      if (!deps.ok) {
        throw new Error(`dsh-bio-genie 依赖自动安装失败（op=${opts.op}）: ${deps.error}`)
      }
      const cwd = resolveWorkdir(exec)
      const t0 = Date.now()
      const res = await callBio(py, opts.op, args, { cwd, timeoutMs: callTimeout, signal: exec.signal })
      const duration = Date.now() - t0
      // 透明性日志：语义化工具调用（成功与失败都记）
      if (config.enableLog !== false) {
        appendLog({
          kind: 'op',
          op: opts.op,
          ok: res.ok === true,
          duration_ms: duration,
          error: res.ok ? undefined : (res.error ?? '').slice(0, 300),
        })
      }
      if (!res.ok) throw new Error(res.error ?? 'bio op failed')
      // 可选装饰钩子：工具级语义标签/宿主机状态注入（在缓存之前做，保证命中缓存也带标签）
      const result = typeof opts.decorate === 'function' ? opts.decorate(res.result, args, config) : res.result
      if (cacheKey) cacheSet(cacheKey, result)
      // 计算防火墙：返回值挂 _provenance 背书字段（台账记录由 rigor-guard 的
      // tools/post-execute 钩子统一完成，那里拿得到 agent 上下文）
      return stampProvenance(opts.name, result)
    },
  })
}

// ============================================================================
// designTool —— 六新工具的独立 designTool 路径（v0.5 §D5.5：不复用通用 pre-cache；
// 每次调用全量 gate + 直连 python/design_casefile.py 独立 dispatcher）。
//
// 与 bioTool 的差异（契约要点）：
//  - op 必须属于 DESIGN_OPS（design 通道白名单）；raw 通道由 server.js 拒绝。
//  - 每次执行先 verifyDesignPacket（gate 先于任何 spawn/cache/registry），
//    并把 packet 身份（PACKET_FIXED + index/manifest/acceptance sha）注入子进程
//    （split-packet 防线，与 A3 dispatchDesignOp 同一身份模型）。
//  - 子进程 = python/design_casefile.py（validate/export 专用 dispatcher）：
//    validate 任一 required check FAIL → 进程非零退出（任务书 §1.1「失败非零退出」；
//    bio_ops.py 受 P2-1 全 exit-0 契约约束，故本路径直连专用 dispatcher）。
//  - 结果信封 = v0.4 §C4 {status, reason_code, artifact_refs[], detail}（另附 checks[]）。
//  - validate/export 只写 receipt / audit overlay（TS 侧 design-envelope），
//    不产生也不修改科学快照（v0.4 §C2）。
// ============================================================================

/** 本批次注册的 designTool op 集合（双向验收：与 bio_ops.OPS 互为子集）。 */
export const DESIGN_TOOL_OPS = Object.freeze(['design_casefile_validate', 'design_casefile_export'])

const DESIGN_CASEFILE_PATH = join(import.meta.dirname, '..', 'python', 'design_casefile.py')
// B1 收口：design_consequence 独立 dispatcher（design_consequence.py；spawn 输出 = 扁平 C4 + ok，同 validate/export 形态）
const DESIGN_CONSEQUENCE_PATH = join(import.meta.dirname, '..', 'python', 'design_consequence.py')
const H64 = /^[0-9a-f]{64}$/

function designTool(config, opts) {
  if (!DESIGN_OPS.has(opts.op)) {
    throw new Error(`designTool 注册失败：${opts.op} 不在 DESIGN_OPS（design 通道白名单）`)
  }
  const callTimeout = opts.timeoutMs ?? 300_000
  return defineTool({
    name: opts.name,
    description: opts.description,
    parameters: opts.parameters,
    timeoutMs: callTimeout + BOOT_WAIT_MS,
    output: {
      schema: opts.outputSchema ?? { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('aborted')
      // Guard is deliberately before throttle/env/bootstrap/cache/provenance.
      // The six design tools never use generic bioTool pre-cache.
      const cwd = resolveWorkdir(exec)
      const cwdN = resolve(cwd) // 归一化分隔符：header.cwd 可能为正斜杠而 path.resolve 产出反斜杠，直接比较会误拒（2026-10-16 现场修复）
      const raw = typeof args.casefile_dir === 'string' ? args.casefile_dir : ''
      const caseDir = isAbsolute(raw) ? resolve(raw) : resolve(cwdN, raw)
      const rel = caseDir === cwdN ? '' : (caseDir.startsWith(cwdN + '\\') || caseDir.startsWith(cwdN + '/') ? caseDir.slice(cwdN.length + 1) : null)
      if (rel === null || rel.startsWith('..') || !existsSync(caseDir)) {
        const err = new Error('casefile_dir 必须在工作区内且已存在')
        err.status = 'OUT_OF_DOMAIN'
        err.code = 'OUT_OF_DOMAIN'
        throw err
      }
      // Gate before every side effect which can create state.  A guard
      // failure still gets a receipt-attached TS audit overlay when the case
      // path is available; it can never use cache or provenance.
      const gate = verifyDesignPacket()
      if (!gate.ok) {
        const terminal = await finalizeDesignResult({
          operation: opts.op,
          worker: null,
          inputHashes: [deriveDesignInputHash(opts.op, args)],
          caseDir,
          guard: () => gate,
        })
        const err = new Error(`design gate 拒绝：${terminal.code || gate.code} ${gate.detail || ''}`)
        err.status = 'DEPENDENCY_UNAVAILABLE'
        err.code = terminal.code || gate.code
        err.audit = terminal.audit
        throw err
      }
      // designTool does not reuse generic pre-cache (D5.5): no cacheGet/cacheSet.
      await throttle(opts.op)
      const py = opts.pythonPath || await requireEnv(config)
      const t0 = Date.now()
      // design_consequence 走独立 dispatcher（python/design_consequence.py）；validate/export 照 B1P2 走
      // design_casefile.py。信封提取统一「先取 res 再回退 stdout」（B1P2 修复；consequence 输出同形态）。
      const workerPath = opts.op === 'design_consequence' ? DESIGN_CONSEQUENCE_PATH : DESIGN_CASEFILE_PATH
      const workerArgs = { ...args, casefile_dir: caseDir }
      if (opts.op === 'design_consequence' && workerArgs.model_ref && typeof workerArgs.model_ref === 'object') {
        // 设计稿 §1：model_ref = metabolic_model_ref@1（v0 接线：内嵌已解析 sbml/card 路径，TS 不解析 ref）
        const mr = workerArgs.model_ref
        if (typeof mr.sbml_path === 'string') workerArgs.sbml_path = mr.sbml_path
        if (typeof mr.expected_sbml_sha256 === 'string') workerArgs.expected_sbml_sha256 = mr.expected_sbml_sha256
        if (typeof mr.card_path === 'string') workerArgs.card_path = mr.card_path
      }
      // consequence_run 落盘/引用（B1P1 artifacts 模式）：worker 写 staging + 自报 sha 引用；其余 op 不写 staging。
      const stagingDir = opts.op === 'design_consequence' ? join(cwd, '.design-staging', opts.op) : ''
      if (stagingDir) mkdirSync(stagingDir, { recursive: true })
      const res = await spawnPython(py, workerPath, { op: opts.op, args: workerArgs }, {
        cwd,
        timeoutMs: callTimeout,
        signal: exec.signal,
        env: {
          DSH_DESIGN_STAGING: stagingDir,
          DSH_DESIGN_DISPATCH_ID: '',
          DSH_DESIGN_PACKET: '',
          DSH_DESIGN_PACKET_FIXED: PACKET_DIR,
          DSH_DESIGN_EXPECT_INDEX_SHA: gate.index_sha256 || '',
          DSH_DESIGN_EXPECT_MANIFEST_SHA: gate.manifest_sha256 || '',
          DSH_DESIGN_ACCEPTANCE_ID: gate.acceptance_id || '',
        },
      })
      const duration = Date.now() - t0
      let envelope = res && typeof res === 'object' && res.ok !== undefined && typeof res.status === 'string' ? res : null
      if (!envelope) {
        try {
          const parsed = JSON.parse(String(res.stdout || '').trim())
          if (parsed && typeof parsed === 'object' && typeof parsed.status === 'string') envelope = parsed
        } catch { /* fallthrough */ }
      }
      const finalized = await finalizeDesignResult({
        operation: opts.op,
        envelope,
        worker: res,
        inputHashes: [deriveDesignInputHash(opts.op, args)],
        caseDir,
        // Gate was verified before Python spawn.  Reuse its immutable result
        // so the ordering remains guard → (no pre-cache) → audit/provenance.
        guard: () => gate,
        stampProvenance: (out) => stampProvenance(opts.name, out),
        // 科学产物 refs（B1P1 形态 artifactRef）：validate/export 为路径 refs（被 structuredRefs
        // 过滤，不回这里）；design_consequence 落盘 staging，逐 ref 解析 <staging>/<relative_path>。
        registerScientific: async ({ artifact_refs: refs }) => {
          for (const ref of refs) {
            if (!stagingDir || !existsSync(join(stagingDir, ref.relative_path))) {
              return { ok: false, code: 'REGISTRY_REF_UNRESOLVED', detail: ref.artifact_id.slice(0, 16) }
            }
          }
          return { ok: true, registered: refs.length }
        },
      })
      const terminalEnvelope = finalized.envelope || envelope
      if (config.enableLog !== false) {
        appendLog({
          kind: 'op',
          op: opts.op,
          ok: finalized.ok === true,
          duration_ms: duration,
          error: finalized.ok ? undefined : `${terminalEnvelope?.reason_code || finalized.code || 'EXECUTION_ERROR'} ${terminalEnvelope?.detail || finalized.detail || ''}`.slice(0, 300),
        })
      }
      if (!finalized.ok) {
        const status = terminalEnvelope?.status || finalized.status || 'EXECUTION_ERROR'
        const code = terminalEnvelope?.reason_code || finalized.code || 'EXECUTION_ERROR'
        const detail = terminalEnvelope?.detail || finalized.detail || '结果信封无效或审计登记失败'
        const err = new Error(`design ${opts.op} ${status}: ${code} ${detail}`)
        err.status = status
        err.code = code
        err.envelope = terminalEnvelope || undefined
        err.audit = finalized.audit
        throw err
      }
      // Keep the public C4 response surface deliberately narrow.  The worker
      // transport's `ok`/`code` fields stay receipt-only; checks[] remains the
      // documented validator extension.  Provenance is applied by the A5
      // finalizer only after guard/audit/registry have completed.
      const out = {
        status: finalized.envelope.status,
        reason_code: finalized.envelope.reason_code,
        artifact_refs: finalized.envelope.artifact_refs,
        detail: finalized.envelope.detail,
      }
      if (Array.isArray(finalized.envelope.checks)) out.checks = finalized.envelope.checks
      if (finalized.envelope._provenance) out._provenance = finalized.envelope._provenance
      return out
    },
  })
}

function parseCasefileEnvelope(response) {
  if (response && typeof response === 'object' && typeof response.status === 'string') return response
  try {
    const parsed = JSON.parse(String(response?.stdout || '').trim())
    return parsed && typeof parsed === 'object' && typeof parsed.status === 'string' ? parsed : null
  } catch {
    return null
  }
}

function normalizeAuditViewId(value) {
  const auditViewId = value === undefined ? [] : value
  if (!Array.isArray(auditViewId)) return { ok: false, code: 'INVALID_AUDIT_VIEW_ID', detail: 'audit_view_id must be an array' }
  if (auditViewId.length > 1024) return { ok: false, code: 'INVALID_AUDIT_VIEW_ID', detail: 'audit_view_id too long' }
  const seen = new Set()
  for (const id of auditViewId) {
    if (typeof id !== 'string' || !H64.test(id) || seen.has(id)) {
      return { ok: false, code: 'INVALID_AUDIT_VIEW_ID', detail: 'audit_view_id requires unique lowercase sha256 ids' }
    }
    seen.add(id)
  }
  const ordered = [...auditViewId]
  if (ordered.some((id, index) => id !== ordered.slice().sort()[index])) {
    return { ok: false, code: 'AUDIT_VIEW_NOT_CANONICAL', detail: 'audit_view_id must use ASCII lexical hash order' }
  }
  return { ok: true, auditViewId: ordered }
}

function casefileWorkerEnv(gate, stagingDir = '') {
  return {
    DSH_DESIGN_STAGING: stagingDir,
    DSH_DESIGN_DISPATCH_ID: '',
    DSH_DESIGN_PACKET: '',
    DSH_DESIGN_PACKET_FIXED: PACKET_DIR,
    DSH_DESIGN_EXPECT_INDEX_SHA: gate.index_sha256 || '',
    DSH_DESIGN_EXPECT_MANIFEST_SHA: gate.manifest_sha256 || '',
    DSH_DESIGN_ACCEPTANCE_ID: gate.acceptance_id || '',
  }
}

function casefileEnvelope(status, reasonCode, detail, extra = {}) {
  return { status, reason_code: reasonCode, artifact_refs: [], detail, ...extra }
}

/**
 * B4 public export wrapper.
 *
 * A not-yet-finalized HEAD first takes the deliberately narrow path
 * S_n -> Python render-to-TS-staging -> TS report transaction -> validate
 * S_(n+1) -> Python pure export(S_(n+1)).  An already finalized HEAD only
 * takes the last validate/export portion.  No receipt is read to form the
 * audit view; the caller supplies its canonical ordered hash array directly.
 */
function designCasefileExportTool(config) {
  const op = 'design_casefile_export'
  const callTimeout = 300_000
  return defineTool({
    name: op,
    description:
      'design casefile 导出：对未收口快照执行确定性 report-finalize 事务（S_n → 含 report.md 的 S_(n+1)）→ 精确 validate → export；' +
      'audit_view_id 为 canonical 有序 audit-record hash 数组。导出产物只写 export 侧，不改变已完成的科学快照。',
    parameters: {
      casefile_dir: { type: 'string', required: true, description: 'casefile 根目录，必须在工作区内且已存在' },
      format: { type: 'string', enum: ['zip', 'report', 'both'], default: 'both', description: '导出格式' },
      audit_view_id: { type: 'array', default: [], items: { type: 'string' }, description: 'canonical ASCII-ordered audit-record hash array；[] 表示显式无审计引用' },
      expected_parent_snapshot_sha: { type: 'string', description: '可选 S_n CAS 绑定；不符即拒绝 finalize/export' },
    },
    timeoutMs: callTimeout + BOOT_WAIT_MS,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('aborted')
      const cwd = resolveWorkdir(exec)
      const cwdN = resolve(cwd) // 归一化分隔符：header.cwd 可能为正斜杠而 path.resolve 产出反斜杠，直接比较会误拒（2026-10-16 现场修复）
      const raw = typeof args.casefile_dir === 'string' ? args.casefile_dir : ''
      const caseDir = isAbsolute(raw) ? resolve(raw) : resolve(cwdN, raw)
      const rel = caseDir === cwdN ? '' : (caseDir.startsWith(cwdN + '\\') || caseDir.startsWith(cwdN + '/') ? caseDir.slice(cwdN.length + 1) : null)
      if (rel === null || rel.startsWith('..') || !existsSync(caseDir)) {
        const err = new Error('casefile_dir 必须在工作区内且已存在')
        err.status = 'OUT_OF_DOMAIN'
        err.code = 'OUT_OF_DOMAIN'
        throw err
      }
      const gate = verifyDesignPacket()
      if (!gate.ok) {
        const terminal = await finalizeDesignResult({
          operation: op,
          worker: null,
          inputHashes: [deriveDesignInputHash(op, args)],
          caseDir,
          guard: () => gate,
        })
        const err = new Error(`design gate 拒绝：${terminal.code || gate.code} ${gate.detail || ''}`)
        err.status = 'DEPENDENCY_UNAVAILABLE'
        err.code = terminal.code || gate.code
        err.audit = terminal.audit
        throw err
      }
      await throttle(op)
      const py = await requireEnv(config)
      const t0 = Date.now()
      let envelope = null
      let worker = null
      let finalizedSnapshot = null
      let reportArtifactId = null
      let reportFinalized = false
      const auditView = normalizeAuditViewId(args.audit_view_id)
      try {
        if (args.format !== undefined && !['zip', 'report', 'both'].includes(args.format)) {
          envelope = casefileEnvelope('INVALID_INPUT', 'INVALID_FORMAT', 'format must be zip/report/both')
        } else if (!auditView.ok) {
          envelope = casefileEnvelope('INVALID_INPUT', auditView.code, auditView.detail)
        } else if (args.expected_parent_snapshot_sha !== undefined
          && (typeof args.expected_parent_snapshot_sha !== 'string' || !H64.test(args.expected_parent_snapshot_sha))) {
          envelope = casefileEnvelope('INVALID_INPUT', 'REPORT_PARENT_INVALID', 'expected_parent_snapshot_sha must be lowercase sha256')
        } else {
          const handle = {
            caseDir,
            objectsDir: join(caseDir, 'objects'),
            snapshotsDir: join(caseDir, 'snapshots'),
          }
          const head = readHead(caseDir)
          if (!head.ok || !H64.test(head.snapshot_sha || '')) {
            envelope = casefileEnvelope('INVALID_INPUT', head.ok ? 'SNAPSHOT_MISSING' : 'HEAD_UNREADABLE', 'casefile HEAD must select an immutable snapshot')
          } else if (args.expected_parent_snapshot_sha !== undefined && args.expected_parent_snapshot_sha !== head.snapshot_sha) {
            envelope = casefileEnvelope('INVALID_INPUT', 'PARENT_SNAPSHOT_STALE', 'HEAD does not match expected parent snapshot')
          } else {
            const sourceSnapshot = head.snapshot_sha
            const source = loadSnapshot(handle.snapshotsDir, sourceSnapshot)
            if (!source.ok || !Array.isArray(source.manifest?.artifacts)) {
              envelope = casefileEnvelope('INVALID_INPUT', 'SNAPSHOT_UNREADABLE', 'source snapshot manifest unavailable')
            } else {
              const reports = source.manifest.artifacts.filter((entry) => entry && entry.type === 'case_report@1')
              if (reports.length > 1) {
                envelope = casefileEnvelope('INVALID_INPUT', 'REPORT_FINALIZE_STATE_INVALID', 'source snapshot has multiple case reports')
              } else if (reports.length === 1) {
                finalizedSnapshot = sourceSnapshot
                reportArtifactId = reports[0].artifact_id
              } else {
                mkdirSync(join(caseDir, 'staging'), { recursive: true })
                const stagingDir = mkdtempSync(join(caseDir, 'staging', 'report-finalize-'))
                worker = await spawnPython(py, DESIGN_CASEFILE_PATH, {
                  op,
                  args: {
                    casefile_dir: caseDir,
                    _stage_report: true,
                    source_snapshot_sha: sourceSnapshot,
                    audit_view_id: auditView.auditViewId,
                  },
                }, {
                  cwd,
                  timeoutMs: callTimeout,
                  signal: exec.signal,
                  env: casefileWorkerEnv(gate, stagingDir),
                })
                const staged = parseCasefileEnvelope(worker)
                if (!staged || staged.status !== 'OK') {
                  envelope = staged || casefileEnvelope('EXECUTION_ERROR', 'REPORT_STAGE_WORKER_INVALID', 'report render worker returned no C4 envelope')
                } else if (staged.source_snapshot_sha !== sourceSnapshot || !H64.test(staged.report_sha256 || '')) {
                  envelope = casefileEnvelope('INVALID_INPUT', 'REPORT_STAGE_BINDING_INVALID', 'staged report did not bind the captured source snapshot')
                } else {
                  const stagedPath = join(stagingDir, 'report.md')
                  if (!existsSync(stagedPath)) {
                    envelope = casefileEnvelope('EXECUTION_ERROR', 'REPORT_STAGE_MISSING', 'staged report file missing')
                  } else {
                    const transaction = commitReportFinalizeTransaction(handle, {
                      reportBytes: readFileSync(stagedPath),
                      expectHead: sourceSnapshot,
                    })
                    if (!transaction.ok) {
                      envelope = casefileEnvelope('INVALID_INPUT', transaction.code || 'REPORT_FINALIZE_FAILED', 'report-finalize transaction rejected')
                    } else if (transaction.report_artifact_id !== staged.report_sha256) {
                      envelope = casefileEnvelope('EXECUTION_ERROR', 'REPORT_HASH_BINDING_INVALID', 'staged report hash changed before commit')
                    } else {
                      finalizedSnapshot = transaction.snapshot_sha
                      reportArtifactId = transaction.report_artifact_id
                      reportFinalized = true
                    }
                  }
                }
              }
              if (!envelope && finalizedSnapshot && typeof reportArtifactId === 'string') {
                worker = await spawnPython(py, DESIGN_CASEFILE_PATH, {
                  op: 'design_casefile_validate',
                  args: { casefile_dir: caseDir, snapshot_sha: finalizedSnapshot },
                }, {
                  cwd,
                  timeoutMs: callTimeout,
                  signal: exec.signal,
                  env: casefileWorkerEnv(gate),
                })
                const validation = parseCasefileEnvelope(worker)
                if (!validation || validation.status !== 'OK' || validation.snapshot_sha !== finalizedSnapshot) {
                  envelope = validation || casefileEnvelope('EXECUTION_ERROR', 'REPORT_VALIDATE_WORKER_INVALID', 'final snapshot validation returned no bound C4 envelope')
                } else {
                  worker = await spawnPython(py, DESIGN_CASEFILE_PATH, {
                    op,
                    args: { casefile_dir: caseDir, format: args.format || 'both', snapshot_sha: finalizedSnapshot },
                  }, {
                    cwd,
                    timeoutMs: callTimeout,
                    signal: exec.signal,
                    env: casefileWorkerEnv(gate),
                  })
                  envelope = parseCasefileEnvelope(worker)
                  if (!envelope || envelope.status !== 'OK') {
                    envelope = envelope || casefileEnvelope('EXECUTION_ERROR', 'EXPORT_WORKER_INVALID', 'pure export worker returned no C4 envelope')
                  } else if (envelope.snapshot_sha !== finalizedSnapshot || envelope.report_artifact_id !== reportArtifactId) {
                    envelope = casefileEnvelope('EXECUTION_ERROR', 'EXPORT_SNAPSHOT_BINDING_INVALID', 'pure export did not preserve finalized snapshot binding')
                  } else {
                    const receipt = appendReceipt(caseDir, {
                      event: 'exported',
                      at: new Date().toISOString(),
                      snapshot_sha: finalizedSnapshot,
                      report_artifact_id: reportArtifactId,
                      format: args.format || 'both',
                      artifact_refs: envelope.artifact_refs,
                    })
                    if (!receipt.ok) {
                      envelope = casefileEnvelope('EXECUTION_ERROR', 'EXPORT_RECEIPT_FAILED', 'export receipt append failed')
                    } else {
                      envelope.report_finalized = reportFinalized
                      envelope.audit_view_id = auditView.auditViewId
                    }
                  }
                }
              }
            }
          }
        }
      } catch {
        envelope = casefileEnvelope('EXECUTION_ERROR', 'REPORT_FINALIZE_INTERNAL_ERROR', 'report-finalize wrapper failed')
      }

      const finalized = await finalizeDesignResult({
        operation: op,
        envelope,
        worker,
        inputHashes: [deriveDesignInputHash(op, args)],
        caseDir,
        guard: () => gate,
        stampProvenance: (out) => stampProvenance(op, out),
      })
      const terminalEnvelope = finalized.envelope || envelope
      const duration = Date.now() - t0
      if (config.enableLog !== false) {
        appendLog({
          kind: 'op', op, ok: finalized.ok === true, duration_ms: duration,
          error: finalized.ok ? undefined : `${terminalEnvelope?.reason_code || finalized.code || 'EXECUTION_ERROR'} ${terminalEnvelope?.detail || finalized.detail || ''}`.slice(0, 300),
        })
      }
      if (!finalized.ok) {
        const err = new Error(`design ${op} ${terminalEnvelope?.status || finalized.status || 'EXECUTION_ERROR'}: ${terminalEnvelope?.reason_code || finalized.code || 'EXECUTION_ERROR'} ${terminalEnvelope?.detail || finalized.detail || ''}`)
        err.status = terminalEnvelope?.status || finalized.status || 'EXECUTION_ERROR'
        err.code = terminalEnvelope?.reason_code || finalized.code || 'EXECUTION_ERROR'
        err.envelope = terminalEnvelope || undefined
        err.audit = finalized.audit
        throw err
      }
      const out = {
        status: finalized.envelope.status,
        reason_code: finalized.envelope.reason_code,
        artifact_refs: finalized.envelope.artifact_refs,
        detail: finalized.envelope.detail,
      }
      for (const key of ['checks', 'snapshot_sha', 'report_artifact_id', 'report_finalized', 'audit_view_id', '_provenance']) {
        if (finalized.envelope[key] !== undefined) out[key] = finalized.envelope[key]
      }
      if (finalized.audit_write?.event?.audit_record_id) out.audit_record_id = finalized.audit_write.event.audit_record_id
      return out
    },
  })
}

/**
 * B1-part-1 宿主侧三工具（designHostTool）——独立 designTool 路径：
 *   gate → throttle → A4 ingress（外部文件经 ingestExternalInput，case 内提交 input_snapshot@1）
 *   → A2 事务绑定（caseContentId/policy/expectHead）→ A3 dispatch（bio_ops.py 路由 design_host
 *   实现；Python 只写 staging、只返回候选）→ A5 envelope 归一（worker 信封 + TS 侧消费产物 refs）。
 * allowedOutputs 一律 required=false：worker 合法终态（BLOCKED/NOT_RUN/DEPENDENCY_UNAVAILABLE）
 * 不产候选；OK 必须产出声明输出（wrapper 层强制）。
 */
const DESIGN_HOST_OUTPUT_LIMIT = 16 // dispatch maxOutputFiles 上限（DISPATCH_LIMITS）
const DESIGN_HOST_INPUT_BYTES = 128 * 1024 * 1024

function designInputCopyDir({ cwd, caseHandle, op }) {
  if (caseHandle) return join(caseHandle.caseDir, 'inputs')
  return join(cwd, '.design-inputs', op)
}

/** A4 外部输入摄入：读 → hash → TS 拥有副本 → input_snapshot 提交（case 模式）。 */
function ingestHostInputs(op, args, { cwd, caseHandle }) {
  const entries = []
  const push = (key, role, format, path) => entries.push({ key, role, format, path })
  const gfiles = Array.isArray(args.genome_files) ? args.genome_files : []
  for (const f of gfiles) {
    if (!f || typeof f.path !== 'string' || !f.path) return fail('INGRESS_ENTRY_INVALID', 'genome_files 项需 {path, format}')
    const fmt = typeof f.format === 'string' ? f.format : 'other'
    const role = fmt === 'fasta' ? 'genome_sequence' : (fmt === 'segments_tsv' ? 'other' : 'genome_annotation')
    push('genome_files', role, fmt === 'fasta' ? 'fasta' : (fmt === 'gff3' ? 'gff3' : (fmt === 'genbank' ? 'genbank' : 'other')), f.path)
  }
  const single = (key, role, fmt) => {
    const v = args[key]
    if (v && typeof v === 'object' && typeof v.path === 'string' && v.path) push(key, role, fmt, v.path)
    else if (v !== undefined && v !== null) return fail('INGRESS_ENTRY_INVALID', key + ' 需 {path}')
    return null
  }
  let r
  r = single('parts_evidence_file', 'parts_evidence', 'json')
  if (r) return r
  r = single('essentiality_evidence', 'other', 'json')
  if (r) return r
  r = single('expression_evidence', 'other', 'json')
  if (r) return r
  if (args.parts_evidence && typeof args.parts_evidence === 'object' && !Array.isArray(args.parts_evidence)
    && typeof args.parts_evidence.path === 'string' && args.parts_evidence.path) {
    push('parts_evidence', 'parts_evidence', 'json', args.parts_evidence.path)
  }
  if (args.circuit && typeof args.circuit === 'object' && args.circuit.sbol_file
    && typeof args.circuit.sbol_file === 'object' && typeof args.circuit.sbol_file.path === 'string') {
    push('circuit.sbol_file', 'sbol', 'text', args.circuit.sbol_file.path)
  }

  const inputDir = designInputCopyDir({ cwd, caseHandle, op })
  const inputRefs = []
  const newArtifacts = []
  const fileArgs = {}
  const usedNames = new Set()
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i]
    if (!existsSync(e.path)) return fail('INPUT_FILE_MISSING', e.path)
    const ingested = ingestExternalInput(e.path, { role: e.role, caseHandle })
    if (!ingested.ok) return fail(ingested.code || 'INGRESS_FAILED', ingested.detail || e.path)
    if (ingested.byte_size > DESIGN_HOST_INPUT_BYTES) return fail('INGRESS_SIZE_LIMIT', String(ingested.byte_size))
    mkdirSync(inputDir, { recursive: true })
    const copyPath = join(inputDir, ingested.sha256)
    if (!existsSync(copyPath)) writeFileSync(copyPath, ingested.bytes)
    const rel = 'input_snapshot-' + String(i + 1).padStart(2, '0') + '.json'
    const name = rel
    usedNames.add(name)
    inputRefs.push({ artifact_id: ingested.sha256, expected_sha256: ingested.sha256, relative_path: name })
    newArtifacts.push({
      type: 'input_snapshot@1',
      value: ingested.inventory,
      producer: 'ingress',
      inputs: [],
      canonical_path: name,
    })
    if (e.key === 'genome_files') {
      ;(fileArgs.genome_files = fileArgs.genome_files || []).push({
        path: copyPath, sha256: ingested.sha256,
        display_name: basename(e.path), format: e.format,
      })
    } else if (e.key === 'parts_evidence' || e.key === 'parts_evidence_file') {
      fileArgs[e.key] = { path: copyPath, sha256: ingested.sha256, display_name: basename(e.path) }
    } else if (e.key === 'essentiality_evidence' || e.key === 'expression_evidence') {
      fileArgs[e.key] = { path: copyPath, sha256: ingested.sha256, display_name: basename(e.path) }
    } else if (e.key === 'circuit.sbol_file') {
      fileArgs.circuit_sbol = { path: copyPath, sha256: ingested.sha256, display_name: basename(e.path) }
    }
  }
  return { ok: true, args: fileArgs, inputRefs, newArtifacts }
}

function fail(code, detail = null) {
  return { ok: false, code, ...(detail ? { detail } : {}) }
}

/** dispatch 失败码 → C4 状态映射（worker 契约违例一律 EXECUTION_ERROR）。 */
const DESIGN_DISPATCH_STATUS_MAP = {
  DEPENDENCY_UNAVAILABLE: new Set(['PACKET_UNVERIFIED', 'PACKET_IDENTITY', 'POLICY_UNVERIFIED', 'GUARD_REJECTED']),
  INVALID_INPUT: new Set([
    'NOT_A_DESIGN_OP', 'DISPATCH_BINDING_INVALID', 'INPUT_REF_UNRESOLVED', 'DUPLICATE_LOGICAL_NAME',
    'OUTPUT_NAME_INVALID', 'OUTPUT_FILE_LIMIT', 'OUTPUT_FILE_TOO_LARGE', 'OUTPUT_TOTAL_TOO_LARGE',
    'UNDECLARED_OUTPUT', 'REQUIRED_OUTPUT_MISSING', 'WORKER_ARTIFACT_TYPE_MISMATCH', 'WORKER_HASH_MISMATCH',
    'WORKER_PATH_UNTRUSTED',
  ]),
}

function designDispatchStatus(code) {
  if (DESIGN_DISPATCH_STATUS_MAP.DEPENDENCY_UNAVAILABLE.has(code)) return 'DEPENDENCY_UNAVAILABLE'
  if (DESIGN_DISPATCH_STATUS_MAP.INVALID_INPUT.has(code)) return 'INVALID_INPUT'
  return 'EXECUTION_ERROR'
}

/** 解析 ref（case objects 无扩展名；standalone objects 带 .json）。 */
function resolveRefValue({ caseHandle, cwd, artifactId }) {
  if (typeof artifactId !== 'string' || !/^[0-9a-f]{64}$/.test(artifactId)) return fail('REF_INVALID', 'artifact_id 需 sha256')
  if (caseHandle) {
    const art = loadArtifact(caseHandle, artifactId)
    return art.ok ? { ok: true, value: art.value } : art
  }
  const p = join(cwd, 'objects', artifactId + '.json')
  if (!existsSync(p)) return fail('OBJECT_NOT_FOUND', artifactId.slice(0, 16))
  try {
    return { ok: true, value: JSON.parse(readFileSync(p, 'utf8')) }
  } catch (e) {
    return fail('OBJECT_UNREADABLE', String(e.message).slice(0, 120))
  }
}

function designHostTool(config, opts) {
  if (!DESIGN_OPS.has(opts.op)) {
    throw new Error(`designHostTool 注册失败：${opts.op} 不在 DESIGN_OPS（design 通道白名单）`)
  }
  const callTimeout = opts.timeoutMs ?? 300_000
  return defineTool({
    name: opts.name,
    description: opts.description,
    parameters: opts.parameters,
    timeoutMs: callTimeout + BOOT_WAIT_MS,
    output: {
      schema: opts.outputSchema ?? { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('aborted')
      const cwd = resolveWorkdir(exec)
      const cwdN = resolve(cwd) // 归一化分隔符（同 designTool 守卫修复：正斜杠 header.cwd 误拒）
      // ── case 绑定（可选；casefile_dir 必须在工作区内且为既有 case）──
      let caseHandle = null
      let caseDir = null
      if (typeof args.casefile_dir === 'string' && args.casefile_dir) {
        const raw = args.casefile_dir
        const candidate = isAbsolute(raw) ? resolve(raw) : resolve(cwdN, raw)
        const rel = candidate === cwdN ? '' : (candidate.startsWith(cwdN + '\\') || candidate.startsWith(cwdN + '/') ? candidate.slice(cwdN.length + 1) : null)
        if (rel === null || rel.startsWith('..') || !existsSync(candidate)) {
          const err = new Error('casefile_dir 必须在工作区内且已存在')
          err.status = 'OUT_OF_DOMAIN'; err.code = 'OUT_OF_DOMAIN'; throw err
        }
        const c = ensureCaseDir(cwd, basename(candidate), { create: false })
        if (!c.ok || resolve(c.caseDir) !== resolve(candidate)) {
          const err = new Error(`casefile_dir 不是合法 case：${c.detail || c.code || ''}`)
          err.status = 'OUT_OF_DOMAIN'; err.code = 'OUT_OF_DOMAIN'; throw err
        }
        caseHandle = c
        caseDir = c.caseDir
      }
      // ── gate（side-effect 之前）──
      const gate = verifyDesignPacket()
      if (!gate.ok) {
        const terminal = await finalizeDesignResult({
          operation: opts.op, worker: null,
          inputHashes: [deriveDesignInputHash(opts.op, args)],
          caseDir, guard: () => gate,
        })
        const err = new Error(`design gate 拒绝：${terminal.code || gate.code} ${gate.detail || ''}`)
        err.status = 'DEPENDENCY_UNAVAILABLE'; err.code = terminal.code || gate.code; err.audit = terminal.audit
        throw err
      }
      await throttle(opts.op)
      const py = opts.pythonPath || await requireEnv(config)
      const t0 = Date.now()
      // 本地终态 helper：合成 C4 信封 → A5 审计 → 抛错（带 envelope/audit）
      const fail = async (status, code, detail) => {
        const envelope = { status, reason_code: code, artifact_refs: [], detail: String(detail || '').slice(0, 800) }
        const finalized = await finalizeDesignResult({
          operation: opts.op, envelope, worker: null,
          inputHashes: [deriveDesignInputHash(opts.op, args)],
          caseDir, guard: () => gate,
        })
        const err = new Error(`design ${opts.op} ${status}: ${code} ${detail || ''}`)
        err.status = status; err.code = code
        err.envelope = finalized.envelope || envelope
        err.audit = finalized.audit
        throw err
      }
      try {
        // ── output cap: integration top_n <= 16 (dispatch maxOutputFiles; tighten only)
        if (opts.op === 'design_integration_candidates') {
          const topN = args.top_n
          if (topN !== undefined && topN !== null && (!Number.isInteger(topN) || topN < 1 || topN > 16)) {
            return await fail('INVALID_INPUT', 'TOP_N_LIMIT', 'top_n 需 1..16（dispatch maxOutputFiles 上限）')
          }
        }
        // ── host_profile / genome_ref / crn 引用解析（refs-only 校验）──
        const hpRef = args.host_profile_ref
        let hpValue = args.host_profile
        if (hpRef && typeof hpRef === 'object' && typeof hpRef.artifact_id === 'string') {
          const resolved = resolveRefValue({ caseHandle, cwd, artifactId: hpRef.artifact_id })
          if (!resolved.ok) return await fail('INVALID_INPUT', 'HOST_PROFILE_REF_UNRESOLVED', resolved.detail || 'host_profile ref 不可解析')
          hpValue = resolved.value
        }
        if (opts.op === 'design_integration_candidates' || opts.op === 'design_circuit_contextualize') {
          if (!hpValue || typeof hpValue !== 'object' || hpValue.artifact_type !== 'host_profile@1') {
            return await fail('INVALID_INPUT', 'HOST_PROFILE_REQUIRED', '需 host_profile 值或可解析的 host_profile_ref')
          }
          let grValue = args.genome_ref_value
          if (!grValue && hpValue.genome_ref && typeof hpValue.genome_ref === 'object' && typeof hpValue.genome_ref.artifact_id === 'string') {
            const resolved = resolveRefValue({ caseHandle, cwd, artifactId: hpValue.genome_ref.artifact_id })
            if (!resolved.ok) return await fail('INVALID_INPUT', 'GENOME_REF_UNRESOLVED', resolved.detail || 'genome_ref 不可解析')
            grValue = resolved.value
          }
          if (!grValue || typeof grValue !== 'object' || grValue.artifact_type !== 'genome_ref@1') {
            return await fail('INVALID_INPUT', 'GENOME_REF_REQUIRED', '需 genome_ref_value（或随 host_profile_ref 解析）')
          }
          args = { ...args, host_profile: hpValue, genome_ref_value: grValue }
          delete args.host_profile_ref
        }
        if (opts.op === 'design_circuit_contextualize' && args.crn_sbml_ref
          && typeof args.crn_sbml_ref === 'object' && typeof args.crn_sbml_ref.artifact_id === 'string') {
          const resolved = resolveRefValue({ caseHandle, cwd, artifactId: args.crn_sbml_ref.artifact_id })
          if (!resolved.ok) return await fail('INVALID_INPUT', 'CRN_REF_UNRESOLVED', resolved.detail || 'crn_sbml_ref 不可解析')
        }
        // ── A4 ingress ──
        const ingest = ingestHostInputs(opts.op, args, { cwd, caseHandle })
        if (!ingest.ok) return await fail('INVALID_INPUT', ingest.code, ingest.detail || '输入摄入失败')
        const workerArgs = { ...args, ...ingest.args }
        delete workerArgs.casefile_dir
        const inputRefs = ingest.inputRefs
        // ── case 绑定：policy / caseContentId / parent ──
        let caseContentId = null
        let policyDoc = null
        let parentSnapshot = undefined
        if (caseHandle) {
          const head = readHead(caseHandle.caseDir)
          if (!head.ok) return await fail('EXECUTION_ERROR', 'HEAD_UNREADABLE', 'case HEAD 不可读')
          if (!head.snapshot_sha) {
            const p = loadCapabilityPolicy()
            if (!p.ok) return await fail('DEPENDENCY_UNAVAILABLE', 'POLICY_UNVERIFIED', p.problems ? String(p.problems[0]) : 'capability policy 不可用')
            policyDoc = p.policy
            caseContentId = deriveCaseContentId({
              rootInputArtifactIds: inputRefs.map((x) => x.artifact_id).sort(),
              policyVersion: String(policyDoc.policy_version || '0'),
              canonicalParams: {},
            })
          } else {
            const snap = loadSnapshot(caseHandle.snapshotsDir, head.snapshot_sha)
            if (!snap.ok) return await fail('EXECUTION_ERROR', 'SNAPSHOT_UNREADABLE', snap.detail || 'snapshot unreadable')
            caseContentId = snap.manifest.case_content_id
            policyDoc = snap.manifest.policy
          }
          parentSnapshot = head.snapshot_sha
          if (ingest.newArtifacts.length > 0) {
            const tx = commitTransaction(caseHandle, {
              caseContentId, policy: policyDoc,
              expectHead: head.snapshot_sha, txid: null,
              newArtifacts: ingest.newArtifacts,
            })
            if (!tx.ok) return await fail('EXECUTION_ERROR', tx.code, tx.detail || 'input commit failed')
            parentSnapshot = tx.snapshot_sha
          }
        }
        // ── A3 dispatch（bio_ops.py 路由 design_host 实现）──
        const res = await dispatchDesignOp(py, opts.op, workerArgs, {
          cwd,
          timeoutMs: callTimeout,
          signal: exec.signal,
          caseHandle,
          parentSnapshot,
          allowedInputRefs: inputRefs,
          allowedOutputs: opts.allowedOutputs,
          limits: opts.limits,
          caseContentId,
          policy: policyDoc,
        })
        // ── A5 envelope 归一 ──
        let envelope = null
        let artifactsOut = []
        if (!res.ok) {
          const code = res.dispatch_failure || res.code || 'DISPATCH_FAILED'
          const detail = res.detail || res.error || (res.stderr ? String(res.stderr).slice(0, 400) : 'dispatch failed')
          envelope = { status: designDispatchStatus(code), reason_code: code, artifact_refs: [], detail: String(detail).slice(0, 800) }
        } else {
          const workerEnvelope = res.result && typeof res.result === 'object'
            ? (res.result.result && typeof res.result.result === 'object' && res.result.result.envelope
              ? res.result.result.envelope : (res.result.envelope || null))
            : null
          if (!workerEnvelope || typeof workerEnvelope.status !== 'string') {
            envelope = { status: 'EXECUTION_ERROR', reason_code: 'WORKER_ENVELOPE_INVALID', artifact_refs: [], detail: 'worker 未返回合法 C4 信封' }
          } else {
            envelope = {
              status: workerEnvelope.status,
              reason_code: typeof workerEnvelope.reason_code === 'string' ? workerEnvelope.reason_code : 'OK',
              artifact_refs: [],
              detail: typeof workerEnvelope.detail === 'string' ? workerEnvelope.detail : '',
            }
            const objects = (res.committed && Array.isArray(res.committed.objects)) ? res.committed.objects
              : (res.committed && res.committed.object_path ? [res.committed] : [])
            if (workerEnvelope.status === 'OK') {
              const got = new Set(objects.map((o) => o.logical_name))
              const expected = (opts.allowedOutputs || []).map((o) => o.logical_name)
              const missing = expected.filter((n) => !got.has(n))
              if (objects.length === 0 || missing.length > 0) {
                envelope = { status: 'EXECUTION_ERROR', reason_code: missing.length > 0 ? 'MISSING_OUTPUT' : 'WORKER_EMPTY_RESULT', artifact_refs: [], detail: 'OK 信封但产出缺失: ' + (missing.join(',') || 'empty') }
              } else {
                envelope.artifact_refs = objects.map((o) => ({
                  artifact_id: o.sha256, expected_sha256: o.sha256, relative_path: o.logical_name,
                }))
                artifactsOut = objects.map((o) => ({
                  logical_name: o.logical_name,
                  artifact_type: o.artifact_type,
                  sha256: o.sha256,
                  object_path: o.object_path || null,
                }))
              }
            }
          }
        }
        const extra = { artifacts: artifactsOut }
        if (envelope.status === 'OK' && caseHandle && opts.op === 'design_chassis_profile') {
          const ctx = resolveCaseContext(caseHandle)
          if (ctx.ok) extra.case_context = {
            snapshot_sha: ctx.snapshot_sha,
            case_content_id: ctx.case_content_id,
            flags: ctx.flags,
            input_state: ctx.input_state,
            coupling_mode: ctx.coupling_mode,
          }
        }
        const finalized = await finalizeDesignResult({
          operation: opts.op,
          envelope: { ...envelope, ...extra },
          worker: res,
          inputHashes: [deriveDesignInputHash(opts.op, args)],
          caseDir,
          guard: () => gate,
          stampProvenance: (out) => stampProvenance(opts.name, out),
          registerScientific: async ({ artifact_refs: refs }) => {
            for (const ref of refs) {
              if (caseHandle) {
                const art = loadArtifact(caseHandle, ref.artifact_id)
                if (!art.ok) return { ok: false, code: 'REGISTRY_REF_UNRESOLVED', detail: ref.artifact_id.slice(0, 16) }
              } else if (!existsSync(join(cwd, 'objects', ref.artifact_id + '.json'))) {
                return { ok: false, code: 'REGISTRY_REF_UNRESOLVED', detail: ref.artifact_id.slice(0, 16) }
              }
            }
            return { ok: true, registered: refs.length }
          },
        })
        const terminalEnvelope = finalized.envelope || envelope
        if (config.enableLog !== false) {
          appendLog({
            kind: 'op', op: opts.op, ok: finalized.ok === true, duration_ms: Date.now() - t0,
            error: finalized.ok ? undefined : `${terminalEnvelope?.reason_code || finalized.code || 'EXECUTION_ERROR'} ${terminalEnvelope?.detail || finalized.detail || ''}`.slice(0, 300),
          })
        }
        if (!finalized.ok) {
          const s = terminalEnvelope?.status || finalized.status || 'EXECUTION_ERROR'
          const c = terminalEnvelope?.reason_code || finalized.code || 'EXECUTION_ERROR'
          const d = terminalEnvelope?.detail || finalized.detail || '结果信封无效或审计登记失败'
          const err = new Error(`design ${opts.op} ${s}: ${c} ${d}`)
          err.status = s; err.code = c
          err.envelope = terminalEnvelope || undefined
          err.audit = finalized.audit
          throw err
        }
        const out = {
          status: finalized.envelope.status,
          reason_code: finalized.envelope.reason_code,
          artifact_refs: finalized.envelope.artifact_refs,
          detail: finalized.envelope.detail,
        }
        if (Array.isArray(finalized.envelope.checks)) out.checks = finalized.envelope.checks
        if (Array.isArray(finalized.envelope.artifacts)) out.artifacts = finalized.envelope.artifacts
        if (finalized.envelope.case_context) out.case_context = finalized.envelope.case_context
        if (finalized.envelope._provenance) out._provenance = finalized.envelope._provenance
        return out
      } catch (e) {
        if (e && (e.envelope || e.audit)) throw e
        if (e && e.status && e.code) throw e
        const err = new Error(`design ${opts.op} EXECUTION_ERROR: ${e && e.message ? e.message : String(e)}`)
        err.status = 'EXECUTION_ERROR'; err.code = 'EXECUTION_ERROR'
        throw err
      }
    },
  })
}

export function registerTools(ctx, config) {
  const disposers = []

  // ============ 执行器（许愿式编程核心） ============
  disposers.push(ctx.tools.register(defineTool({
    name: 'bio_python',
    description:
      '运行一段 Python 程序，使用内置的 Biopython 环境完成生物信息学分析。' +
      '把完整程序写在 code 参数中；程序以工作区为工作目录，相对路径读写工作区文件。' +
      'print() 内容返回在 stdout；给顶层变量 result 赋一个 JSON 可序列化的值可结构化返回。' +
      '适合执行器类任务：任何 Biopython 功能（比对、PDB、Phylo、motif、复杂流程）都可以在这里用代码完成。' +
      '触发词：任意代码、写python、复杂分析、Biopython脚本。',
    parameters: {
      code: { type: 'string', required: true, description: '完整 Python 源码，使用 Biopython。' },
      workdir: { type: 'string', description: '工作目录（绝对路径，或相对会话工作区的相对路径）。默认：会话工作区；会话工作区未指定时用 ~/.dsh/sessions/default。' },
      timeoutMs: { type: 'number', description: '超时毫秒数。默认插件默认值。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          error: { type: 'string' },
          result: { type: 'json' },
          exitCode: { type: 'integer' },
          timedOut: { type: 'boolean', required: true },
          truncated: { type: 'boolean' },
          needs_repair: { type: 'boolean' },
          _provenance: { type: 'object', additionalProperties: true, description: '计算防火墙背书：本结果由哪个工具产出。' },
        },
      },
      render: renderBioPython,
    },
    async execute(args, exec) {
      const env = await requireEnv(config)
      const timeoutMs = args.timeoutMs ?? config.defaultTimeoutMs ?? 60_000
      const cwd = resolveWorkdir(exec, args.workdir)
      const t0 = Date.now()
      const out = await runBridge(env, args.code, { cwd, timeoutMs, signal: exec.signal })
      const canonical = { ...out }
      if (canonical.result === null || canonical.result === undefined) delete canonical.result
      // bridge 捕获所有代码异常后恒返回 ok:true（traceback 写入 stderr），
      // 因此代码级失败要靠 stderr 里的 traceback 头判定，而不是 out.ok。
      const hasTraceback = /\bTraceback\s*\(most recent call last\)/.test(out.stderr ?? '')
      if (hasTraceback) canonical.needs_repair = true
      // 透明性日志：异步写，不阻塞返回（可 config.enableLog=false 关闭）
      const preview = (args.code ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      if (config.enableLog !== false) {
        appendLog({
          kind: 'bio_python',
          ok: out.ok === true && !hasTraceback,
          code_hash: codeHash(args.code ?? ''),
          code_preview: preview,
          workdir: cwd,
          stdout_len: (out.stdout ?? '').length,
          stderr_len: (out.stderr ?? '').length,
          result_type: typeof out.result,
          duration_ms: Date.now() - t0,
          timed_out: out.timedOut === true,
          needs_repair: hasTraceback,
        })
      }
      // 会话记忆：失败挂起等待配对；成功后沉淀经验 + 记成功模式
      if (config.enableMemory !== false) {
        const sig = codeSignature(args.code ?? '')
        if (hasTraceback) {
          pendingFixes.set(sig, { error_signature: errorSignature(out.stderr), failed_preview: preview })
          if (pendingFixes.size > 20) pendingFixes.delete(pendingFixes.keys().next().value)
        } else {
          const pending = pendingFixes.get(sig)
          if (pending) {
            rememberLesson({
              error_signature: pending.error_signature,
              fix_hint: preview,
              example: `${pending.failed_preview}  →  ${preview}`,
            })
            pendingFixes.delete(sig)
          }
          rememberSuccess({ signature: sig, template: preview, tool: 'bio_python' })
        }
      }
      return stampProvenance('bio_python', canonical)
    },
  })))

  // ============ 环境诊断 ============
  disposers.push(ctx.tools.register(defineTool({
    name: 'bio_env',
    description:
      '检查内置 Biopython 环境：解释器路径、Python/Biopython 版本、环境目录、' +
      '**核心库可用性清单**（libraries: bio/cobra/primer3/dnachisel/sbol3/pydna 等的安装状态与层级 builtin/auto/addon）。' +
      '写 bio_python 代码前先调本工具确认哪些库可用；某库未装时看其层级：auto=首次调用对应工具会自动安装，addon=需在设置面板安装。' +
      'reinstall=true 时重新引导环境。触发词：环境、库清单、有哪些库、库版本、环境状态、import 失败。',
    parameters: {
      reinstall: { type: 'boolean', description: '重新引导/升级环境（默认 false）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value.ready
          ? `Biopython 环境就绪（Python ${value.pythonVersion ?? '?'} / biopython ${value.biopython ?? '?'}）：${value.python}\n` +
            `可用库 ${value.n_libraries_installed ?? 0}/${(value.n_libraries_installed ?? 0) + (value.n_libraries_missing ?? 0)}` +
            (value.missing_libraries?.length ? `；未装: ${value.missing_libraries.join(', ')}` : '；全部核心库可用')
          : 'Biopython 环境未就绪，请检查网络后重试或查看 dsh 日志。',
      }],
    },
    async execute(args) {
      const env = await ensureEnvironment(config, { force: args.reinstall === true })
      if (!env.ready) {
        return {
          ready: false,
          python: env.python ?? null,
          pythonVersion: env.pythonVersion ?? null,
          envDir: env.envDir,
          bootstrapped: env.bootstrapped === true,
        }
      }
      // 环境就绪：追加核心库可用性清单（env_status op）
      let libs = null
      try {
        const res = await callBio(env.python, 'env_status', {}, { timeoutMs: 60_000 })
        if (res.ok && res.result) libs = res.result
      } catch { /* 探测失败不阻塞环境状态返回 */ }
      return {
        ready: true,
        python: env.python ?? null,
        pythonVersion: env.pythonVersion ?? null,
        biopython: env.biopython ?? null,
        numpy: env.numpy ?? null,
        envDir: env.envDir,
        bootstrapped: env.bootstrapped === true,
        ...(libs ?? {}),
      }
    },
  })))

  // ============ 执行日志查询 ============
  disposers.push(ctx.tools.register(defineTool({
    name: 'bio_log',
    description:
      '查询 dsh-bio-genie 执行日志：回溯之前 bio_python 跑过什么代码（哈希/预览/耗时/结果类型）' +
      '和语义化工具的调用记录（op/成功/耗时/错误）。日志按天落盘为 JSONL，自动 30 天轮转清理。' +
      'action=recent 返回最近 N 条；action=search 按关键词检索（如错误信息、op 名、代码片段）。' +
      '触发词：执行日志、回溯、之前跑过什么、查错误记录。',
    parameters: {
      action: { type: 'string', enum: ['recent', 'search'], description: 'recent=最近日志（默认）；search=按 query 检索' },
      query: { type: 'string', description: '检索关键词（action=search 时）' },
      limit: { type: 'number', description: '返回条数，默认 20' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value.entries && value.entries.length
          ? value.entries.map((e) => `[${e.ts}] ${e.kind}${e.op ? '/' + e.op : ''} ${e.ok ? 'ok' : 'FAIL'} ${e.duration_ms ?? ''}ms${e.cache_hit ? ' (cache)' : ''} ${e.error ?? ''} ${e.code_preview ?? ''}`.trim()).join('\n')
          : '(日志为空)',
      }],
    },
    async execute(args) {
      const entries = readLogs({
        action: args.action ?? 'recent',
        query: args.query ?? '',
        limit: args.limit ?? 20,
      })
      return { count: entries.length, entries }
    },
  })))

  // ============ 会话记忆查询 ============
  disposers.push(ctx.tools.register(defineTool({
    name: 'bio_memory',
    description:
      '查询插件的会话记忆：成功代码模式（patterns）与错误修复经验（lessons），越用越聪明。' +
      'action=patterns 列出成功模式；action=lessons 列出错误→修复经验；action=search 按关键词检索两者。' +
      '写非平凡代码前先查 patterns 是否有同类任务现成模板；bio_python 失败时查 lessons 是否命中错误签名，直接套用 fix_hint。' +
      '触发词：成功模式、修复经验、之前怎么修的、记忆。',
    parameters: {
      action: { type: 'string', enum: ['patterns', 'lessons', 'search'], description: 'patterns=成功模式（默认）；lessons=错误修复经验；search=关键词检索' },
      query: { type: 'string', description: '检索关键词（action=search 时）' },
      limit: { type: 'number', description: '返回条数，默认 10' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const items = value.items ?? []
        if (!items.length) return [{ type: 'text', text: '(记忆为空——执行过 bio_python 任务后自动累积)' }]
        const lines = items.map((e) => {
          if (e.fix_hint !== undefined) return `[lesson] ${e.error_signature} → ${e.fix_hint}`
          return `[pattern] ${e.signature || '(通用)'} :: ${e.template}`
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const limit = args.limit ?? 10
      const action = args.action ?? 'patterns'
      if (action === 'patterns') {
        const items = readPatterns().slice(0, limit)
        return { action, count: items.length, items }
      }
      if (action === 'lessons') {
        const items = readLessons().slice(0, limit)
        return { action, count: items.length, items }
      }
      const res = searchMemory(args.query ?? '')
      return { action, query: args.query ?? '', count: res.patterns.length + res.lessons.length, items: [...res.lessons, ...res.patterns].slice(0, limit) }
    },
  })))

  // ============ 目标管理（Autopilot：框架级 goal 持久化） ============
  // ctx.goals 是框架 Cordis 服务（@deepseek-ai/dsh-goal）。部署缺少该服务时
  // ctx.get('goals') 返回 undefined，工具优雅降级为提示错误。
  disposers.push(ctx.tools.register(defineTool({
    name: 'bio_goal',
    description:
      'Autopilot 目标管理：把复杂分析任务注册为框架级持久目标（带轮次预算与状态机），' +
      '配合 bio-autopilot 协议使用。action=create 创建目标（objective 必填，可选 maxGoalRounds 轮次预算）；' +
      'status 查看当前目标；pause 暂停；resume 恢复；complete 标记完成；' +
      'block 标记阻塞（reason 必填，如需用户输入用 code=need-human-input）。' +
      '触发词：创建目标、任务目标、autopilot、暂停/恢复任务。',
    parameters: {
      action: { type: 'string', enum: ['create', 'status', 'pause', 'resume', 'complete', 'block'], required: true, description: '目标操作' },
      objective: { type: 'string', description: '目标描述（action=create 必填）' },
      maxGoalRounds: { type: 'number', description: '轮次预算上限（action=create 可选，默认框架配置 256）' },
      reason: { type: 'string', description: '阻塞原因说明（action=block 必填）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const goals = ctx.get?.('goals')
      if (!goals) {
        return { ok: false, error: '当前 dsh 部署未加载 @deepseek-ai/dsh-goal 服务，目标管理不可用；可直接按 bio-autopilot 协议手工推进。' }
      }
      const agent = exec?.agent
      if (!agent) {
        return { ok: false, error: '无法获取当前 agent 上下文（goal 操作需要活跃 agent）。' }
      }
      const view = () => {
        const v = goals.get(agent)
        return v === undefined || v === null ? null : v
      }
      try {
        switch (args.action) {
          case 'create': {
            if (!args.objective) return { ok: false, error: 'action=create 需要 objective 参数。' }
            const v = goals.create(agent, {
              objective: args.objective,
              ...(args.maxGoalRounds ? { maxGoalRounds: Math.floor(args.maxGoalRounds) } : {}),
            })
            return { ok: true, action: 'create', goal: v }
          }
          case 'status':
            return { ok: true, action: 'status', goal: view() }
          case 'pause':
          case 'resume':
          case 'complete': {
            const cur = view()
            const g = cur?.goal ?? cur
            if (!g) return { ok: false, error: '当前没有活跃目标。' }
            const ref = { id: g.id, revision: g.revision }
            const v = goals[args.action](agent, ref)
            return { ok: true, action: args.action, goal: v }
          }
          case 'block': {
            if (!args.reason) return { ok: false, error: 'action=block 需要 reason 参数。' }
            const cur = view()
            const g = cur?.goal ?? cur
            if (!g) return { ok: false, error: '当前没有活跃目标。' }
            const v = goals.block(agent, { id: g.id, revision: g.revision }, {
              code: args.reason.startsWith('need-human-input') ? 'need-human-input' : 'execution-blocked',
              message: args.reason,
            })
            return { ok: true, action: 'block', goal: v }
          }
          default:
            return { ok: false, error: `未知 action: ${args.action}` }
        }
      } catch (error) {
        return { ok: false, error: `goal 操作失败: ${error?.message ?? String(error)}` }
      }
    },
  })))

  // ============ 语义化工具（高频稳定操作） ============
  for (const tool of semanticTools(config)) {
    disposers.push(ctx.tools.register(tool))
  }

  return disposers
}

/** 语义化工具清单。 */
function semanticTools(config) {
  return [
    bioTool(config, {
      name: 'bio_seq_analyze',
      description:
        '分析一条 DNA/RNA/蛋白质序列：长度、GC 含量、反向互补、三框翻译、分子量等。' +
        'seq_type 可选 auto/dna/rna/protein，默认 auto（含 U 判为 RNA）。' +
        'codon_stats=true 时（DNA 且长度 3 的倍数）返回最优密码子占比/top 密码子，' +
        'codon_host 可选 ecoli/human/yeast（默认 ecoli）——用于宿主适配快速评估。' +
        '触发词：GC含量、反向互补、序列特征、翻译、分析序列、密码子适应、CAI。',
      parameters: {
        sequence: { type: 'string', required: true, description: '核酸或蛋白质序列（内容或文件路径）' },
        seq_type: { type: 'string', enum: ['auto', 'dna', 'rna', 'protein'], description: '序列类型，默认 auto' },
        codon_stats: { type: 'boolean', description: '是否返回密码子使用统计（最优密码子占比），默认 false' },
        codon_host: { type: 'string', enum: ['ecoli', 'human', 'yeast'], description: '密码子统计宿主，默认 ecoli' },
      },
      op: 'seq_analyze',
    }),
    bioTool(config, {
      name: 'bio_seq_translate',
      description:
        '把 DNA/RNA 序列翻译成蛋白质。可用遗传密码表编号（默认 1=标准表）。' +
        'to_stop=true 时在第一个终止密码子处停止。触发词：翻译、蛋白序列、遗传密码。',
      parameters: {
        sequence: { type: 'string', required: true, description: 'DNA 或 RNA 序列（内容或文件路径）' },
        table: { type: 'number', description: '遗传密码表编号，默认 1（标准）' },
        to_stop: { type: 'boolean', description: '是否在第一个终止密码子停止，默认 false' },
      },
      op: 'seq_translate',
    }),
    bioTool(config, {
      name: 'bio_seq_gc_skew',
      description: '计算序列的 GC skew (G-C)/(G+C)，可指定窗口大小。触发词：GC skew、偏斜、复制起点。',
      parameters: {
        sequence: { type: 'string', required: true, description: 'DNA 序列（内容或文件路径）' },
        window: { type: 'number', description: '窗口大小，默认 100' },
      },
      op: 'seq_gc_skew',
    }),
    bioTool(config, {
      name: 'bio_seq_find_orf',
      description: '查找序列中最长的开放阅读框（ATG 起始到终止密码子）。触发词：ORF、开放阅读框、编码区。',
      parameters: {
        sequence: { type: 'string', required: true, description: 'DNA 序列（内容或文件路径）' },
        min_len: { type: 'number', description: '最小 ORF 长度（nt），默认 30' },
        table: { type: 'number', description: '遗传密码表编号，默认 1' },
      },
      op: 'seq_find_orf',
    }),
    bioTool(config, {
      name: 'bio_seq_kmer',
      description: '统计序列的 k-mer 频率（默认 3-mer），返回出现最多的前 N 个。触发词：k-mer、kmer、寡核苷酸频率。',
      parameters: {
        sequence: { type: 'string', required: true, description: '核酸序列（内容或文件路径）' },
        k: { type: 'number', description: 'k 值，默认 3' },
        top: { type: 'number', description: '返回前 N 个高频 k-mer，默认 10' },
      },
      op: 'seq_kmer',
    }),
    bioTool(config, {
      name: 'bio_seq_io_read',
      description:
        '读取序列文件（FASTA/GenBank 等）并返回记录摘要（id、描述、长度、序列预览）。' +
        'format 可指定 fasta/genbank，默认按扩展名推断。limit 限制返回条数（默认 50）。' +
        '触发词：读取fasta、解析序列文件、打开基因文件。',
      parameters: {
        path: { type: 'string', required: true, description: '序列文件绝对路径' },
        format: { type: 'string', enum: ['fasta', 'genbank'], description: '文件格式，默认自动推断' },
        limit: { type: 'number', description: '最多返回记录数，默认 50' },
      },
      op: 'seq_io_read',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_seq_io_write',
      description: '把序列写入文件（FASTA）。records 是 [{id, sequence, description?}] 数组。触发词：写fasta、保存序列、导出序列。',
      parameters: {
        path: { type: 'string', required: true, description: '输出文件绝对路径' },
        records: {
          type: 'array',
          required: true,
          description: '序列记录数组 [{id, sequence, description?}]',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true, description: '序列 ID' },
              sequence: { type: 'string', required: true, description: '序列内容' },
              description: { type: 'string', description: '可选描述' },
            },
          },
        },
        format: { type: 'string', enum: ['fasta', 'genbank'], description: '输出格式，默认 fasta' },
      },
      op: 'seq_io_write',
    }),
    bioTool(config, {
      name: 'bio_seq_restriction',
      description:
        '分析 DNA 序列的限制酶切位点。enzymes 指定酶名列表（如 ["EcoRI","BamHI"]），不指定则分析全部酶。' +
        'enzyme_set 控制酶库范围：commonly（默认，商业常用酶）或 all（全量含虚构酶）。' +
        'linear 表示线性还是环状（默认线性）。cut_positions 是 1-based 切割坐标（切点后第一个碱基），' +
        '返回含 coordinate_base/cut_positions_are 说明（注意：切割位置 ≠ 识别位点起始）。' +
        'detail=false（默认）摘要模式：未指定酶时每位点仅返回识别位点+计数（避免超长输出，坐标需 detail=true 或指定酶列表）；' +
        '指定酶时每酶最多 10 个坐标（count 恒为全量，超 10 带 cut_positions_truncated）。' +
        'detail=true 返回全部坐标。不指定酶时建议先看摘要再按需指定。' +
        '触发词：限制酶、酶切位点、restriction。',
      parameters: {
        sequence: { type: 'string', required: true, description: 'DNA 序列（内容或文件路径）' },
        enzymes: { type: 'array', description: '酶名列表，如 ["EcoRI"]，默认全部', items: { type: 'string' } },
        enzyme_set: { type: 'string', enum: ['commonly', 'all'], description: '酶库范围，默认 commonly（商业常用）' },
        linear: { type: 'boolean', description: '是否线性分子，默认 true' },
        detail: { type: 'boolean', description: '是否返回全部位点坐标，默认 false（摘要模式，每酶 ≤10 坐标）' },
      },
      op: 'seq_restriction',
      timeoutMs: 120_000,
    }),
    // ---- BLAST / 多序列比对 / 系统发育 ----
    bioTool(config, {
      name: 'bio_blast_search',
      description:
        '远程 BLAST 搜索（NCBI qblast）：输入序列，返回命中 accession/描述/e-value/score/一致性/比对坐标。' +
        'program 默认 blastn（可选 blastp/blastx），database 默认 nt（blastn/blastx）或 nr（blastp）。' +
        '注意：qblast 在 NCBI 服务端排队，通常耗时 1-10 分钟，属正常现象，不要重复调用。' +
        '触发词：BLAST、blastn、序列同源性搜索、远程比对。',
      parameters: {
        sequence: { type: 'string', required: true, description: '查询序列（DNA 或蛋白质，视 program 而定；内容或文件路径）' },
        program: { type: 'string', enum: ['blastn', 'blastp', 'blastx'], description: 'BLAST 程序，默认 blastn' },
        database: { type: 'string', description: '数据库，默认 nt（核酸）或 nr（蛋白）' },
        hitlist_size: { type: 'number', description: '最大命中数，默认 10' },
        expect: { type: 'number', description: 'e-value 阈值，可选' },
      },
      op: 'blast_search',
      timeoutMs: 600_000,
      cache: true,
    }),
    bioTool(config, {
      name: 'bio_msa',
      description:
        '多序列比对：输入 FASTA 序列（字符串或文件），调用本机 clustalw/muscle 二进制，' +
        '返回比对结果（Clustal + FASTA 两种格式）、共识序列与保守性统计。' +
        '二进制缺失时返回友好提示（status=program_missing）。输出可对接 bio_phylo_build 建树。' +
        '触发词：多序列比对、MSA、clustal、muscle。',
      parameters: {
        sequences: { type: 'string', description: 'FASTA 格式序列列表（与 file_path 二选一）' },
        file_path: { type: 'string', description: 'FASTA 文件路径（与 sequences 二选一）' },
        program: { type: 'string', enum: ['clustalw', 'muscle'], description: '比对程序，默认 clustalw' },
      },
      op: 'msa',
      timeoutMs: 240_000,
    }),
    bioTool(config, {
      name: 'bio_phylo_build',
      description:
        '系统发育树构建：输入多序列比对结果（alignment 字符串，可对接 bio_msa 的 alignment_fasta 输出，' +
        '或 alignment_file 路径），按 nj/upgma 建树，返回 Newick 字符串、叶节点数、总枝长；' +
        'out_file 指定时同时写 Newick 文件。触发词：系统发育树、进化树、建树、NJ 树、UPGMA。',
      parameters: {
        alignment: { type: 'string', description: '比对结果字符串（与 alignment_file 二选一）' },
        alignment_file: { type: 'string', description: '比对文件路径（与 alignment 二选一）' },
        format: { type: 'string', description: '比对格式，默认 fasta（可选 clustal/phylip 等）' },
        method: { type: 'string', enum: ['nj', 'upgma'], description: '建树方法，默认 nj' },
        out_file: { type: 'string', description: '输出 Newick 文件路径，可选' },
      },
      op: 'phylo_build',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_entrez_search',
      description:
        'NCBI Entrez 检索：esearch + esummary 摘要。db=gene 返回基因元数据（全名/染色体位置/别名/摘要），' +
        'db=nucleotide/protein 返回序列摘要。零命中（count=0）时返回 _hint 字段含放宽查询建议。' +
        '触发词：NCBI、检索基因、查基因信息、搜索序列。',
      parameters: {
        term: { type: 'string', required: true, description: '检索式，如 "TP53[Gene Name] AND human[Organism]"' },
        db: { type: 'string', description: '数据库，默认 nucleotide（gene/protein 等；gene 有结构化摘要）' },
        retmax: { type: 'number', description: '最大返回数，默认 5' },
        email: { type: 'string', description: 'NCBI 要求的邮箱（建议提供）' },
      },
      op: 'entrez_search',
      timeoutMs: 120_000,
      cache: true,
    }),
    bioTool(config, {
      name: 'bio_entrez_fetch',
      description: 'NCBI Entrez fetch：按 ID 取序列。触发词：下载序列、取序列、NCBI下载。',
      parameters: {
        ids: { type: 'array', required: true, description: 'NCBI ID 列表，如 ["NM_007294"]', items: { type: 'string' } },
        db: { type: 'string', description: '数据库，默认 nucleotide' },
        rettype: { type: 'string', description: '返回格式，默认 fasta' },
        email: { type: 'string', description: 'NCBI 要求的邮箱（建议提供）' },
      },
      op: 'entrez_fetch',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_enrichr',
      description:
        '通路/功能富集分析（Enrichr REST）：输入基因符号列表，返回显著富集的通路/GO term 及 p 值。' +
        'library 默认 GO_Biological_Process_2023，可选 GO_Molecular_Function_2023、' +
        'GO_Cellular_Component_2023、KEGG_2021_Human、Reactome_2022、MSigDB_Hallmark_2020、WikiPathway_2023_Human。' +
        '触发词：富集分析、通路富集、GO 分析、KEGG、Enrichr。',
      parameters: {
        genes: {
          type: 'array',
          required: true,
          description: '基因符号列表，如 ["TP53","BRCA1","EGFR"]（建议 5-500 个）',
          items: { type: 'string' },
        },
        library: { type: 'string', description: '富集库名，默认 GO_Biological_Process_2023' },
        top: { type: 'number', description: '返回前 N 条显著条目，默认 10' },
      },
      op: 'enrichr',
      timeoutMs: 120_000,
      cache: true,
    }),
    bioTool(config, {
      name: 'bio_pubmed_search',
      description:
        'PubMed 文献检索：返回 PMID、标题、年份、期刊、作者、DOI。' +
        'term 支持 PubMed 检索语法（如 "CRISPR gene editing"、TP53[Title]）。触发词：查文献、PubMed、论文检索。',
      parameters: {
        term: { type: 'string', required: true, description: '检索式，如 "CRISPR gene editing"' },
        retmax: { type: 'number', description: '最大返回数，默认 10' },
        email: { type: 'string', description: 'NCBI 要求的邮箱（建议提供）' },
      },
      op: 'pubmed_search',
      timeoutMs: 120_000,
      cache: true,
    }),
    bioTool(config, {
      name: 'bio_pubmed_abstract',
      description:
        '按 PMID 取文献结构化摘要：标题、摘要全文、作者、期刊、日期、DOI。' +
        'ids 是 PMID 列表。触发词：读摘要、文献摘要、PMID。',
      parameters: {
        ids: { type: 'array', required: true, description: 'PMID 列表，如 ["42603971"]', items: { type: 'string' } },
        email: { type: 'string', description: 'NCBI 要求的邮箱（建议提供）' },
      },
      op: 'pubmed_abstract',
      timeoutMs: 120_000,
      cache: true,
    }),
    bioTool(config, {
      name: 'bio_ref_genome',
      description:
        '查询参考基因组 assembly 信息（Ensembl）：assembly 名、accession、染色体列表与长度、下载目录。' +
        'species 可用常用名（human/mouse/rat/zebrafish/fly/yeast/arabidopsis）或 Ensembl 目录名（homo_sapiens）。' +
        '触发词：参考基因组、基因组版本、assembly、下载基因组。',
      parameters: {
        species: { type: 'string', required: true, description: '物种：human、mouse、homo_sapiens、mus_musculus 等' },
      },
      op: 'ref_genome',
      timeoutMs: 120_000,
      cache: true,
    }),
    // ---- 出版级绘图（figurelib，2026-08-17 吸收 scipilot/K-Dense）----
    bioTool(config, {
      name: 'bio_fig_profile',
      description:
        '科研数据剖析 + 图型建议（画图前的"顾问"步骤）：读 CSV/TSV/Excel，' +
        '返回每列类型/样本量/缺失率/分布（均值、偏度、IQR 异常值）/相关性/分组结构，' +
        '并基于数据形态给出图型建议与风险警告（小样本均值柱、偏态、跨量级等）。' +
        '画统计图前必须先跑本工具再选图型。触发词：画图、数据可视化、用什么图、箱线图、柱状图。',
      parameters: {
        path: { type: 'string', required: true, description: 'CSV/TSV/Excel 数据文件路径（绝对或相对工作区）' },
        group_cols: { type: 'array', description: '分组列名列表，如 ["group","condition"]', items: { type: 'string' } },
      },
      op: 'fig_profile',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_fig_export',
      description:
        '图文件合规审计（投稿前机器检查）：对 PDF/SVG/PNG/TIFF 检查格式、DPI、' +
        '目标尺寸偏差、PDF 字体嵌入（Type 3 拒收）。preview=true 额外生成 PNG 预览供查看。' +
        '配合 pub-figure 协议的 figurelib.export_figure 使用，形成"导出→审计→回改"闭环。' +
        '触发词：检查图片、DPI、投稿图、图合规。',
      parameters: {
        paths: { type: 'array', required: true, description: '图文件路径列表，如 ["fig1.pdf","fig1.png"]', items: { type: 'string' } },
        min_dpi: { type: 'number', description: '位图最低 DPI 要求，默认 300' },
        width_in: { type: 'number', description: '目标宽度（英寸），与 height_in 同传时校验尺寸' },
        height_in: { type: 'number', description: '目标高度（英寸）' },
        preview: { type: 'boolean', description: '是否生成 PNG 预览（默认 false）' },
      },
      op: 'fig_export',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_fig_qa',
      description:
        '绘图环境自检：探测本机 CJK 中文字体可用性 + 测试期刊样式预设（Nature/IEEE 等）能否应用。' +
        'cjk_ready=false 时中文标签必然渲染成方框——画图前先查本工具决定用中文还是英文标签。' +
        '触发词：中文字体、方框、乱码、绘图环境。',
      parameters: {
        lang: { type: 'string', enum: ['zh', 'en'], description: '目标语言，默认 zh' },
        journal: { type: 'string', enum: ['nature', 'science', 'ieee', 'general'], description: '目标期刊预设，默认 nature' },
      },
      op: 'fig_qa',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_fig_lint',
      description:
        'FIG 级出版语义 lint（画完图后立刻自检视觉选择）：红/绿对（FIG003）、' +
        'rainbow/jet colormap（FIG004）、类别数>8 禁纯色相编码（FIG005）、灰度打印坍缩（FIG015）、' +
        '误差棒语义/p 值检验元数据/exact n 是否声明（FIG008/009/010）。' +
        '规则：分类色板=Okabe-Ito；连续=viridis/cividis/batlow；diverging 必须 center=0。' +
        '触发词：检查配色、色盲、灰度、投稿自查、figure lint。',
      parameters: {
        colors_used: { type: 'array', description: '图中实际使用的颜色列表（hex，如 ["#0072B2","#D55E00"]）', items: { type: 'string' } },
        cmap_used: { type: 'string', description: '连续 colormap 名（如 viridis；用了热图/色带时必传）' },
        n_categorical: { type: 'number', description: '类别总数（分组数）' },
        err_semantics: { type: 'string', description: '误差棒语义声明，如 "mean±SEM, n=6 biological replicates"；未画误差棒传 "none"' },
        has_stat_metadata: { type: 'boolean', description: '图上 p 值/星号是否携带统计检验元数据（检验名+校正方法）' },
        n_available: { type: 'boolean', description: 'exact n 是否已在图或图注中声明' },
        min_pt: { type: 'number', description: '最小可接受字号 pt（默认 5，Nature 底线）' },
      },
      op: 'fig_lint',
      timeoutMs: 120_000,
    }),
    // ---- 代谢通路设计（2026-08-22 新增，支持代谢网络建模与通量平衡分析）----
    bioTool(config, {
      name: 'bio_metabolic_model',
      description:
        '代谢模型管理：加载、查看、列出可用模型。action=list 列出可用模型，' +
        'action=load 加载指定模型（默认 textbook，COBRApy 内置 E. coli core），action=info 显示模型详细信息。' +
        '触发词：代谢模型、SBML、代谢网络、模型加载。',
      parameters: {
        action: { type: 'string', enum: ['list', 'load', 'info'], description: '操作类型，默认 list' },
        model_id: { type: 'string', description: '模型标识，默认 textbook（COBRApy 内置）' },
        file_path: { type: 'string', description: '自定义模型文件路径（可选）' },
      },
      op: 'metabolic_model',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_fba',
      description:
        '通量平衡分析：预测代谢通量分布。analysis_type=fba（默认，最优生长+影子价格）/ ' +
        'fva（通量可变性分析，返回每个反应的 [min,max] 范围；fraction_of_optimum 针对当前目标函数，' +
        '若 objective 为产物反应则范围是「产物 ≥ fraction×产物最优」而非固定生长率——返回含 fraction_notes 说明）/ ' +
        'pfba（节俭 FBA，最小化总通量）/ ' +
        'loopless（消除热力学不可行循环）/ geometric（欧几里得通量范数最小化）/ ' +
        'optionsfva（完整通量范围，含固定反应）。' +
        'model_id 指定模型（默认 textbook，COBRApy 内置 E. coli core），objective 可指定目标函数反应。' +
        '全库 FVA 输出约 95 反应、45KB 级；只关心少数反应时务必传 reactions（逗号分隔 reaction id，' +
        '如 "EX_succ_e,PPC"）缩小输出，不存在的 id 会返回 hint 提示。' +
        '触发词：FBA、FVA、pFBA、loopless、geometric、通量平衡、通量可变性、代谢通量、生长速率预测。',
      parameters: {
        model_id: { type: 'string', description: '模型标识，默认 textbook（COBRApy 内置）' },
        objective: { type: 'string', description: '目标函数反应 ID（可选，默认使用模型目标）' },
        analysis_type: { type: 'string', enum: ['fba', 'fva', 'pfba', 'loopless', 'geometric', 'optionsfva'], description: '分析类型，默认 fba' },
        fraction_of_optimum: { type: 'number', description: 'FVA 专用：最优性比例，默认 1.0' },
        reactions: { type: 'string', description: '可选：逗号分隔的 reaction id 列表（如 "EX_succ_e,PPC"），传参时 flux/flux_ranges 输出只包含这些反应；不存在的 id 返回带 hint 的提示' },
      },
      op: 'fba',
      timeoutMs: 300_000,
    }),

    bioTool(config, {
      name: 'bio_gene_knockout',
      description:
        '基因敲除分析：analysis_type=single（默认，单基因敲除）/ double（top N 基因两两组合双敲，' +
        '找合成致死对）/ essentiality（全基因必需性扫描，essential/reduced/non-essential 分类）/ ' +
        'optknock（贪心搜最大化目标产物分泌的敲除组合：target_reaction 指定外泌反应如 EX_ac_e，' +
        'min_growth 最小生长率占比，max_knockouts 最大敲除数；返回 recommended_knockouts + flux_improvement）。' +
        'model_id 默认 textbook（COBRApy 内置 E. coli core），gene 为基因 ID（如 b0002，single 必填）。' +
        '触发词：基因敲除、双敲除、合成致死、敲除分析、必需基因、OptKnock、提升产量敲除、最大化产物分泌。',
      parameters: {
        model_id: { type: 'string', description: '模型标识，默认 textbook（COBRApy 内置）' },
        gene: { type: 'string', description: '基因 ID，如 b0002（analysis_type=single 时必填）' },
        analysis_type: { type: 'string', enum: ['single', 'double', 'essentiality', 'optknock'], description: '分析类型，默认 single' },
        top_n: { type: 'number', description: 'double 专用：单敲影响最大的候选基因数，默认 10' },
        target_reaction: { type: 'string', description: 'optknock 专用：目标反应（建议外泌反应如 EX_ac_e）' },
        min_growth: { type: 'number', description: 'optknock 专用：最小生长率（占 WT 比例），默认 0.1' },
        max_knockouts: { type: 'number', description: 'optknock 专用：最大敲除数，默认 3' },
      },
      op: 'gene_knockout',
      timeoutMs: 600_000,
    }),
    bioTool(config, {
      name: 'bio_production_envelope',
      description:
        '生产包络线：固定目标反应为优化目标，扫描另一反应（如生物量）的通量取值，' +
        '返回 vary_flux → target_flux 曲线与产物理论上限。用于评估基因改造后的产量天花板。' +
        '触发词：生产包络、production envelope、产物得率上限、产量预测。',
      parameters: {
        model_id: { type: 'string', description: '模型标识，默认 textbook（COBRApy 内置）' },
        target_reaction: { type: 'string', required: true, description: '目标反应 ID（产物，如 EX_ac_e）' },
        vary_reaction: { type: 'string', required: true, description: '扫描反应 ID（如 BIOMASS_Ecoli_core_w_GAM）' },
        points: { type: 'number', description: '扫描点数，默认 20' },
      },
      op: 'production_envelope',
      timeoutMs: 600_000,
    }),
    // ---- 代谢通路设计（2026-08-22 新增，基于KEGG数据库）----
    bioTool(config, {
      name: 'bio_pathway_search',
      description:
        '代谢通路搜索：在KEGG数据库中搜索代谢通路。target_metabolite 为目标代谢物，' +
        'organism 为生物代码（默认 eco=E. coli），limit 为返回数量。' +
        '触发词：代谢通路、通路搜索、KEGG通路、代谢途径。',
      parameters: {
        target_metabolite: { type: 'string', required: true, description: '目标代谢物，如 glucose' },
        organism: { type: 'string', description: '生物代码，默认 eco（E. coli）' },
        limit: { type: 'number', description: '返回通路数量，默认 10' },
      },
      op: 'pathway_search',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_pathway_design',
      description:
        '代谢通路设计：设计异源代谢通路。target_product 为目标产物，' +
        'host_organism 为宿主生物（默认 eco=E. coli），strategy 为设计策略。' +
        '触发词：通路设计、代谢工程、异源通路、途径设计。',
      parameters: {
        target_product: { type: 'string', required: true, description: '目标产物，如 ethanol' },
        host_organism: { type: 'string', description: '宿主生物，默认 eco（E. coli）' },
        strategy: { type: 'string', enum: ['shortest', 'max_yield', 'fewest_steps'], description: '设计策略，默认 shortest' },
      },
      op: 'pathway_design',
      timeoutMs: 120_000,
    }),
    // ---- 数据科学与机器学习（2026-08-22 新增）----
    bioTool(config, {
      name: 'bio_ml_pipeline',
      description:
        '通用 ML 管道：先划分，再逐折拟合 Pipeline；CV 仅训练集，holdout 最后一次评估。' +
        '小类别或组不足时返回不可评估，不降级随机划分。支持分类（accuracy/cv）和回归（r2/rmse）。' +
        'model 可选 random_forest/svm/logistic/linear。返回评估指标和特征重要性。' +
        '触发词：机器学习、训练模型、分类、回归、预测。',
      parameters: {
        path: { type: 'string', required: true, description: 'CSV 文件路径' },
        target: { type: 'string', required: true, description: '目标列名' },
        task: { type: 'string', enum: ['classification', 'regression'], description: '任务类型，默认 classification' },
        model: { type: 'string', enum: ['random_forest', 'svm', 'logistic', 'linear'], description: '模型类型，默认 random_forest' },
        test_size: { type: 'number', description: '测试集比例，默认 0.2' },
        cv: { type: 'number', description: '交叉验证折数，默认 5' },
        seed: { type: 'number', description: '非负整数随机种子，默认 42' },
        group_col: { type: 'string', description: '患者/组列，holdout 和 CV 内不得跨集合，且不作特征' },
        exclude_cols: { type: 'array', items: { type: 'string' }, description: '明确排除样本/患者 ID 等非特征列' },
      },
      op: 'ml_pipeline',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_ml_reduce',
      description:
        '降维分析：PCA 或 t-SNE，返回降维坐标和方差解释率。适合高维数据可视化。' +
        '触发词：PCA、t-SNE、降维、可视化。',
      parameters: {
        path: { type: 'string', required: true, description: 'CSV 文件路径' },
        method: { type: 'string', enum: ['pca', 'tsne'], description: '降维方法，默认 pca' },
        n_components: { type: 'number', description: '目标维度，默认 2' },
        perplexity: { type: 'number', description: 't-SNE 困惑度，默认 30' },
      },
      op: 'ml_reduce',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_ml_feature',
      description:
        '特征重要性分析：随机森林特征排序 + 相关性矩阵。返回 top N 重要特征。' +
        '触发词：特征选择、特征重要性、变量筛选。',
      parameters: {
        path: { type: 'string', required: true, description: 'CSV 文件路径' },
        target: { type: 'string', required: true, description: '目标列名' },
        task: { type: 'string', enum: ['classification', 'regression'], description: '任务类型' },
        top: { type: 'number', description: '返回前 N 个特征，默认 10' },
      },
      op: 'ml_feature',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_ml_cluster',
      description:
        '聚类分析：K-Means 或层次聚类，返回聚类标签、轮廓系数和簇统计。' +
        '触发词：聚类、分群、K-Means、层次聚类。',
      parameters: {
        path: { type: 'string', required: true, description: 'CSV 文件路径' },
        method: { type: 'string', enum: ['kmeans', 'hierarchical'], description: '聚类方法，默认 kmeans' },
        n_clusters: { type: 'number', description: '簇数，默认 3' },
      },
      op: 'ml_cluster',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_stats_test',
      description:
        '统计检验：自动选择 t-test / Mann-Whitney / ANOVA / 卡方检验。返回 p 值、效应量、各组描述统计。' +
        '触发词：t 检验、ANOVA、统计检验、显著性、p 值。',
      parameters: {
        path: { type: 'string', required: true, description: 'CSV 文件路径' },
        group_col: { type: 'string', required: true, description: '分组列名' },
        value_col: { type: 'string', required: true, description: '数值列名' },
        test_type: { type: 'string', enum: ['auto', 'ttest', 'mannwhitney', 'anova', 'chi2'], description: '检验类型，默认 auto' },
      },
      op: 'stats_test',
      timeoutMs: 120_000,
    }),
    // ---- 质粒库检索（2026-09-16 新增，Addgene 公开目录页零登录可达）----
    bioTool(config, {
      name: 'bio_plasmid_search',
      description:
        '检索 Addgene 质粒库（全球最大质粒库，13,000+ 条），返回 Addgene ID、名称、用途、' +
        '沉积者、相关文献、插入片段、使用场景与热门度。用于"找现成质粒"这一上游步骤——' +
        '拿到 ID 后可接 bio_plasmid_info 取全字段、再走 bio_plasmid_map/bio_clone_simulate 做下游设计。' +
        '注意：本工具只提供检索与公开元数据，不提供质粒序列（Addgene 序列下载需登录其账号）。' +
        '触发词：质粒库、找质粒、Addgene、现成质粒、质粒检索、有没有质粒。',
      parameters: {
        query: { type: 'string', required: true, description: '关键词，如 "CRISPR Cas9"、"lentiviral GFP"、"dox inducible"；支持基因名、载体类型、应用场景' },
        limit: { type: 'number', description: '返回条数，默认 20，上限 50' },
        sort: { type: 'string', enum: ['relevance', 'newest', 'oldest', 'alpha_asc', 'alpha_desc'], description: '排序，默认 relevance' },
      },
      op: 'plasmid_search',
      timeoutMs: 120_000,
      cache: true,
    }),
    bioTool(config, {
      name: 'bio_plasmid_info',
      description:
        '按 Addgene ID 取质粒完整公开元数据（30+ 字段，按节分组）：用途、载体类型、抗性、' +
        '拷贝数、生长菌株/温度、启动子、标签、插入片段尺寸、克隆位点、测序引物、载体骨架、' +
        '许可条款等，并探测该质粒的序列获取方式。' +
        '触发词：质粒详情、Addgene ID、质粒信息、质粒抗性、质粒拷贝数。',
      parameters: {
        plasmid_id: { type: 'string', required: true, description: 'Addgene 数字 ID，如 "52961"（lentiCRISPR v2）' },
      },
      op: 'plasmid_info',
      timeoutMs: 120_000,
      cache: true,
    }),
    // ---- 能力补缺（2026-09-16，对标生信 MCP 工具集的缺口，全部真实现）----
    bioTool(config, {
      name: 'bio_seq_introns',
      description:
        '内含子-外显子结构与剪接位点分析：解析 GenBank 注释里的多段 CDS/mRNA，' +
        '返回每个基因的外显子坐标、内含子坐标与长度、供体/受体二核苷酸（GT-AG 判定）。' +
        '输入 NCBI 登录号（基因组/RefSeqGene 记录，如 NG_005905）或本地 GenBank 文件。' +
        '注意：成熟 mRNA 记录（无内含子）与原核记录本就没有内含子，会明确说明。' +
        '触发词：内含子、外显子、剪接位点、基因结构、splice site。',
      parameters: {
        accession: { type: 'string', description: 'NCBI 登录号（需为基因组类记录，如 NG_/NC_）' },
        genbank_file: { type: 'string', description: '或本地 GenBank 文件路径' },
        gene: { type: 'string', description: '只分析指定基因（按 gene/locus_tag/product 匹配）' },
        max_features: { type: 'number', description: '最多返回转录本数，默认 10' },
      },
      op: 'seq_introns',
      timeoutMs: 300_000,
      cache: true,
    }),
    bioTool(config, {
      name: 'bio_seq_dotplot',
      description:
        '序列点阵图（dotplot）：滑窗一致性矩阵识别两条序列的相似区段、重复与重排，' +
        '输出 300 DPI PNG 及相似度统计。适合比对结果的直观验证（同源区段=主对角，' +
        '反向重复=副对角，串联重复=平行带）。' +
        '触发词：点阵图、dotplot、序列相似性可视化、重复序列、共线性。',
      parameters: {
        seq1: { type: 'string', required: true, description: '序列 1（内容或文件路径）' },
        seq2: { type: 'string', required: true, description: '序列 2（内容或文件路径）' },
        window: { type: 'number', description: '滑窗大小，默认 15' },
        threshold: { type: 'number', description: '窗口一致性阈值 0-1，默认 0.7' },
        output_file: { type: 'string', description: '输出 PNG 路径，默认工作区 dotplot.png' },
      },
      op: 'seq_dotplot',
      timeoutMs: 180_000,
    }),
    bioTool(config, {
      name: 'bio_uniprot',
      description:
        'UniProt 蛋白知识库查询（真实 REST API）：功能注释、翻译后修饰（PTM）、' +
        '交叉引用（PDB/InterPro/Pfam/GO/KEGG/Reactome 等 100+ 库）、通路、序列。' +
        'mode=entry 取完整条目摘要；mode=ptm 取修饰残基位点与证据码；mode=xref 取交叉引用；' +
        'mode=pathway 取通路；mode=sequence 取 FASTA；mode=search 按关键词检索。' +
        '触发词：UniProt、蛋白注释、PTM、翻译后修饰、蛋白交叉引用、蛋白通路、蛋白序列。',
      parameters: {
        accession: { type: 'string', description: 'UniProt 登录号，如 P38398（BRCA1）' },
        mode: { type: 'string', enum: ['entry', 'ptm', 'xref', 'pathway', 'sequence', 'search'], description: '查询模式，默认 entry' },
        query: { type: 'string', description: 'search 模式的检索式，如 "BRCA1 AND organism_id:9606"' },
        limit: { type: 'number', description: 'search 模式返回条数，默认 10' },
      },
      op: 'uniprot',
      timeoutMs: 120_000,
      cache: true,
    }),
    // ---- 来源审计（2026-10-10 新增）----
    bioTool(config, {
      name: 'bio_source_audit',
      description:
        '数据来源审计：把报告/交付物里的标识符与序列与权威来源逐项核验。' +
        'mode=identifiers（登录号/基因/文献 ID 的存在性 + organism/title/length/gene 比对）；' +
        'mode=sequences（序列须在记录中逐字出现或与其反向互补一致，返回 1-based 位置）；' +
        'mode=scan（从文本/文件抽取候选标识符与序列清单，不联网）。' +
        '来源与 db 取值：ncbi_nucleotide / ncbi_protein / ncbi_gene / uniprot / pdb / ensembl / pmid' +
        '（别名 nuccore→ncbi_nucleotide 已归一）。' +
        '状态严格区分：not_found=源明确无记录；unreachable=未能查询（不是准确性结论）；' +
        'mismatch=记录存在但比对失败；partial=部分项无法核验。仅报告所查项，不越界背书。' +
        '触发词：来源审计、核对来源、验证登录号、核验序列、核对引用、溯源审计、数据来源核查。',
      parameters: {
        mode: { type: 'string', enum: ['identifiers', 'sequences', 'scan'], required: true, description: '审计模式' },
        items_json: { type: 'string', description: 'identifiers/sequences：JSON 数组字符串；identifiers 条目形如 {"db":"uniprot","id":"P04637","expect":{"organism_contains":"Homo sapiens"}}，sequences 条目为 {"db","id","sequence"}' },
        items_file: { type: 'string', description: '同上，改用 JSON 文件路径（与 items_json 二选一）' },
        text: { type: 'string', description: 'scan 模式：待抽取文本（与 file 二选一）' },
        file: { type: 'string', description: 'scan 模式：待抽取文本文件路径' },
        out_md: { type: 'string', description: '可选：审计结果 Markdown 报告输出路径' },
      },
      op: 'source_audit',
      timeoutMs: 300_000,
    }),
    bioTool(config, {
      name: 'bio_phylo_compare',
      description:
        '系统发育树比较：Robinson-Foulds 距离（无根树分裂对称差）+ 归一化 RF + ' +
        '拓扑差异明细（只在一棵树中出现的分裂组成）。用于评估不同建树方法/参数/' +
        'bootstrap 阈值得到的树是否拓扑一致。两棵树的叶名须为同一套（自动剪除缺失叶并列出）。' +
        '触发词：树比较、RF 距离、拓扑差异、Robinson-Foulds、建树一致性。',
      parameters: {
        tree1: { type: 'string', required: true, description: 'Newick 字符串或文件路径' },
        tree2: { type: 'string', required: true, description: 'Newick 字符串或文件路径' },
        detail: { type: 'boolean', description: '是否返回差异分裂明细，默认 true' },
      },
      op: 'phylo_compare',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_rna_fold',
      description:
        'RNA 二级结构预测（ViennaRNA 热力学模型，首次调用自动安装）：返回最小自由能（MFE）' +
        '结构（dot-bracket）、ΔG、碱基对列表，可选集合自由能与平均碱基对距离（结构稳定性指标），' +
        '可输出结构示意图 PNG。用于设计验证与稳定性评估。' +
        '触发词：RNA 二级结构、RNA 折叠、MFE、发夹、茎环、ViennaRNA、RNA 稳定性。',
      parameters: {
        sequence: { type: 'string', required: true, description: 'RNA 序列（DNA 会自动 T→U），内容或文件路径' },
        output_file: { type: 'string', description: '可选，结构示意图 PNG 路径' },
        also_ensemble: { type: 'boolean', description: '是否附加集合自由能/平均碱基对距离，默认 true' },
      },
      op: 'rna_fold',
      timeoutMs: 180_000,
    }),
    bioTool(config, {
      name: 'bio_sc_qc',
      description:
        '单细胞 RNA-seq 质控（scanpy / scverse 最佳实践，首次调用自动安装）：' +
        '计算每细胞计数/基因数/线粒体·核糖体·血红蛋白比例 → MAD 离群过滤（默认 5/5/3）→ ' +
        '基因低检出过滤 → 出 QC 图与前后对比图 → 保存过滤后 .h5ad。' +
        '输入 .h5ad 或 10X Cell Ranger 的 .h5；species 决定线粒体基因前缀（human=MT-，mouse=mt-）。' +
        '触发词：单细胞、scRNA-seq、质控、QC、MAD 过滤、线粒体比例、h5ad、10X。',
      parameters: {
        input_file: { type: 'string', required: true, description: '.h5ad 或 10X .h5 文件路径' },
        output_dir: { type: 'string', description: '输出目录，默认工作区 sc_qc/' },
        species: { type: 'string', enum: ['human', 'mouse', 'zebrafish', 'other'], description: '物种（决定 MT-/Rps 前缀），默认 human' },
        mad_counts: { type: 'number', description: '总计数 MAD 阈值，默认 5' },
        mad_genes: { type: 'number', description: '基因数 MAD 阈值，默认 5' },
        mad_mt: { type: 'number', description: '线粒体比例 MAD 阈值，默认 3' },
        min_genes: { type: 'number', description: '细胞最少检出基因数，默认 200' },
        min_cells: { type: 'number', description: '基因最少被检出细胞数，默认 3' },
        mt_cap: { type: 'number', description: '线粒体比例硬上限（可选，叠加在 MAD 之上）' },
        apply_filter: { type: 'boolean', description: '是否保存过滤后 h5ad，默认 true' },
        make_plots: { type: 'boolean', description: '是否出图，默认 true' },
      },
      op: 'sc_qc',
      timeoutMs: 600_000,
    }),
    // ---- DNA/质粒设计（2026-08-22 新增）----
    bioTool(config, {
      name: 'bio_primer_design',
      description:
        'PCR 引物设计：输入模板序列，返回正/反向引物对（Tm、GC%、长度、位置、评分、quality/issue 标注）。' +
        'fwd_position/rev_position 为 0-based 切片索引（1-based = 索引+1）；quality=good 表示 Tm 差≤3 且 GC 40-60。' +
        '无满意候选时返回 advice 字段调整建议。支持自定义产物大小、引物长度范围、目标 Tm、top_n、tm_diff_max。' +
        '触发词：引物、PCR、Tm、引物设计。',
      parameters: {
        sequence: { type: 'string', required: true, description: '模板 DNA 序列（内容或文件路径）' },
        product_size: { type: 'number', description: '期望产物大小（bp），默认 500' },
        tm_target: { type: 'number', description: '目标 Tm（°C），默认 60' },
        top_n: { type: 'number', description: '返回候选引物对数，默认 5' },
        tm_diff_max: { type: 'number', description: '正反向 Tm 差过滤阈值（°C），默认 5' },
      },
      op: 'primer_design',
      timeoutMs: 60_000,
    }),
    bioTool(config, {
      name: 'bio_seq_optimize',
      description:
        '密码子优化：按目标宿主的密码子使用频率优化编码序列。返回优化序列、GC%、变更率。' +
        '支持 ecoli/human/yeast。触发词：密码子优化、表达优化、密码子偏好。',
      parameters: {
        sequence: { type: 'string', required: true, description: '编码序列（CDS；内容或文件路径）' },
        organism: { type: 'string', enum: ['ecoli', 'human', 'yeast'], description: '宿主生物，默认 ecoli' },
      },
      op: 'seq_optimize',
      timeoutMs: 60_000,
    }),
    bioTool(config, {
      name: 'bio_assembly_design',
      description:
        '组装策略设计：输入 DNA 片段列表，推荐组装方法（Gibson/Golden Gate/限制酶）并设计接头。' +
        '返回 protocol 与 next_step（提示下一步用 bio_clone_simulate 做环化组装模拟）。' +
        '触发词：组装、Gibson、Golden Gate、DNA 组装。',
      parameters: {
        fragments: { type: 'array', required: true, description: 'DNA 片段序列列表', items: { type: 'string' } },
        method: { type: 'string', enum: ['auto', 'gibson', 'golden_gate', 'restriction'], description: '组装方法，默认 auto' },
      },
      op: 'assembly_design',
      timeoutMs: 60_000,
    }),
    bioTool(config, {
      name: 'bio_plasmid_map',
      description:
        '质粒图谱：仅传 features → 文本注释图（mode=text，不生成文件，output_file=null）；' +
        '传 sequence（+features）或 genbank_file → 生成 PNG/SVG 图形文件（mode=graphic，' +
        '返回 output_file 绝对路径；out_file 可指定，默认工作区 <name>_map.<format>；' +
        'dna-features-viewer 缺失/渲染失败自动回退文本模式）。' +
        '支持 regulatory/cds/origin/marker 类型与 highlight_regions 高亮。' +
        '触发词：质粒图、质粒图谱、载体图谱、plasmid map。',
      parameters: {
        name: { type: 'string', description: '质粒名称，默认 plasmid' },
        size: { type: 'number', description: '总大小（bp），默认从特征推断' },
        features: { type: 'array', description: '特征列表 [{name,start,end,type,direction}]', items: { type: 'object', additionalProperties: true } },
        sequence: { type: 'string', description: '质粒序列（内容或文件路径；图形模式配合 features）' },
        genbank_file: { type: 'string', description: 'GenBank 文件路径（图形模式，可不带 features）' },
        output_format: { type: 'string', enum: ['png', 'svg'], description: '图形输出格式，默认 png' },
        out_file: { type: 'string', description: '图形输出路径（可选，默认工作区 <name>_map.<format>）' },
        figure_width: { type: 'number', description: '图宽（英寸），默认 10' },
        highlight_regions: { type: 'array', description: '可选高亮区域 [{start,end,label}]', items: { type: 'object', additionalProperties: true } },
      },
      op: 'plasmid_map',
      timeoutMs: 120_000,
    }),
    // ---- 合成生物学 Phase 1（2026-08-25，设计文档 02-Phase1-核心扩展）----
    bioTool(config, {
      name: 'bio_primer3_design',
      description:
        '工业级 PCR 引物设计（Primer3 热力学评分）：模板序列 → 候选引物对' +
        '（seq/Tm/GC%/发夹/自互补/二聚体 Tm + penalty 排序，rank 1 为推荐）。' +
        '位置字段（left/right position）为 0-based（Primer3 约定 [start, length]）。' +
        '两者区别：target_region = 要扩增的区间（引物落在区间内，产物长度自动约束为≈区间长度）；' +
        'must_include = 产物必须包含的内部区域（引物不得进入该区，故不能触及序列端点）。' +
        '扩增全长用 target_region=[0, 序列长度] 或直接省略（默认按产物长度约束）。' +
        '产物长度直接控制：product_size_range=[min, max]（bp）——显式给出产物大小区间，' +
        '优先于 target_region 推导；指定苛刻产物长度导致无解时优先用它而非逐项放宽。' +
        'n_returned=0 时返回结构化诊断（explain 原因 + 实际生效的约束），按诊断指引调整一次即可，' +
        '不要盲目逐项放宽参数。' +
        '与 bio_primer_design（Biopython 简单版）区分：本工具走 Primer3 全套二级结构约束，' +
        '适合需要可投稿级引物质量的场景。触发词：Primer3、工业级引物、qPCR 引物、引物对筛选。',
      parameters: {
        sequence: { type: 'string', required: true, description: '模板 DNA 序列（内容或文件路径）' },
        target_region: { type: 'array', description: '要扩增的区间 [start, length]（0-based）：引物落在区间内，产物长度约等于区间长度', items: { type: 'number' } },
        product_size_range: { type: 'array', description: '产物长度区间 [min, max]（bp）：直接控制产物大小，优先于 target_region 推导', items: { type: 'number' } },
        must_include: { type: 'array', description: '产物必须包含的内部区域 [start, length]（0-based）：引物不得进入该区，不能触及序列端点', items: { type: 'number' } },
        primer_size: { type: 'array', description: '引物长度范围 [min, max]，默认 [18, 25]', items: { type: 'number' } },
        tm_range: { type: 'array', description: 'Tm 范围 [min, max]，默认 [58, 65]', items: { type: 'number' } },
        gc_range: { type: 'array', description: 'GC% 范围 [min, max]，默认 [40, 60]', items: { type: 'number' } },
        max_hairpin_tm: { type: 'number', description: '发夹结构最大 Tm，默认 47' },
        max_self_any_tm: { type: 'number', description: '自互补最大 Tm，默认 47' },
        num_return: { type: 'number', description: '返回候选引物对数，默认 5' },
      },
      op: 'primer3_design',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_dna_optimize',
      description:
        '多约束 DNA 序列优化（DNA Chisel 约束求解）：EnforceTranslation 保持氨基酸不变，' +
        '同时满足去限制性位点/GC 窗口/禁用 motif 等约束，再做宿主密码子优化，返回修改报告。' +
        '与 bio_seq_optimize（简单密码子替换）区分：本工具是多约束联合优化。' +
        '触发词：多约束优化、去除酶切位点、DNA Chisel、序列工程化改造。',
      parameters: {
        protein_sequence: { type: 'string', description: '蛋白质序列（与 dna_sequence 二选一）' },
        dna_sequence: { type: 'string', description: 'DNA 序列（与 protein_sequence 二选一）' },
        host_organism: { type: 'string', description: '宿主（DNA Chisel species 名，默认 e_coli）' },
        constraints: {
          type: 'object', additionalProperties: true,
          description: '约束：remove_restriction_sites（酶名列表）/ gc_range [min,max] / avoid_motifs（序列列表）',
        },
        codon_optimize: { type: 'boolean', description: '是否做密码子优化，默认 true' },
      },
      op: 'dna_optimize',
      timeoutMs: 300_000,
    }),
    bioTool(config, {
      name: 'bio_clone_simulate',
      description:
        '克隆模拟（pydna，第二层依赖首次调用自动安装）：gibson 法检测同源臂并模拟环化组装，' +
        '返回预期产物序列；golden_gate/restriction 做位点可行性检查并给出方案建议。' +
        '触发词：克隆模拟、Gibson 组装模拟、Golden Gate、质粒构建验证。',
      parameters: {
        backbone: { type: 'string', required: true, description: '载体序列（环形）' },
        inserts: { type: 'array', required: true, description: '插入片段 [{name, sequence}]', items: { type: 'object', additionalProperties: true } },
        method: { type: 'string', enum: ['gibson', 'golden_gate', 'restriction', 'ligation'], description: '组装方法，默认 gibson' },
        overlap: { type: 'number', description: 'Gibson 同源臂长度下限（bp），默认 20' },
        restriction_enzymes: { type: 'array', description: '酶切/Golden Gate 法指定的酶（默认 BsaI）', items: { type: 'string' } },
      },
      op: 'clone_simulate',
      timeoutMs: 300_000,
    }),
    // ---- CRISPR 工具链（2026-08-25 新增）----
    bioTool(config, {
      name: 'bio_crispr_guide',
      description:
        'CRISPR sgRNA 设计（**轻量兜底层**：仅模板内 PAM 扫描 + 简化启发式效率分，非验证模型）。' +
        '若本实例已装 dsh-bio-graft（`graft_*` 工具存在），编辑设计请改用 graft_profiles → graft_design → ' +
        'graft_score → graft_offtarget（含切割位点几何、全基因组脱靶、EditPlan 账本）；' +
        '本工具的 efficiency_score 是启发式综合分，**不得**作为报告里的设计结论引用。' +
        '返回 GC/效率分/模板内 off-target 数排名靠前的 guide 候选。' +
        '效率分为基于 GC 含量+末端 poly-run+PAM 的简化预测（0-100，非实验验证）；off-target 仅扫描输入模板，全基因组扫描需用 Cas-OFFinder。' +
        '触发词：sgRNA 设计、Cas9 引导 RNA、CRISPR 设计、sgRNA 筛选、PAM 扫描。',
      parameters: {
        sequence: { type: 'string', required: true, description: '模板 DNA 序列（内容或文件路径）' },
        cas: { type: 'string', enum: ['spcas9', 'cas9_hifi', 'espcas9', 'cas12a', 'cas12e'], description: 'Cas 蛋白类型，默认 spcas9' },
        gc_min: { type: 'number', description: 'GC% 下限，默认 30' },
        gc_max: { type: 'number', description: 'GC% 上限，默认 80' },
        max_offtargets: { type: 'number', description: 'off-target 数上限，默认 10' },
        max_mismatches: { type: 'number', description: 'off-target 错配上限，默认 3' },
        top_n: { type: 'number', description: '返回候选数，默认 10' },
      },
      op: 'crispr_guide',
      timeoutMs: 60_000,
      // 语义标签（2026-09-14 设计决定：**保留行为、只改标签**，对既有用户零破坏）：
      // 明确本工具是「轻量启发式」，并据真实包探测告知是否已装深度设计器 dsh-bio-graft。
      decorate: (value) => ({
        ...value,
        scope: 'lightweight_heuristic',
        scope_note: '模板内 PAM 扫描 + 简化启发式效率分（0-100，非验证模型）：'
          + '不得作为报告/方案的设计结论引用。全基因组脱靶、切割位点几何、可审计 EditPlan、'
          + '碱基编辑等深水区设计请用 dsh-bio-graft（graft_* 工具）。',
        advanced_designer_available: advancedEditorInstalled(),
      }),
    }),
    bioTool(config, {
      name: 'bio_crispr_verify',
      description:
        'CRISPR 编辑验证（Sanger 测序分析）：对野生型与编辑后序列做全局比对（Needleman-Wunsch），' +
        '统计 indel/substitution 数量与编辑效率。仅做两序列比对，不解析 .ab1 trace 文件。' +
        '触发词：编辑验证、Sanger 比对、indel 分析、编辑效率计算、敲除验证。',
      parameters: {
        wild_type: { type: 'string', required: true, description: '野生型参考序列' },
        edited: { type: 'string', required: true, description: '编辑后序列' },
      },
      op: 'crispr_verify',
      timeoutMs: 30_000,
    }),
    // ---- DNA 合成约束检查（2026-08-25 新增）----
    bioTool(config, {
      name: 'bio_dna_syncheck',
      description:
        'DNA 合成约束检查：检测序列是否可被合成公司（Twist/IDT/GeneScript）成功合成。' +
        '检查项：长度上限、全局/窗口 GC、同聚物（≥8bp）、连续重复、潜在发夹结构、常用限制性位点（信息提示）。' +
        '输出可合成性评分（0-100）+ critical/warning/info 分级问题列表。' +
        '触发词：DNA 合成检查、可合成性评估、序列能不能合成、合成约束、Twist 兼容性。',
      parameters: {
        sequence: { type: 'string', required: true, description: 'DNA 序列（内容或文件路径）' },
        min_gc_window: { type: 'number', description: '窗口 GC 下限%，默认 25' },
        max_gc_window: { type: 'number', description: '窗口 GC 上限%，默认 65' },
        homopolymer_threshold: { type: 'number', description: '同聚物报警阈值 bp，默认 8' },
        poly_run_min: { type: 'number', description: '连续重复报警阈值 bp，默认 6' },
      },
      op: 'dna_syncheck',
      timeoutMs: 30_000,
    }),
    // ---- 湿实验方案设计（2026-08-25 新增）----
    bioTool(config, {
      name: 'bio_wetlab_design',
      description:
              '湿实验方案设计：把干实验结论转化为可执行的湿实验 protocol。**生成湿实验方案时必须用本工具**（不要手写 protocol 模板）。' +
              '返回结果自带 generation_contract（两层生成契约）：layer1_facts=代码计算的数值与领域常数（引用时标注来源）；' +
              'assumptions=模板隐含前提（须逐条对照用户现实核验，不成立则修正并标 [推断]）；adapt_points=鼓励结合场景具体化的位置；' +
              'hard_constraints=不可突破的硬约束（酶反应温度/同源臂区间/上游推导值）。' +
              '你负责结合用户现实条件（试剂库存/设备/浓度/时间/菌株）在 adapt_points 上发挥，禁止突破 hard_constraints。' +
              '支持 7 种方案类型：pcr_amplification（PCR 扩增）、gibson_assembly（Gibson 组装）、' +
              'golden_gate（Golden Gate 组装）、restriction_cloning（限制酶克隆）、' +
              'crispr_editing（CRISPR 编辑）、strain_construction（菌株构建）、transformation（转化）。' +
              '各 protocol_type 适用前提：strain_construction 仅用于基因敲除增产场景——input_data 必须含 knockouts/' +
              'recommended_knockouts（来自 bio_gene_knockout optknock）；非敲除场景（过表达/异源表达）请用 ' +
              'transformation（质粒转化）或 crispr_editing（敲入/定点编辑），误选 strain_construction 会返回 guidance 引导而非方案。' +
              '输入上游工具输出（bio_primer3_design/bio_clone_simulate/bio_crispr_guide/bio_gene_knockout optknock 等），' +
              '输出完整 protocol（试剂/条件/预期结果/质量控制/注意事项）。' +
              '触发词：湿实验方案、PCR protocol、克隆方案、CRISPR 实验方案、菌株构建方案、转化方案。',
      parameters: {
        protocol_type: { type: 'string', required: true, enum: ['pcr_amplification', 'gibson_assembly', 'golden_gate', 'restriction_cloning', 'crispr_editing', 'strain_construction', 'transformation'], description: '方案类型' },
        input_data: { type: 'object', required: true, additionalProperties: true, description: '上游工具输出（dict）' },
        host_organism: { type: 'string', description: '宿主生物，默认 e_coli' },
        scale: { type: 'string', enum: ['small', 'medium', 'large'], description: '实验规模，默认 small' },
      },
      op: 'wetlab_design',
      timeoutMs: 30_000,
    }),
    // ---- Phase 2：SBOL 3 标准化读写（第二层依赖，首次调用自动安装 sbol3/tyto）----
    bioTool(config, {
      name: 'bio_sbol_write',
      description:
        'SBOL 3 标准化设计写出：组件列表（name/type/sequence/role）→ SBOL 3 XML 文件。' +
        '每个组件生成 Component + 关联 Sequence，role 经 tyto 解析为 SO 本体 URI（如 promoter→SO:0000167）。' +
        '注意：首次调用 tyto 需解析 SO 本体，耗时可达 1-2 分钟，属正常现象，请耐心等待不要重复调用或改用自写 XML。' +
        '依赖说明：sbol3/tyto 属第二层按需依赖（auto），首次调用时自动补装。' +
        '触发词：SBOL、标准化设计、合成生物学数据交换、SBOL 导出。',
      parameters: {
        components: { type: 'array', required: true, description: '组件列表 [{name, type(dna/rna/protein/complex), sequence, role}]', items: { type: 'object', additionalProperties: true } },
        output_file: { type: 'string', required: true, description: 'SBOL 3 XML 输出路径' },
        namespace: { type: 'string', description: '命名空间 URI，默认 https://dsh-bio-genie.local/design' },
      },
      op: 'sbol_write',
      timeoutMs: 300_000,
    }),
    bioTool(config, {
      name: 'bio_sbol_read',
      description:
        'SBOL 3 标准化设计读取：SBOL 3 XML 文件 → 组件列表（name/types/roles/关联序列）。' +
        'include_sequences=true 时提取各组件的 DNA 序列（可对接 FASTA 导出）。' +
        '依赖说明：sbol3/tyto 属第二层按需依赖（auto），首次调用时自动补装。' +
        '触发词：SBOL 读取、SBOL 解析、读取标准化设计。',
      parameters: {
        sbol_file: { type: 'string', required: true, description: 'SBOL 3 XML 文件路径' },
        include_sequences: { type: 'boolean', description: '是否提取关联序列，默认 true' },
      },
      op: 'sbol_read',
      timeoutMs: 300_000,
    }),
    // ---- Phase 3：基因回路建模（第二层依赖，首次调用自动安装 biocrnpyler/bioscrape）----
    bioTool(config, {
      name: 'bio_circuit_compile',
      description:
        '基因回路编译（BioCRNpyler，第二层依赖首次调用自动安装）：组件列表' +
        '（promoter/rbs/cds/terminator，promoter 可带 regulators 调控因子）组装为 DNA 构建体，' +
        '编译为 CRN 并写出 SBML 模型，返回物种/反应数与网络拓扑图 PNG。' +
        '构建体 DNA 模板物种（dna_part_*）初始浓度默认设为 1.0（相对体系 RNAP=0.5/Ribo=10/RNase=0.25），' +
        '避免默认仿真全零；显式设置的正值不会被覆盖。' +
        'SBML 路径可直接传给 bio_circuit_simulate。触发词：基因回路、回路编译、repressilator、遗传线路。',
      parameters: {
        components: { type: 'array', required: true, description: '组件列表 [{type: promoter/rbs/cds/terminator, name, regulators?, leak?, protein?}]', items: { type: 'object', additionalProperties: true } },
        name: { type: 'string', description: '构建体名称，默认 circuit' },
        context: { type: 'string', enum: ['txtl_extract', 'expression'], description: '表达体系，默认 txtl_extract' },
        out_file: { type: 'string', description: 'SBML 输出路径（可选，默认工作区 <name>.xml）' },
      },
      op: 'circuit_compile',
      timeoutMs: 300_000,
    }),
    bioTool(config, {
      name: 'bio_circuit_simulate',
      description:
        '基因回路动力学仿真（Bioscrape）：加载 SBML 模型做 ODE/SSA 仿真，' +
        '返回各物种稳态浓度、达峰时间与浓度-时间曲线图 PNG。' +
        'parameter_overrides 只能覆盖**参数**（速率常数等），不能覆盖物种初始浓度；' +
        '覆盖键不是 SBML parameter id 时返回 invalid_overrides + hint（不报错）。' +
        '稳态全零时 note 附诊断提示（检查 DNA 模板/物种初始浓度）。' +
        '触发词：回路仿真、动力学模拟、浓度曲线、SSA 随机模拟。',
      parameters: {
        sbml_file: { type: 'string', required: true, description: 'SBML 文件路径（bio_circuit_compile 的输出）' },
        simulation_type: { type: 'string', enum: ['ode', 'ssa'], description: '仿真类型，默认 ode' },
        timepoints: { type: 'object', additionalProperties: true, description: '{start, end, points}，默认 0-200 共 200 点' },
        parameter_overrides: { type: 'object', additionalProperties: true, description: '可选参数覆盖 {参数名: 值}' },
        out_file: { type: 'string', description: '曲线图输出路径（可选）' },
      },
      op: 'circuit_simulate',
      timeoutMs: 300_000,
    }),
    // ---- Python 差异表达/GSEA 工具（正式后端：PyDESeq2 / GSEApy）----
    bioTool(config, {
      name: 'bio_deseq2',
      description:
        '差异表达分析（正式后端 PyDESeq2 0.5.4：负二项 GLM + 离散度估计 + Wald 检验；本版不执行 LFC 收缩）。counts 矩阵 + ' +
        '样本信息 → 差异基因表（gene/baseMean/log2FoldChange/lfcSE/stat/pvalue/padj + ' +
        '可选 out_csv 全量落盘）。支持单因素与多因素设计（design="~ type + condition" + ' +
        'factor/numerator/denominator 显式比较）。backend 默认 pydeseq2；旧 Welch 近似仅 ' +
        'legacy_welch 显式选择（缺包/正式后端失败不静默降级）。' +
        '触发词：差异表达、DEG、DESeq2。',
      parameters: {
        counts_file: { type: 'string', required: true, description: 'counts 矩阵 CSV（行=基因，列=样本；raw 非负整数）' },
        meta_file: { type: 'string', required: true, description: '样本信息 CSV（sample, condition 两列；多因素可加 type 等）' },
        contrast: { type: 'string', default: 'trt_vs_ctrl', description: '对比组（如 heat_vs_ctrl；格式 group1_vs_group2）' },
        design: { type: 'string', description: '设计公式（如 "~ type + condition"；默认 ~condition）' },
        factor: { type: 'string', description: '比较因子列（默认 condition）' },
        numerator: { type: 'string', description: '多因素时分子组（与 denominator 成对）' },
        denominator: { type: 'string', description: '多因素时分母组' },
        backend: { type: 'string', enum: ['pydeseq2', 'legacy_welch'], description: '后端（默认 pydeseq2；legacy_welch 为旧近似）' },
        out_csv: { type: 'string', description: '可选：全量结果表落盘路径' },
      },
      op: 'deseq2',
      timeoutMs: 300_000,
    }),
    bioTool(config, {
      name: 'bio_gsea',
      description: 'GSEA 富集分析（GSEApy 正式 prerank）。差异表达**完整排序表** + GMT 或命名库 ' +
        '→ ES/NES/nominal p/FDR/leading edge（禁止 ES×10 简化）。ranking_column 默认 stat ' +
        '（全量受检基因，不取 DEG/top10）；固定 seed/permutation。' +
        '触发词：GSEA、富集、prerank。',
      parameters: {
        de_results_file: { type: 'string', required: true, description: '差异表达完整结果 CSV（含 gene + 排序列）' },
        ranking_column: { type: 'string', default: 'stat', description: '排序列（默认 stat；缺列明确失败，可显式指定 log2FoldChange）' },
        gene_set_file: { type: 'string', description: 'GMT 文件路径（用户提供）' },
        gene_sets: { type: 'string', description: 'gseapy 命名库（如 MSigDB_Hallmark_2020）；与 gene_set_file 二选一' },
        permutation_num: { type: 'number', description: '排列数（默认 1000）' },
        min_size: { type: 'number', description: '最小集合规模（默认 15）' },
        max_size: { type: 'number', description: '最大集合规模（默认 500）' },
        seed: { type: 'number', description: '随机种子（默认 42）' },
        species: { type: 'string', description: 'rank 数据物种（如 human；未知时标未核验）' },
        id_namespace: { type: 'string', description: 'rank 基因 ID 命名空间（如 gene_symbol）' },
        gene_set_species: { type: 'string', description: 'GMT 基因集物种声明（与 rank 冲突则拒绝）' },
        gene_set_id_namespace: { type: 'string', description: 'GMT 基因 ID 命名空间声明' },
        gene_set_source: { type: 'string', description: 'GMT 来源名称' },
        gene_set_version: { type: 'string', description: 'GMT/命名库来源版本' },
        gene_set_license_source: { type: 'string', description: '许可信息来源 URL/文档' },
        out_csv: { type: 'string', description: '完整结果表落盘路径（可选）' },
      },
      op: 'gsea',
      timeoutMs: 300_000,
    }),
    // ============ design 通道：casefile validate / export（B1-part-2）============
    // 独立 designTool 路径（D5.5）；opts.op ↔ bio_ops.OPS 双向验收见
    // test/design-casefile-tools.mjs。validate 失败非零退出；export 先过 validate 门禁。
    designTool(config, {
      name: 'design_casefile_validate',
      description:
        'design casefile 验证（正式工具级，B1-part-2）：绑定不可变 snapshot，逐检查项验证——' +
        'snapshot 绑定/manifest 与磁盘 hash 一致/全工件 schema/三条红线反向核查（R1 CRN≠GEM、' +
        'R2 分数≠bound、R3 proxy≠capacity）/DAG 无环/缺 manifest 条目。任一 required check FAIL ' +
        '→ INVALID_INPUT + 非零退出 + 禁止 export。返回 C4 信封 {status, reason_code, artifact_refs, detail} + checks[]。' +
        '触发词：validate casefile、验证 case、casefile 检查、红线核查。',
      parameters: {
        casefile_dir: { type: 'string', required: true, description: 'casefile 根目录（绝对路径，或相对工作区；须在工作区内且已存在）' },
        strict: { type: 'boolean', default: true, description: '严格模式（默认 true；v0 阶段全部检查项均为 required）' },
      },
      op: 'design_casefile_validate',
      timeoutMs: 300_000,
    }),
    designCasefileExportTool(config),
    // ============ design 通道：design_consequence（B1 收口批次）============
    // 独立 designTool 路径（D5.5）；opts.op ↔ bio_ops.OPS 双向验收见
    // test/design-consequence-tools.mjs。门禁（BLOCKED/NOT_RUN/INVALID_INPUT）exit 0
    // + 扁平 C4 信封（不误判为 worker 崩溃）；consequence_run 落盘 staging + sha 引用。
    designTool(config, {
      name: 'design_consequence',
      description:
        '设计后果推理（design 通道，B1 收口）：把已注册、哈希绑定的 coupling_profile@1 施加到固定 GEM ' +
        '（iML1515 + card）上 → consequence_run@1：baseline FBA + 逐声明场景 FBA/FVA + 逐 claim_target 的 ' +
        'direction（growth 方向预测：ROBUST_DIRECTION/MIXED/INDETERMINATE/NOT_RUN）。门禁逐条 fail-closed：' +
        'model_ref 缺失/哈希不符/card 缺失 → BLOCKED；strain 不匹配 → BLOCKED；rule 全 miss → NOT_RUN ' +
        '（禁猜映射）；qualitative_direction → NOT_RUN NO_QUANTITATIVE_COUPLING（禁含 FBA/FVA 数值）；' +
        '任一声明场景求解失败 → 相关 claim INDETERMINATE（禁止挑选剩余场景）；未登记/哈希不符工件引用 → ' +
        'INVALID_INPUT。medium 必填（不支持默认富培养基）；objective 默认 biomass。返回 C4 信封 ' +
        '{status, reason_code, artifact_refs, detail}；consequence_run 落盘引用（B1P1 artifacts 模式）。' +
        '触发词：设计后果、consequence、耦合后果推理、growth 方向预测。',
      parameters: {
        model_ref: { type: 'object', additionalProperties: true, required: true, description: 'metabolic_model_ref@1：{sbml_path, expected_sbml_sha256, card_path}（v0 接线：内嵌已解析路径；哈希绑定，读前重哈希）' },
        coupling_profile: { type: 'object', additionalProperties: true, required: true, description: 'coupling_profile@1 值：{coupling_mode?, rules: [{rule_id, reaction_id, operation, derived_bound, unit?}]}（已注册、哈希绑定语义；rule 未命中 → NOT_RUN，禁猜映射）' },
        medium: { type: 'array', required: true, description: '显式培养基（exchange bounds；必填，不支持默认富培养基）', items: { type: 'object', additionalProperties: true } },
        objective: { type: 'string', default: 'biomass', description: '目标反应（默认 biomass；场景可覆盖）' },
        scenarios: { type: 'array', required: true, description: '声明场景集 [{scenario_id, target_reaction?, modifications?}]（任一声明场景求解失败 → 相关 claim INDETERMINATE）', items: { type: 'object', additionalProperties: true } },
        casefile_dir: { type: 'string', description: 'casefile 目录（可选；须在工作区内且已存在；绑定后提交 audit overlay）' },
        strict: { type: 'boolean', default: true, description: '严格模式（默认 true；只改变诊断详略，不放松门禁）' },
      },
      op: 'design_consequence',
      timeoutMs: 300_000,
    }),
    // ============ design 通道：宿主侧三工具（B1-part-1，designHostTool）============
    // bio_chassis_profile：FASTA（+可选 GFF/GB/segments_tsv 注释）→ genome_ref@1 + host_profile@1。
    // 门禁：文件哈希必须成功（BLOCKED HASH_FAILED）；坐标体系未声明（BLOCKED
    // COORD_CONVENTION_UNDECLARED）；重复 contig 名（BLOCKED DUPLICATE_CONTIG_NAME）。
    // 输出宿主侧证据状态（不声明产品档位；不含 GEM growth 锚点）。触发词：底盘档案、
    // host profile、chassis profile、宿主画像、GC/密码子统计。
    designHostTool(config, {
      name: 'bio_chassis_profile',
      description:
        '宿主底盘档案（design 通道 B1-part-1）：Biopython 解析 FASTA（GFF3/GenBank/segments_tsv 注释可选）→ ' +
        'genome_ref@1 + host_profile@1（GC/密码子/contig 统计 + 注释/条件/parts 证据完整度状态）。' +
        '门禁逐条 fail-closed：文件哈希不符/缺失 → BLOCKED HASH_FAILED；坐标体系未声明 → BLOCKED ' +
        'COORD_CONVENTION_UNDECLARED；重复 contig 名 → BLOCKED DUPLICATE_CONTIG_NAME。输出不含 GEM ' +
        'growth 锚点（consequence 验收）；不声明产品档位。',
      parameters: {
        genome_files: { type: 'array', required: true, description: '基因组输入文件列表 [{path, format}]：path 为工作区内绝对路径；format ∈ fasta|gff3|genbank|segments_tsv（至少一个 fasta）', items: { type: 'object', additionalProperties: true } },
        coord_convention: { type: 'string', enum: ['0-based-half-open', '1-based-inclusive'], required: true, description: '坐标体系（必须显式声明）' },
        contig_topology: { type: 'object', additionalProperties: true, description: '{contig 名: linear|circular}；缺省 linear' },
        condition: { type: 'object', additionalProperties: true, description: '培养条件（可空字段显式 null）' },
        parts_evidence_file: { type: 'object', additionalProperties: true, description: 'parts 证据文件 {path}' },
        genome_source: { type: 'string', description: '基因组来源标注（默认 user-supplied-genome）' },
        strict: { type: 'boolean', default: true, description: '严格模式（只改变诊断详略，不放松门禁）' },
        casefile_dir: { type: 'string', description: 'casefile 目录（可选；绑定后提交输入快照与产物）' },
      },
      op: 'design_chassis_profile',
      allowedOutputs: [
        { logical_name: 'genome_ref.json', artifact_type: 'genome_ref', required: false },
        { logical_name: 'host_profile.json', artifact_type: 'host_profile', required: false },
      ],
      timeoutMs: 120_000,
    }),
    // bio_integration_candidates：host_profile + cassette → integration_candidate@1[]（≤top_n=16）。
    // ruleset 强制消费 design/integration-ruleset/integration-ruleset-v0.json（unknown_policy=block：
    // 未知注释/重复/必需性不得默认为通过）；缺资产 → BLOCKED RULESET_UNAVAILABLE；无注释/注释不可信
    // → NOT_RUN；环状跨 origin 显式处理；不得输出 safe 分类。触发词：整合位点、integration site、
    // 插入候选、基因组整合。
    designHostTool(config, {
      name: 'bio_integration_candidates',
      description:
        '基因组整合位点候选（design 通道 B1-part-1）：按正式 integration-ruleset（feature_overlap / ' +
        'repeat / essentiality / neighborhood / motif 强制 + contextual_stability 提示）对候选窗口逐条评估 → ' +
        'integration_candidate@1[]（≤top_n）。cassette 序列/长度二分：只有长度 → sequence_identity=unknown ' +
        '仅初步空间筛选。环状跨 origin 窗口显式处理；origin/表达证据按参数声明。触发词：整合位点候选、' +
        'integration candidates、插入位点扫描。',
      parameters: {
        host_profile: { type: 'object', additionalProperties: true, description: 'host_profile@1 值（或提供 host_profile_ref 解析）' },
        host_profile_ref: { type: 'object', additionalProperties: true, description: '已登记 host_profile 的 artifactRef {artifact_id,...}（优先于嵌入值）' },
        genome_ref_value: { type: 'object', additionalProperties: true, description: 'genome_ref@1 值（可随 host_profile_ref 自动解析）' },
        genome_files: { type: 'array', required: true, description: 'FASTA 列表 [{path, format}]（序列必须与 host_profile.genome_ref 一致）', items: { type: 'object', additionalProperties: true } },
        cassette: { type: 'object', additionalProperties: true, required: true, description: '{sequence?|payload_length?}（至少其一；sequence_sha256 可选）' },
        candidates: { type: 'array', description: '显式窗口 [{contig, start, end}]（0-based；环状 end<start 表示跨 origin）', items: { type: 'object', additionalProperties: true } },
        scan: { type: 'boolean', description: 'scan=true 按 payload 步长全基因组扫描（与 candidates 互斥）' },
        top_n: { type: 'number', default: 10, description: '输出候选数上限（≤16，dispatch 文件上限）' },
        ruleset_path: { type: 'string', description: 'ruleset 资产路径（默认 design/integration-ruleset/integration-ruleset-v0.json）' },
        exclude_rules: { type: 'array', description: '跳过的 rule_id 列表（不计入 coverage）', items: { type: 'string' } },
        origin_positions: { type: 'object', additionalProperties: true, description: '{contig: 复制起点位置}；环状缺省 0' },
        essentiality_evidence: { type: 'object', additionalProperties: true, description: '必需性证据 {path}（JSON：genes[]）' },
        expression_evidence: { type: 'object', additionalProperties: true, description: '表达证据 {path}（JSON：high_expression_genes[]）' },
        evidence_items: { type: 'array', description: 'evidence_item@1 列表（literature_characterized 仅当 exact 命中）', items: { type: 'object', additionalProperties: true } },
        strict: { type: 'boolean', default: true },
        casefile_dir: { type: 'string', description: 'casefile 目录（可选）' },
      },
      op: 'design_integration_candidates',
      allowedOutputs: Array.from({ length: 16 }, (_, i) => ({
        logical_name: 'integration_candidate-' + String(i + 1).padStart(2, '0') + '.json',
        artifact_type: 'integration_candidate',
        required: false,
      })),
      timeoutMs: 180_000,
    }),
    // bio_circuit_contextualize：circuit + host_profile → expression_scenario@1（+ kinetic_crn_ref@1）。
    // coupling_mode 仅产耦合草案（不可定量授权）；无证据/无模型 → 只给 rank + risk，禁止绝对表达；
    // ostir 走可选依赖 + preflight（不可用 → DEPENDENCY_UNAVAILABLE，不静默降级）。触发词：表达情景、
    // circuit contextualize、元件排名、耦合草案。
    designHostTool(config, {
      name: 'bio_circuit_contextualize',
      description:
        '回路表达情景化（design 通道 B1-part-1）：circuit components[] + host_profile → expression_scenario@1 ' +
        '（元件证据查表排名，禁绝对表达——无证据元件只给 rank）。coupling_mode 仅生成耦合草案，不构成定量授权；' +
        '可选 kinetic_crn_ref@1 封装现有 bio_circuit_compile 输出；ostir_proxy 走可选依赖 preflight（不可用 → ' +
        'DEPENDENCY_UNAVAILABLE）。触发词：表达情景、元件排名、circuit contextualize、耦合草案。',
      parameters: {
        circuit: { type: 'object', additionalProperties: true, required: true, description: '{components: [{component_id, kind, sequence?}], template?, sbol_file?}' },
        host_profile: { type: 'object', additionalProperties: true, description: 'host_profile@1 值（或 host_profile_ref）' },
        host_profile_ref: { type: 'object', additionalProperties: true, description: '已登记 host_profile 的 artifactRef {artifact_id,...}' },
        genome_ref_value: { type: 'object', additionalProperties: true, description: 'genome_ref@1 值（可自动解析）' },
        coupling_mode: { type: 'string', enum: ['qualitative_direction', 'user_calibrated_bound', 'evidence_calibrated_bound'], default: 'qualitative_direction', description: '耦合模式（仅产草案）' },
        parts_evidence: { type: 'json', description: '元件证据：数组 [{part_id, evidence_level, source_id?, rank_hint?}] 或 {path}' },
        ostir_request: { type: 'object', additionalProperties: true, description: '可选 ostir proxy 请求 {sequence, label?}（preflight 失败 → DEPENDENCY_UNAVAILABLE）' },
        crn_sbml_ref: { type: 'object', additionalProperties: true, description: 'bio_circuit_compile 输出 SBML 的 artifactRef {artifact_id,...}（须已登记）' },
        strict: { type: 'boolean', default: true },
        casefile_dir: { type: 'string' },
      },
      op: 'design_circuit_contextualize',
      allowedOutputs: [
        { logical_name: 'circuit_design.json', artifact_type: 'circuit_design', required: false },
        { logical_name: 'expression_scenario.json', artifact_type: 'expression_scenario', required: false },
        { logical_name: 'kinetic_crn_ref.json', artifact_type: 'kinetic_crn_ref', required: false },
      ],
      timeoutMs: 180_000,
    }),
  ]
}

function renderBioPython(_args, value) {
  if (value.ok === false) {
    const detail = value.error || value.stderr || 'unknown error'
    const hint = value.needs_repair
      ? '\n(needs_repair: 根据 stderr 修复代码后重新调用 bio_python，最多修复 2 次)'
      : ''
    return [{ type: 'text', text: `bio_python failed: ${detail}${hint}` }]
  }
  const parts = []
  if (value.needs_repair) {
    parts.push('[needs_repair] 代码抛异常（见下方 stderr）——根据 stderr 修复后重新调用 bio_python，最多修复 2 次')
  }
  if (value.stdout) parts.push(value.stdout)
  if (value.stderr) parts.push(`[stderr]\n${value.stderr}`)
  if (value.result !== undefined && value.result !== null) {
    parts.push(`[result]\n${JSON.stringify(value.result)}`)
  }
  if (value.timedOut) parts.push('[timed out]')
  return [{ type: 'text', text: parts.join('\n') || '(no output)' }]
}



