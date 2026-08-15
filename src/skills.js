/**
 * dsh-bio-genie — skill 目录（合并版：14 个领域 skill + 1 个 genie 主 skill）
 *
 * 每个 skill body 在插件加载时从 skills/*.md 读入，经 ctx.skills.register
 * 注册为 embedded runtime skill（不依赖文件系统发现，实现"one is all"）。
 *
 * @module dsh-bio-genie/skills
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 领域 skill 清单（从 dsh-bio-workbuddy 继承）。 */
export const SKILL_MANIFEST = [
  {
    name: 'bio-core',
    description: 'Core dsh-bio-genie workflow: how to use the bio_python tool and express a bioinformatics wish as Biopython code. Load first for any analysis.',
    file: 'bio-core.md',
  },
  {
    name: 'bio-io',
    description: 'Read and write sequence files with Bio.SeqIO: FASTA, FASTQ, GenBank, EMBL, Swiss-Prot; format conversion; large-file streaming.',
    file: 'bio-io.md',
  },
  {
    name: 'bio-seq',
    description: 'Sequence manipulation: reverse complement, transcribe/translate, GC content and skew, molecular weight, melting temperature (Bio.SeqUtils).',
    file: 'bio-seq.md',
  },
  {
    name: 'bio-align',
    description: 'Pairwise and multiple alignment with Bio.Align.PairwiseAligner and Bio.AlignIO: scoring, reading/writing alignments, consensus.',
    file: 'bio-align.md',
  },
  {
    name: 'bio-blast',
    description: 'BLAST searches via Bio.Blast.NCBIWWW and result parsing with Bio.Blast.NCBIXML/Record; note network and rate limits.',
    file: 'bio-blast.md',
  },
  {
    name: 'bio-searchio',
    description: 'Parse search outputs (BLAST, HMMER, Exonerate) uniformly with Bio.SearchIO: querying hits, HSPs, and extracting alignments.',
    file: 'bio-searchio.md',
  },
  {
    name: 'bio-entrez',
    description: 'Query NCBI E-utilities with Bio.Entrez: esearch/efetch/esummary/elink for sequences, taxonomy, and literature; email requirement.',
    file: 'bio-entrez.md',
  },
  {
    name: 'bio-phylo',
    description: 'Phylogenetics with Bio.Phylo: parse/write Newick and Nexus trees, traverse, reroot, prune, and draw trees.',
    file: 'bio-phylo.md',
  },
  {
    name: 'bio-structure',
    description: 'Protein structure analysis with Bio.PDB: parse PDB/mmCIF, iterate atoms/residues/chains, compute distances, superimpose structures.',
    file: 'bio-structure.md',
  },
  {
    name: 'bio-motif',
    description: 'Sequence motifs with Bio.motifs: position-weight matrices, motif creation, scanning sequences, reading MEME/JASPAR output.',
    file: 'bio-motif.md',
  },
  {
    name: 'bio-restriction',
    description: 'Restriction enzyme analysis with Bio.Restriction: list enzymes, find cut sites, in-silico digestion and fragment sizes.',
    file: 'bio-restriction.md',
  },
  {
    name: 'bio-utils',
    description: 'Bio.SeqUtils utilities, genetic codes and codon tables (Bio.Data.CodonTable), translation tables, and codon usage statistics.',
    file: 'bio-utils.md',
  },
  {
    name: 'bio-graphics',
    description: 'Vector graphics with Bio.Graphics.GenomeDiagram: draw annotated sequences, feature maps, and linear/circular diagrams.',
    file: 'bio-graphics.md',
  },
  {
    name: 'bio-popgen',
    description: 'Population genetics with Bio.PopGen: Fst, linkage disequilibrium, haplotype analysis from population data.',
    file: 'bio-popgen.md',
  },
]

/** 注册全部 skill（领域 + genie 主 skill）。 */
export function registerSkills(ctx, skillsDir) {
  const disposers = []

  // 主 skill：工具选择 + 许愿式工作流总纲
  disposers.push(ctx.skills.register({
    name: 'dsh-bio-genie',
    description: '生物信息学「许愿式分析」主指引：工具分层选择（语义化 bio_* 工具 vs bio_python 执行器）、工作流、常见坑。任何生物分析先加载本 skill。',
    content: GENIE_SKILL_CONTENT,
  }))

  for (const skill of SKILL_MANIFEST) {
    let content = ''
    try {
      content = readFileSync(join(skillsDir, skill.file), 'utf8')
    } catch {
      content = `Skill body for "${skill.name}" is missing from the plugin package.`
    }
    disposers.push(ctx.skills.register({
      name: skill.name,
      description: skill.description,
      content,
    }))
  }
  return disposers
}

/** 主 skill 正文（工具分层选择的决策树）。 */
const GENIE_SKILL_CONTENT = `# dsh-bio-genie 许愿式生物信息学分析

用户用自然语言描述生物学分析需求时，使用本 skill 决定调用路径。

## 工具分层（决策树）

**第一优先：语义化工具**（高频稳定操作，省 token、参数有校验）

| 工具 | 用途 |
|------|------|
| bio_seq_analyze | 长度/GC%/反向互补/三框翻译/分子量 |
| bio_seq_translate | DNA→蛋白翻译（密码子表） |
| bio_seq_gc_skew | GC skew |
| bio_seq_find_orf | 最长 ORF |
| bio_seq_kmer | k-mer 频率 |
| bio_seq_io_read | 读 FASTA/GenBank |
| bio_seq_io_write | 写序列文件 |
| bio_seq_restriction | 限制酶切位点 |
| bio_entrez_search / bio_entrez_fetch | NCBI 检索/取序列 |
| bio_env | 环境诊断 |

**第二优先：bio_python 执行器**（覆盖 Biopython 全部功能，适合语义化工具覆盖不到的场景）

- 序列比对（Bio.Align）、PDB 结构（Bio.PDB）、系统发育（Bio.Phylo）、
  motif（Bio.motifs）、BLAST（Bio.Blast）、多序列处理、自定义分析流程
- 用法：写完整 Python 程序 → code 参数 → print 输出 → result 变量返回结构化值

## 调用规则

1. 高频操作先查语义化工具表，命中就用它；没有对应工具才用 bio_python。
2. 序列直接传字符串；文件操作用绝对路径。
3. 首次调用可能慢（环境自动引导，最多几分钟），不要重复调用，耐心等待。
4. 复杂分析可组合：bio_seq_io_read 读文件 → bio_python 做自定义处理 → 汇报。
5. 输出要解读生物学意义，不要只抛 JSON。

## 常见坑

- Bio.SeqIO.parse() 是生成器，多次复用先 list()。
- 现代 Biopython 的 Seq 无 alphabet，直接用 .translate()/.transcribe()。
- NCBI 调用必须设 Bio.Entrez.email，且注意速率限制。
- ImportError → 先 bio_env 看环境，必要时 reinstall。

加载领域 skill（bio-io、bio-seq、bio-align…）获取详细配方后再写非平凡代码。`
