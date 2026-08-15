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
import { resolve } from 'node:path'
import { ensureEnvironment, venvPython, resolveEnvDir } from './runtime.js'
import { runBridge, callBio } from './python.js'

/** 引导可能耗时数分钟；工具执行期间等待引导完成。 */
const BOOT_WAIT_MS = 600_000

/** 确保环境就绪并返回 python 路径；失败抛错。 */
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
      const py = await requireEnv(config)
      const res = await callBio(py, opts.op, args, { timeoutMs: callTimeout, signal: exec.signal })
      if (!res.ok) throw new Error(res.error ?? 'bio op failed')
      return res.result
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
      workdir: { type: 'string', description: '工作目录（绝对路径，或相对工作区）。默认工作区。' },
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
        },
      },
      render: renderBioPython,
    },
    async execute(args, exec) {
      const env = await requireEnv(config)
      const timeoutMs = args.timeoutMs ?? config.defaultTimeoutMs ?? 60_000
      const cwd = resolveWorkdir(args.workdir)
      const out = await runBridge(env, args.code, { cwd, timeoutMs, signal: exec.signal })
      const canonical = { ...out }
      if (canonical.result === null || canonical.result === undefined) delete canonical.result
      return canonical
    },
  })))

  // ============ 环境诊断 ============
  disposers.push(ctx.tools.register(defineTool({
    name: 'bio_env',
    description:
      '检查内置 Biopython 环境：解释器路径、Python/Biopython/numpy 版本、环境目录。' +
      '用于诊断 import 失败。reinstall=true 时重新引导环境。触发词：环境、biopython版本、环境状态。',
    parameters: {
      reinstall: { type: 'boolean', description: '重新引导/升级环境（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ready: { type: 'boolean', required: true },
          python: { type: 'string' },
          pythonVersion: { type: 'string' },
          biopython: { type: 'string' },
          numpy: { type: 'string' },
          envDir: { type: 'string', required: true },
          bootstrapped: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ready
          ? `Biopython 环境就绪（Python ${value.pythonVersion ?? '?'} / biopython ${value.biopython ?? '?'} / numpy ${value.numpy ?? '?'}）：${value.python}`
          : 'Biopython 环境未就绪，请检查网络后重试或查看 dsh 日志。',
      }],
    },
    async execute(args) {
      const env = await ensureEnvironment(config, { force: args.reinstall === true })
      return {
        ready: env.ready === true,
        python: env.python ?? null,
        pythonVersion: env.pythonVersion ?? null,
        biopython: env.biopython ?? null,
        numpy: env.numpy ?? null,
        envDir: env.envDir,
        bootstrapped: env.bootstrapped === true,
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
        '触发词：GC含量、反向互补、序列特征、翻译、分析序列。',
      parameters: {
        sequence: { type: 'string', required: true, description: '核酸或蛋白质序列' },
        seq_type: { type: 'string', enum: ['auto', 'dna', 'rna', 'protein'], description: '序列类型，默认 auto' },
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
        'linear 表示线性还是环状（默认线性）。触发词：限制酶、酶切位点、restriction。',
      parameters: {
        sequence: { type: 'string', required: true, description: 'DNA 序列' },
        enzymes: { type: 'array', description: '酶名列表，如 ["EcoRI"]，默认全部', items: { type: 'string' } },
        enzyme_set: { type: 'string', enum: ['commonly', 'all'], description: '酶库范围，默认 commonly（商业常用）' },
        linear: { type: 'boolean', description: '是否线性分子，默认 true' },
      },
      op: 'seq_restriction',
      timeoutMs: 120_000,
    }),
    bioTool(config, {
      name: 'bio_entrez_search',
      description: 'NCBI Entrez 检索：esearch + esummary 摘要。触发词：NCBI、检索基因、搜索序列。',
      parameters: {
        term: { type: 'string', required: true, description: '检索式，如 "BRCA1[Gene] AND Homo sapiens[Organism]"' },
        db: { type: 'string', description: '数据库，默认 nucleotide（gene/protein/pubmed 等）' },
        retmax: { type: 'number', description: '最大返回数，默认 5' },
        email: { type: 'string', description: 'NCBI 要求的邮箱（建议提供）' },
      },
      op: 'entrez_search',
      timeoutMs: 120_000,
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
  ]
}

function resolveWorkdir(workdir) {
  if (!workdir) return process.cwd()
  return workdir.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(workdir) ? workdir : resolve(process.cwd(), workdir)
}

function renderBioPython(_args, value) {
  if (value.ok === false) {
    const detail = value.error || value.stderr || 'unknown error'
    return [{ type: 'text', text: `bio_python failed: ${detail}` }]
  }
  const parts = []
  if (value.stdout) parts.push(value.stdout)
  if (value.stderr) parts.push(`[stderr]\n${value.stderr}`)
  if (value.result !== undefined && value.result !== null) {
    parts.push(`[result]\n${JSON.stringify(value.result)}`)
  }
  if (value.timedOut) parts.push('[timed out]')
  return [{ type: 'text', text: parts.join('\n') || '(no output)' }]
}
