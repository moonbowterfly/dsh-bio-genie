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
import { runBridge, callBio } from './python.js'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { resolveWorkdir, fallbackWorkspace } from './workdir.js'
import { cacheGet, cacheSet, throttle } from './throttle.js'
import { appendLog, codeHash, readLogs } from './log.js'
import {
  codeSignature, errorSignature, rememberSuccess, rememberLesson,
  readPatterns, readLessons, searchMemory,
} from './memory.js'
import { stampProvenance } from './provenance.js'

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
      const deps = await ensureExtraDeps(opts.op, py)
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
      if (cacheKey) cacheSet(cacheKey, res.result)
      // 计算防火墙：返回值挂 _provenance 背书字段（台账记录由 rigor-guard 的
      // tools/post-execute 钩子统一完成，那里拿得到 agent 上下文）
      return stampProvenance(opts.name, res.result)
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
      workdir: { type: 'string', description: '工作目录（绝对路径，或相对默认工作区的相对路径）。默认：会话工作区；会话工作区未指定时用 ~/deepseek-harness/bio-genie-workspace。' },
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
      '和语义化工具的调用记录（op/成功/耗时/错误）。' +
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
        sequence: { type: 'string', required: true, description: '核酸或蛋白质序列' },
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
        sequence: { type: 'string', required: true, description: 'DNA 或 RNA 序列' },
        table: { type: 'number', description: '遗传密码表编号，默认 1（标准）' },
        to_stop: { type: 'boolean', description: '是否在第一个终止密码子停止，默认 false' },
      },
      op: 'seq_translate',
    }),
    bioTool(config, {
      name: 'bio_seq_gc_skew',
      description: '计算序列的 GC skew (G-C)/(G+C)，可指定窗口大小。触发词：GC skew、偏斜、复制起点。',
      parameters: {
        sequence: { type: 'string', required: true, description: 'DNA 序列' },
        window: { type: 'number', description: '窗口大小，默认 100' },
      },
      op: 'seq_gc_skew',
    }),
    bioTool(config, {
      name: 'bio_seq_find_orf',
      description: '查找序列中最长的开放阅读框（ATG 起始到终止密码子）。触发词：ORF、开放阅读框、编码区。',
      parameters: {
        sequence: { type: 'string', required: true, description: 'DNA 序列' },
        min_len: { type: 'number', description: '最小 ORF 长度（nt），默认 30' },
        table: { type: 'number', description: '遗传密码表编号，默认 1' },
      },
      op: 'seq_find_orf',
    }),
    bioTool(config, {
      name: 'bio_seq_kmer',
      description: '统计序列的 k-mer 频率（默认 3-mer），返回出现最多的前 N 个。触发词：k-mer、kmer、寡核苷酸频率。',
      parameters: {
        sequence: { type: 'string', required: true, description: '核酸序列' },
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
        sequence: { type: 'string', required: true, description: 'DNA 序列' },
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
        sequence: { type: 'string', required: true, description: '查询序列（DNA 或蛋白质，视 program 而定）' },
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
        'fva（通量可变性分析，返回每个反应的 [min,max] 范围）/ pfba（节俭 FBA，最小化总通量）/ ' +
        'loopless（消除热力学不可行循环）/ geometric（欧几里得通量范数最小化）/ ' +
        'optionsfva（完整通量范围，含固定反应）。' +
        'model_id 指定模型（默认 textbook，COBRApy 内置 E. coli core），objective 可指定目标函数反应。' +
        '触发词：FBA、FVA、pFBA、loopless、geometric、通量平衡、通量可变性、代谢通量、生长速率预测。',
      parameters: {
        model_id: { type: 'string', description: '模型标识，默认 textbook（COBRApy 内置）' },
        objective: { type: 'string', description: '目标函数反应 ID（可选，默认使用模型目标）' },
        analysis_type: { type: 'string', enum: ['fba', 'fva', 'pfba', 'loopless', 'geometric', 'optionsfva'], description: '分析类型，默认 fba' },
        fraction_of_optimum: { type: 'number', description: 'FVA 专用：最优性比例，默认 1.0' },
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
        '通用 ML 管道：读 CSV → 训练模型 → 评估。支持分类（accuracy/cv）和回归（r2/rmse）。' +
        'model 可选 random_forest/svm/logistic/linear。返回评估指标和特征重要性。' +
        '触发词：机器学习、训练模型、分类、回归、预测。',
      parameters: {
        path: { type: 'string', required: true, description: 'CSV 文件路径' },
        target: { type: 'string', required: true, description: '目标列名' },
        task: { type: 'string', enum: ['classification', 'regression'], description: '任务类型，默认 classification' },
        model: { type: 'string', enum: ['random_forest', 'svm', 'logistic', 'linear'], description: '模型类型，默认 random_forest' },
        test_size: { type: 'number', description: '测试集比例，默认 0.2' },
        cv: { type: 'number', description: '交叉验证折数，默认 5' },
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
    // ---- DNA/质粒设计（2026-08-22 新增）----
    bioTool(config, {
      name: 'bio_primer_design',
      description:
        'PCR 引物设计：输入模板序列，返回正/反向引物对（Tm、GC%、长度、位置、评分、quality/issue 标注）。' +
        'fwd_position/rev_position 为 0-based 切片索引（1-based = 索引+1）；quality=good 表示 Tm 差≤3 且 GC 40-60。' +
        '无满意候选时返回 advice 字段调整建议。支持自定义产物大小、引物长度范围、目标 Tm、top_n、tm_diff_max。' +
        '触发词：引物、PCR、Tm、引物设计。',
      parameters: {
        sequence: { type: 'string', required: true, description: '模板 DNA 序列' },
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
        sequence: { type: 'string', required: true, description: '编码序列（CDS）' },
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
        sequence: { type: 'string', description: '质粒序列（图形模式，配合 features 使用）' },
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
        '与 bio_primer_design（Biopython 简单版）区分：本工具走 Primer3 全套二级结构约束，' +
        '适合需要可投稿级引物质量的场景。触发词：Primer3、工业级引物、qPCR 引物、引物对筛选。',
      parameters: {
        sequence: { type: 'string', required: true, description: '模板 DNA 序列' },
        target_region: { type: 'array', description: '目标扩增区域 [start, length]（0-based）', items: { type: 'number' } },
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
        'CRISPR sgRNA 设计：扫描模板序列中的 PAM 位点（支持 SpCas9/Cas12a/Cas12e），' +
        '返回 GC/效率分/off-target 数排名靠前的 guide 候选。' +
        '效率分为基于 GC 含量+末端 poly-run+PAM 的简化预测（0-100，非实验验证）；off-target 仅扫描输入模板，全基因组扫描需用 Cas-OFFinder。' +
        '触发词：sgRNA 设计、Cas9 引导 RNA、CRISPR 设计、sgRNA 筛选、PAM 扫描。',
      parameters: {
        sequence: { type: 'string', required: true, description: '模板 DNA 序列' },
        cas: { type: 'string', enum: ['spcas9', 'cas9_hifi', 'espcas9', 'cas12a', 'cas12e'], description: 'Cas 蛋白类型，默认 spcas9' },
        gc_min: { type: 'number', description: 'GC% 下限，默认 30' },
        gc_max: { type: 'number', description: 'GC% 上限，默认 80' },
        max_offtargets: { type: 'number', description: 'off-target 数上限，默认 10' },
        max_mismatches: { type: 'number', description: 'off-target 错配上限，默认 3' },
        top_n: { type: 'number', description: '返回候选数，默认 10' },
      },
      op: 'crispr_guide',
      timeoutMs: 60_000,
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
        sequence: { type: 'string', required: true, description: 'DNA 序列' },
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
        '湿实验方案设计：把干实验结论转化为可执行的湿实验 protocol。' +
        '支持 7 种方案类型：pcr_amplification（PCR 扩增）、gibson_assembly（Gibson 组装）、' +
        'golden_gate（Golden Gate 组装）、restriction_cloning（限制酶克隆）、' +
        'crispr_editing（CRISPR 编辑）、strain_construction（菌株构建）、transformation（转化）。' +
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
    // ---- Phase 2：SBOL 3 标准化读写 ----
    bioTool(config, {
      name: 'bio_sbol_write',
      description:
        'SBOL 3 标准化设计写出：组件列表（name/type/sequence/role）→ SBOL 3 XML 文件。' +
        '每个组件生成 Component + 关联 Sequence，role 经 tyto 解析为 SO 本体 URI（如 promoter→SO:0000167）。' +
        '触发词：SBOL、标准化设计、合成生物学数据交换、SBOL 导出。',
      parameters: {
        components: { type: 'array', required: true, description: '组件列表 [{name, type(dna/rna/protein/complex), sequence, role}]', items: { type: 'object', additionalProperties: true } },
        output_file: { type: 'string', required: true, description: 'SBOL 3 XML 输出路径' },
        namespace: { type: 'string', description: '命名空间 URI，默认 https://dsh-bio-genie.local/design' },
      },
      op: 'sbol_write',
      timeoutMs: 60_000,
    }),
    bioTool(config, {
      name: 'bio_sbol_read',
      description:
        'SBOL 3 标准化设计读取：SBOL 3 XML 文件 → 组件列表（name/types/roles/关联序列）。' +
        'include_sequences=true 时提取各组件的 DNA 序列（可对接 FASTA 导出）。' +
        '触发词：SBOL 读取、SBOL 解析、读取标准化设计。',
      parameters: {
        sbol_file: { type: 'string', required: true, description: 'SBOL 3 XML 文件路径' },
        include_sequences: { type: 'boolean', description: '是否提取关联序列，默认 true' },
      },
      op: 'sbol_read',
      timeoutMs: 60_000,
    }),
    // ---- Phase 3：基因回路建模（第二层依赖，首次调用自动安装 biocrnpyler/bioscrape）----
    bioTool(config, {
      name: 'bio_circuit_compile',
      description:
        '基因回路编译（BioCRNpyler，第二层依赖首次调用自动安装）：组件列表' +
        '（promoter/rbs/cds/terminator，promoter 可带 regulators 调控因子）组装为 DNA 构建体，' +
        '编译为 CRN 并写出 SBML 模型，返回物种/反应数与网络拓扑图 PNG。' +
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
        '返回各物种稳态浓度、达峰时间与浓度-时间曲线图 PNG。支持 parameter_overrides 覆盖参数。' +
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
    // ---- Python 差异表达/GSEA 工具（替代 R 引擎）----
    bioTool(config, {
      name: 'bio_deseq2',
      description: '差异表达分析（Python）：counts 矩阵 + 样本信息 → 差异基因表。触发词：差异表达。',
      parameters: {
        counts_file: { type: 'string', required: true, description: 'counts 矩阵 CSV' },
        meta_file: { type: 'string', required: true, description: '样本信息 CSV' },
        contrast: { type: 'string', default: 'trt_vs_ctrl', description: '对比组' },
      },
      op: 'deseq2',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_gsea',
      description: 'GSEA 富集分析（Python）：差异表达结果 → 富集通路。触发词：GSEA、富集。',
      parameters: {
        de_results_file: { type: 'string', required: true, description: '差异表达结果 CSV' },
        gene_sets: { type: 'string', default: 'hallmark', description: '基因集' },
      },
      op: 'gsea',
      timeoutMs: 120_000,
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


    