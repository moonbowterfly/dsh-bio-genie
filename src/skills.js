/**
 * dsh-bio-genie — skill 目录（合并版：40 个领域 skill + 1 个 genie 主 skill + 9 份指南）
 *
 * 每个 skill body 在插件加载时从 skills/*.md 读入，经 ctx.skills.register
 * 注册为 embedded runtime skill（不依赖文件系统发现，实现"one is all"）。
 *
 * 每项的 `category` 字段给设置面板「Skill 模块」按功能层级分组：
 *   - main:     主 skill（dsh-bio-genie，注册见 src/index.js 的 GENIE_SKILL_CONTENT）
 *   - domain:   Biopython 领域（15 个）
 *   - r:        R/Bioconductor 领域（8 个）
 *   - protocol: 协议库——高频任务的可执行工作流（18 个，含 2 个 R 协议）
 *   - guide:    docs/agent-guide 说明书（走 GUIDE_MANIFEST）
 *
 * @module dsh-bio-genie/skills
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 领域 skill 清单（从 dsh-bio-workbuddy 继承）。每项带 category 字段。 */
export const SKILL_MANIFEST = [
  // ---- Biopython 领域 ----
  {
    name: 'bio-core',
    category: 'domain',
    description: 'Core dsh-bio-genie workflow: how to use the bio_python tool and express a bioinformatics wish as Biopython code. Load first for any analysis.',
    file: 'bio-core.md',
  },
  {
    name: 'bio-io',
    category: 'domain',
    description: 'Read and write sequence files with Bio.SeqIO: FASTA, FASTQ, GenBank, EMBL, Swiss-Prot; format conversion; large-file streaming.',
    file: 'bio-io.md',
  },
  {
    name: 'bio-seq',
    category: 'domain',
    description: 'Sequence manipulation: reverse complement, transcribe/translate, GC content and skew, molecular weight, melting temperature (Bio.SeqUtils).',
    file: 'bio-seq.md',
  },
  {
    name: 'bio-align',
    category: 'domain',
    description: 'Pairwise and multiple alignment with Bio.Align.PairwiseAligner and Bio.AlignIO: scoring, reading/writing alignments, consensus.',
    file: 'bio-align.md',
  },
  {
    name: 'bio-blast',
    category: 'domain',
    description: 'BLAST searches via Bio.Blast.NCBIWWW and result parsing with Bio.Blast.NCBIXML/Record; note network and rate limits.',
    file: 'bio-blast.md',
  },
  {
    name: 'bio-searchio',
    category: 'domain',
    description: 'Parse search outputs (BLAST, HMMER, Exonerate) uniformly with Bio.SearchIO: querying hits, HSPs, and extracting alignments.',
    file: 'bio-searchio.md',
  },
  {
    name: 'bio-entrez',
    category: 'domain',
    description: 'Query NCBI E-utilities with Bio.Entrez: esearch/efetch/esummary/elink for sequences, taxonomy, and literature; email requirement.',
    file: 'bio-entrez.md',
  },
  {
    name: 'bio-phylo',
    category: 'domain',
    description: 'Phylogenetics with Bio.Phylo: parse/write Newick and Nexus trees, traverse, reroot, prune, and draw trees.',
    file: 'bio-phylo.md',
  },
  {
    name: 'bio-structure',
    category: 'domain',
    description: 'Protein structure analysis with Bio.PDB: parse PDB/mmCIF, iterate atoms/residues/chains, compute distances, superimpose structures.',
    file: 'bio-structure.md',
  },
  {
    name: 'bio-motif',
    category: 'domain',
    description: 'Sequence motifs with Bio.motifs: position-weight matrices, motif creation, scanning sequences, reading MEME/JASPAR output.',
    file: 'bio-motif.md',
  },
  {
    name: 'bio-restriction',
    category: 'domain',
    description: 'Restriction enzyme analysis with Bio.Restriction: list enzymes, find cut sites, in-silico digestion and fragment sizes.',
    file: 'bio-restriction.md',
  },
  {
    name: 'bio-utils',
    category: 'domain',
    description: 'Bio.SeqUtils utilities, genetic codes and codon tables (Bio.Data.CodonTable), translation tables, and codon usage statistics.',
    file: 'bio-utils.md',
  },
  {
    name: 'bio-graphics',
    category: 'domain',
    description: 'Vector graphics with Bio.Graphics.GenomeDiagram: draw annotated sequences, feature maps, and linear/circular diagrams.',
    file: 'bio-graphics.md',
  },
  {
    name: 'bio-popgen',
    category: 'domain',
    description: 'Population genetics with Bio.PopGen: Fst, linkage disequilibrium, haplotype analysis from population data.',
    file: 'bio-popgen.md',
  },
  {
    name: 'bio-figure',
    category: 'domain',
    description: '出版级科研绘图顾问（吸收 scipilot-figure-skill）：8 步思考-绘制工作流、图型决策速查表、18 条画图陷阱、期刊规格、中文 CJK 支持。任何画图/数据可视化需求先加载本 skill。',
    file: 'bio-figure.md',
  },
  // ---- R/Bioconductor 领域（language: r，2026-08-17 起双引擎）----
  {
    name: 'bio-r-core',
    category: 'r',
    description: 'R 执行器核心（bio_r）：执行契约、环境事实（R 4.6.1/Bioc 3.23 核心包清单）、与 bio_python 双引擎分工路由、ACR 信号表、高频陷阱。任何 R 分析先加载。',
    file: 'bio-r-core.md',
  },
  {
    name: 'bio-r-basics',
    category: 'r',
    description: 'R 核心数据结构：Biostrings（序列对象）/ GenomicRanges（区间）/ SummarizedExperiment（组学容器）——对象模型优先，先懂类再记函数。',
    file: 'bio-r-basics.md',
  },
  {
    name: 'bio-r-rnaseq',
    category: 'r',
    description: '差异表达分析：DESeq2 标准管道（对象模型：DESeqDataSet→DESeq→results→lfcShrink）/ edgeR 无重复路径 / 解读纪律（padj<0.05 且 |log2FC|>1 双阈值）。',
    file: 'bio-r-rnaseq.md',
  },
  {
    name: 'bio-r-enrichment',
    category: 'r',
    description: 'R 富集与 GSEA：fgsea 排序富集管道 + enricher 通用 ORA；与 bio_enrichr 的 ORA 分工；org.Hs.eg.db 不在核心包的边界。',
    file: 'bio-r-enrichment.md',
  },
  {
    name: 'bio-r-microbiome',
    category: 'r',
    description: '微生物组分析（phyloseq）：OTU 表组装（taxa_are_rows）、alpha/beta 多样性、PCoA、PERMANOVA 与解读纪律。',
    file: 'bio-r-microbiome.md',
  },
  {
    name: 'bio-r-vis',
    category: 'r',
    description: 'R 生态可视化：ggplot2 火山图/ggtree 树图/ComplexHeatmap 复杂热图；与 Python figurelib 的出版级分工（中文图走 Python）。',
    file: 'bio-r-vis.md',
  },
  {
    name: 'bio-r-genesets',
    category: 'r',
    description: 'MSigDB 基因集分析（msigdbr + fgsea）：按物种/分类即时查询基因集，免手动下载 GMT；fgsea 排序 GSEA + enricher ORA 管道。',
    file: 'bio-r-genesets.md',
  },
  {
    name: 'bio-r-dimred',
    category: 'r',
    description: '降维与聚类（Rtsne + cluster）：t-SNE 降维可视化 + 层次聚类分群；PCA 前处理 + perplexity 选择策略。',
    file: 'bio-r-dimred.md',
  },
  // ---- 协议库（高频任务的可执行工作流，含代码模板 + 常见坑）----
  {
    name: 'bio-proto-seq-qc',
    category: 'protocol',
    description: '序列质控工作流：批量统计长度/GC/N比例/碱基组成并标记低质量序列。',
    file: 'protocols/seq-qc.md',
  },
  {
    name: 'bio-proto-format-convert',
    category: 'protocol',
    description: '序列格式批量转换工作流：FASTA/GenBank/EMBL/FASTQ 互转，流式处理大文件。',
    file: 'protocols/format-convert.md',
  },
  {
    name: 'bio-proto-pairwise-align',
    category: 'protocol',
    description: '双序列比对工作流：PairwiseAligner 参数选择、一致度与差异位点定位。',
    file: 'protocols/pairwise-align.md',
  },
  {
    name: 'bio-proto-msa-consensus',
    category: 'protocol',
    description: '多序列比对解析工作流：保守性统计、consensus 生成、保守区段提取。',
    file: 'protocols/msa-consensus.md',
  },
  {
    name: 'bio-proto-blast-remote',
    category: 'protocol',
    description: '远程 BLAST 工作流：qblast 提交、结果解析、E-value 解读与污染排查。',
    file: 'protocols/blast-remote.md',
  },
  {
    name: 'bio-proto-entrez-batch',
    category: 'protocol',
    description: 'Entrez 批量获取工作流：esearch→分批 efetch、限流合规、写出序列文件。',
    file: 'protocols/entrez-batch.md',
  },
  {
    name: 'bio-proto-restriction-cloning',
    category: 'protocol',
    description: '限制酶克隆设计工作流：位点检查、消化片段预测、克隆可行性判断。',
    file: 'protocols/restriction-cloning.md',
  },
  {
    name: 'bio-proto-orf-annotation',
    category: 'protocol',
    description: 'ORF 预测工作流：六框扫描、完整/截断判定、翻译产物注释。',
    file: 'protocols/orf-annotation.md',
  },
  {
    name: 'bio-proto-motif-pwm-scan',
    category: 'protocol',
    description: 'Motif/PWM 扫描工作流：PWM 构建、伪计数、PSSM 阈值扫描与 MEME 解析。',
    file: 'protocols/motif-pwm-scan.md',
  },
  {
    name: 'bio-proto-phylo-nj',
    category: 'protocol',
    description: '系统发育树工作流：距离矩阵、NJ/UPGMA 建树、树操作与输出。',
    file: 'protocols/phylo-nj.md',
  },
  {
    name: 'bio-proto-pdb-analysis',
    category: 'protocol',
    description: '蛋白结构分析工作流：残基距离、活性位点邻域、结构叠加 RMSD。',
    file: 'protocols/pdb-analysis.md',
  },
  {
    name: 'bio-proto-codon-optimization',
    category: 'protocol',
    description: '密码子优化工作流：使用统计、按宿主频率表回译、回译验证。',
    file: 'protocols/codon-optimization.md',
  },
  {
    name: 'bio-proto-enrichment-workflow',
    category: 'protocol',
    description: '富集分析工作流：bio_enrichr 多库交叉、p 值解读、结论自洽性检查。',
    file: 'protocols/enrichment-workflow.md',
  },
  {
    name: 'bio-proto-literature-review',
    category: 'protocol',
    description: '文献调研工作流：PubMed 检索式技巧、批量摘要、OpenAlex 补充检索、引用可溯源汇总。',
    file: 'protocols/literature-review.md',
  },
  {
    name: 'bio-proto-pub-figure',
    category: 'protocol',
    description: '出版级出图执行协议：profile→选图→setup_style→9 类图配方→自检→导出→审计的完整闭环（figurelib 代码模板）。',
    file: 'protocols/pub-figure.md',
  },
  {
    name: 'bio-proto-coords',
    category: 'protocol',
    description: '基因组坐标系统协议：0/1-based 转换、BED/GFF/VCF 惯例、GRCh37/38、indel 左对齐归一化、区间运算与审计清单。',
    file: 'protocols/coords.md',
  },
  {
    name: 'bio-proto-statistics',
    category: 'protocol',
    description: '统计分析协议：检验选择决策树、scipy 模板、多重校正（Bonferroni/BH-FDR）、效应量与功效、实验设计要点、APA 报告规范。',
    file: 'protocols/statistics.md',
  },
  {
    name: 'bio-proto-r-de',
    category: 'protocol',
    description: 'R 差异表达工作流：counts+meta 输入约定 → DESeq2 全流程模板 → 火山图/富集下游衔接（language: r）。',
    file: 'protocols/r-de.md',
  },
  {
    name: 'bio-proto-r-gsea',
    category: 'protocol',
    description: 'R GSEA 工作流：排序列表+GMT 输入约定 → fgsea 全流程模板 → padj<0.25 解读（language: r）。',
    file: 'protocols/r-gsea.md',
  },
  // ---- 科研专精（preset skills，含统计严谨性 + 完整代码模板）----
  {
    name: 'bio-survival-analysis',
    category: 'research',
    description: '生存分析完整工作流：Kaplan-Meier 与 log-rank、Cox 比例风险回归（单/多因素）、PH 假设检验、竞争风险、时间依赖 ROC。Python lifelines 与 R survival/survminer 双实现。含统计严谨性清单和常见错误。',
    whenToUse: '做生存分析、KM 曲线、Cox 回归、预后模型、表达-生存关联时。',
    file: 'bio-survival-analysis.md',
  },
  {
    name: 'bio-variant-analysis',
    category: 'research',
    description: '变异分析完整工作流：VCF 读取/过滤、ClinVar 致病性注释、gnomAD 群体频率、ACMG 分类标准。Python vcfpy 与 R vcfR 双实现。',
    whenToUse: '处理 VCF 变异数据、变异注释、变异致病性解读、群体频率分析时。',
    file: 'bio-variant-analysis.md',
  },
  {
    name: 'bio-paper-writing',
    category: 'research',
    description: '科研论文写作：IMRaD 结构模板、摘要写作、统计报告规范、学术英语要点、参考文献格式化（Vancouver/APA/Nature）。',
    whenToUse: '撰写论文、摘要、综述、实验报告时。',
    file: 'bio-paper-writing.md',
  },
  {
    name: 'bio-literature-review',
    category: 'research',
    description: '文献检索与综述：PubMed 检索式构建、文献筛选流程（PRISMA）、文献信息提取、综述写作结构、引用格式速查。',
    whenToUse: '文献检索、文献综述、研究背景调研、参考文献收集时。',
    file: 'bio-literature-review.md',
  },
]

/**
 * 主 skill 元数据（设置面板显示用；主 skill 注册见 src/index.js）。
 */
export const GENIE_SKILL = {
  name: 'dsh-bio-genie',
  category: 'main',
  description: '生物信息学「许愿式分析」主指引：工具分层选择（语义化 bio_* 工具 vs bio_python 执行器）、工作流、常见坑。任何生物分析先加载本 skill。',
}

/**
 * 指南清单（docs/agent-guide/*.md，注册为 dsh-bio-genie-guide-* 嵌入式 skill）。
 *
 * 面向最终使用者（dsh 里的 agent）的说明书：总览/工具参考/skill 导航/
 * bio_python 编程/工作流/绘图专题/故障排查/严谨性。与领域 skill 的区别：
 * 指南教"怎么用插件整体"，领域/协议 skill 教"怎么做某类分析"。
 */
export const GUIDE_MANIFEST = [
  {
    name: 'dsh-bio-genie-guide',
    category: 'guide',
    description: 'dsh-bio-genie 使用指南总览：许愿式心智模型、三层工具架构、环境引导机制、输出规范、五条铁律、阅读地图。',
    whenToUse: '用户首次使用本插件、或不确定整体怎么用本插件时。',
    file: 'README.md',
  },
  {
    name: 'dsh-bio-genie-guide-tools',
    category: 'guide',
    description: '23 个工具完整参考：每个工具的参数/返回字段/典型触发词 + 愿望→工具选择速查 + 缓存限流说明。',
    whenToUse: '不确定某个 bio_* 工具的参数、返回结构或选哪个工具时。',
    file: 'tools.md',
  },
  {
    name: 'dsh-bio-genie-guide-skills',
    category: 'guide',
    description: '51 个 skill 导航：主 skill + 15 领域 + 8 指南 + 19 协议的加载时机与触发任务表。',
    whenToUse: '需要决定加载哪个领域/协议 skill 时。',
    file: 'skills.md',
  },
  {
    name: 'dsh-bio-genie-guide-python',
    category: 'guide',
    description: 'bio_python 编程指南：执行契约、可用库清单（含 figurelib）、代码模板、ACR 修复表、限流纪律、高频陷阱。',
    whenToUse: '写任何非平凡 bio_python 代码前。',
    file: 'python-cookbook.md',
  },
  {
    name: 'dsh-bio-genie-guide-r',
    category: 'guide',
    description: 'bio_r 编程指南：执行契约、R 4.6/Bioc 3.23 核心包清单与边界、代码模板、ACR 信号表、与 Python 引擎协作、高频陷阱。',
    whenToUse: '写任何非平凡 bio_r 代码前。',
    file: 'r-cookbook.md',
  },
  {
    name: 'dsh-bio-genie-guide-workflows',
    category: 'guide',
    description: '10 个端到端工作流：序列质控/组合分析/BLAST/基因查询/富集/文献/建树/结构/绘图/统计，每个含工具调用序列。',
    whenToUse: '用户需求命中某个典型分析场景时。',
    file: 'workflows.md',
  },
  {
    name: 'dsh-bio-genie-guide-plotting',
    category: 'guide',
    description: '出版级绘图专题：fig 三工具分工、8 步闭环、figurelib API、中文 CJK、主动拦截、五条硬性原则。',
    whenToUse: '任何画图/数据可视化/论文配图需求。',
    file: 'plotting.md',
  },
  {
    name: 'dsh-bio-genie-guide-troubleshooting',
    category: 'guide',
    description: '故障排查与插件边界：环境/bio_python/网络类故障处理表 + 用户要超能力时的替代方案。',
    whenToUse: '工具报错、分析失败、或用户需求超出插件能力时。',
    file: 'troubleshooting.md',
  },
  {
    name: 'dsh-bio-genie-guide-rigor',
    category: 'guide',
    description: '科学严谨性与报告规范：溯源规则、报告模板、p 值/效应量纪律、命名单位约定、诚实边界。',
    whenToUse: '写结论/报告/生物学解读前。',
    file: 'rigor.md',
  },
]

/**
 * 序列化所有可在设置面板展示的 skill 元数据（含主 skill + SKILL_MANIFEST + GUIDE_MANIFEST）。
 * 给宿主侧 /api/dsh-bio-genie/skills 路由用，不返回 body（避免传输 200KB markdown）。
 */
export function listSkillsForPanel() {
  return {
    main: GENIE_SKILL,
    skills: SKILL_MANIFEST.map(({ name, category, description }) => ({ name, category, description })),
    guides: GUIDE_MANIFEST.map(({ name, category, description, whenToUse }) => ({ name, category, description, whenToUse })),
  }
}

/** 注册全部 skill（领域 + genie 主 skill + 指南）。 */
export function registerSkills(ctx, skillsDir, guideDir) {
  const disposers = []

  // 主 skill：工具选择 + 许愿式工作流总纲
  disposers.push(ctx.skills.register({
    name: 'dsh-bio-genie',
    description: '生物信息学「许愿式分析」主指引：工具分层选择（语义化 bio_* 工具 vs bio_python 执行器）、工作流、常见坑。任何生物分析先加载本 skill。',
    whenToUse: '用户提出生物学/序列分析/FASTA/GC含量/限制酶/翻译/ORF/k-mer/基因信息查询/通路富集/文献检索/参考基因组/NCBI 检索等需求时。',
    source: 'custom',
    provider: 'dsh-bio-genie',
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
      source: 'custom',
      provider: 'dsh-bio-genie',
      content,
    }))
  }

  // 指南（docs/agent-guide，agent 说明书）
  for (const guide of GUIDE_MANIFEST) {
    let content = ''
    try {
      content = readFileSync(join(guideDir, guide.file), 'utf8')
    } catch {
      content = `Guide body for "${guide.name}" is missing from the plugin package.`
    }
    disposers.push(ctx.skills.register({
      name: guide.name,
      description: guide.description,
      whenToUse: guide.whenToUse,
      source: 'custom',
      provider: 'dsh-bio-genie',
      content,
    }))
  }
  return disposers
}

/** 主 skill 正文（工具分层选择的决策树）。 */
const GENIE_SKILL_CONTENT = `---
language: mixed
---

# dsh-bio-genie 许愿式生物信息学分析

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
| bio_entrez_search / bio_entrez_fetch | NCBI 检索/取序列（db=gene 有基因元数据摘要） |
| bio_enrichr | 通路/GO 富集分析（基因符号列表 → p 值排序条目） |
| bio_pubmed_search / bio_pubmed_abstract | PubMed 文献检索 / 结构化摘要 |
| bio_ref_genome | 参考基因组 assembly 信息（Ensembl） |
| bio_fig_profile | 数据剖析 + 图型建议（画统计图前先跑） |
| bio_fig_export | 图文件合规审计（DPI/格式/尺寸/字体嵌入）+ 可选 PNG 预览 |
| bio_fig_qa | 绘图环境自检（CJK 中文字体 / 期刊预设） |
| bio_log | 执行日志回溯（最近/检索） |
| bio_memory | 会话记忆查询（成功模式/修复经验） |
| bio_env | 环境诊断 |
| bio_r | R 执行器（DESeq2/edgeR/limma 差异表达、fgsea 排序富集、phyloseq 微生物组、ggplot2/ggtree/ComplexHeatmap） |
| bio_r_env | R 环境诊断（R 版本/Bioconductor 版本/核心包版本） |

**第二优先：执行器**（语义化工具覆盖不到的场景）

- Python 侧 bio_python：序列比对（Bio.Align）、PDB 结构（Bio.PDB）、系统发育（Bio.Phylo）、
  motif（Bio.motifs）、BLAST（Bio.Blast）、多序列处理、自定义分析流程、出版级绘图（figurelib）
- R 侧 bio_r：差异表达（DESeq2/edgeR/limma）、排序 GSEA（fgsea）、微生物组（phyloseq）、
  基因组区间（GenomicRanges）、树图/复杂热图（ggtree/ComplexHeatmap）
- 用法：写完整程序 → code 参数 → print 输出 → result 变量返回结构化值

**双引擎路由（选哪个引擎）**

| 任务 | 引擎 |
|------|------|
| 差异表达 / GSEA 排序富集 / 微生物组多样性 / GenomicRanges 区间 | R（bio_r，先加载 bio-r-core） |
| MSigDB 基因集查询 / 免 GMT 的 fgsea | R（bio_r + bio-r-genesets） |
| t-SNE 降维 / 层次聚类分群 | R（bio_r + bio-r-dimred） |
| 序列 IO/比对/BLAST/Entrez/结构/建树/出版级统计图/列表型富集 | Python（bio_python / bio_* 工具） |
| 跨引擎协作 | Python 预处理 → R 分析 → Python 出图，用工作区文件衔接 |

**常见任务 → 协议映射**（命中先加载协议 skill，含可执行代码模板）

| 任务 | 协议 skill |
|------|-----------|
| 批量序列质控/统计 | bio-proto-seq-qc |
| 格式转换（FASTA/GenBank 互转） | bio-proto-format-convert |
| 双序列比对/突变定位 | bio-proto-pairwise-align |
| 多序列比对解析/consensus | bio-proto-msa-consensus |
| 远程 BLAST 注释 | bio-proto-blast-remote |
| 批量取 NCBI 序列 | bio-proto-entrez-batch |
| 克隆设计/酶切片段预测 | bio-proto-restriction-cloning |
| ORF 预测 | bio-proto-orf-annotation |
| motif/PWM 扫描 | bio-proto-motif-pwm-scan |
| 建系统发育树 | bio-proto-phylo-nj |
| 蛋白结构距离/RMSD | bio-proto-pdb-analysis |
| 密码子优化 | bio-proto-codon-optimization |
| 富集分析解读 | bio-proto-enrichment-workflow |
| 文献调研 | bio-proto-literature-review |
| 论文配图/统计图（选图+出版级出图） | bio-figure + bio-proto-pub-figure |
| 基因组坐标转换/off-by-one 排查 | bio-proto-coords |
| 统计检验/多重校正/功效 | bio-proto-statistics |
| 差异表达（counts 矩阵） | bio-proto-r-de（R） |
| 排序富集 GSEA | bio-proto-r-gsea（R） |
| 微生物组多样性 | bio-r-microbiome（R） |
| MSigDB 基因集 / 免 GMT 的 fgsea | bio-r-genesets（R） |
| t-SNE 降维 / 聚类分群 | bio-r-dimred（R） |

## 调用规则

1. 高频操作先查语义化工具表，命中就用它；没有对应工具才用 bio_python。
2. 序列直接传字符串；文件操作用绝对路径。
3. 首次调用可能慢（环境自动引导，最多几分钟），不要重复调用，耐心等待。
4. 复杂分析可组合：bio_seq_io_read 读文件 → bio_python 做自定义处理 → 汇报。
5. 输出要解读生物学意义，不要只抛 JSON。
6. 查基因信息用 bio_entrez_search：db="gene"，检索式如 \"TP53[Gene Name] AND human[Organism]\"。
7. 富集分析用 bio_enrichr：传基因符号列表（5-500 个），library 不指定时用 GO_Biological_Process_2023；需要通路层面用 KEGG_2021_Human 或 Reactome_2022。
8. 文献检索用 bio_pubmed_search（返回 PMID/标题/期刊），要看全文摘要用 bio_pubmed_abstract 传 PMID 列表。
9. 参考基因组/基因组版本信息用 bio_ref_genome，species 可传 human/mouse 等常用名。
10. 语义化工具的 NCBI/Enrichr/Ensembl 限流已由插件内置，无需自己在参数里处理；但 bio_python 代码里直接调 Bio.Entrez 时仍需自己遵守速率限制。
11. 画统计图/论文图：先 bio_fig_profile 剖析数据再选图型（见 bio-figure skill）；中文图先 bio_fig_qa 查字体；绘制配方见 bio-proto-pub-figure（figurelib 可 import）；投稿前 bio_fig_export 审计。
12. 统计结论必须跑检验（bio-proto-statistics）：组间比较给 p 值+效应量，多重比较必须校正；误差棒图注写清 SD/SEM/CI + n。
13. R 任务用 bio_r：差异表达/GSEA/微生物组等先加载 bio-r-core 与对应 r 领域 skill；R 环境首次引导约 5-20 分钟（惰性触发），提前告知用户等待、不要重复调用；R 生态问题查 bio_r_env。

## 自动代码修复（ACR）— 三层职责边界

**核心原则**：开发时主动消除错误根源（修复插件 bug、补 requirements），运行时只在「确定可解的失败」上自愈，其余交给 agent。**自愈与修复不是二选一，是分层协作**。

bio_python / bio_r 失败时返回 \`needs_repair: true\` + 完整 stderr。下面分三层规定各自职责，agent 只接手「agent 该干的部分」：

| 层 | 谁修 | 触发条件 | 动作 | 上限 |
|---|------|----------|------|------|
| **L1 插件自愈** | 插件代码 | 当前**不实现任何自动重试**——所有失败统一透传到 stderr，让 agent 看见 | — | 0 次（占位；后续若加白名单错误类型的自动重试，必须以 \`stderr\` 追加 \`[bio-genie self-healed: ...]\` 让用户看见） |
| **L2 记忆复用** | 插件（已存在） + agent 决策 | \`bio_python\` 失败后，stderr 错误签名若在 \`~/.dsh/dsh-bio-genie/memory/error_lessons.json\` 命中 | agent 主动 \`bio_memory action=lessons\` 查 fix_hint；命中即套用再调 | agent 试错 ≤ 1 次（用提示词的方式让 agent 先查记忆再改码）|
| **L3 agent 自愈** | agent（你） | 任何 L1/L2 未覆盖的失败（代码逻辑错、API 误用、路径错、限流、数据结构错） | 读 stderr → 改 code → 再调 | agent 最多自动修复 2 次（同一任务共 3 次尝试）|
| **终止** | — | 累计 3 次仍失败 | **停止自愈，如实向用户报告**：错误原文 + 已尝试的修复路径 + 残余不确定性。绝不编造结果 | — |

**L1 的边界（必须严格遵守，不要扩大）**：插件自愈只对「确定的事」负责——环境缺包、venv 损坏、镜像切换这类可机械执行的恢复。**不要让插件自动改 code**（code 是模型写的，插件不应擅改；改坏了 agent 反而看不到原始失败信号）。

**L3 的纪律**：

- ImportError/ModuleNotFoundError → 先 \`bio_env\` 看环境状态；若提示环境就绪却仍缺包，是插件 bug 而非任务 bug，**停止自愈、报告插件 bug**
- HTTP 429/速率限制 → 在 code 里加 \`time.sleep(0.4)\`（NCBI 限流 3 req/s 对应间隔）；批量任务走 \`bio-proto-entrez-batch\` 协议的分批与 sleep
- FileNotFoundError → 检查路径（相对路径基于工作区；不确定就用绝对路径）
- KeyError/AttributeError → 读 stderr 行号定位，检查数据结构
- UnicodeDecodeError → 中文 Windows 文件用 \`open(path, encoding='utf-8', errors='replace')\`
- TimeoutError / \`timedOut=true\` → 传更大 \`timeoutMs\`；大数据改成写文件而非 print
- 模糊密码子 \`TranslationError\` → 翻译前 \`seq.replace('X','N').replace('-','N').replace('.','N')\`

**绝对禁止**：

- 不要无限重试同一个失败（违反「3 次上限」即放弃）
- 不要让 \`needs_repair=true\` 触发后用同一份 code 再调一次（不读 stderr 不改码 = 浪费时间）
- 不要把 ImportError 当作「环境没引导好」自行 pip install 任何东西（违反「零安装」原则；除非插件代码本身定义了白名单自动补装）

**沉淀纪律**：失败→修复成功的配对由插件（\`pendingFixes\` Map）自动写入 \`error_lessons.json\`，下次同类错误直接套用 fix_hint（无需重新发明）。**插件层自愈动作也必须写日志**（未来若加），格式 \`[bio-genie self-healed: <动作>]\` 追加在 stderr 末尾。

## 会话记忆（越用越聪明）

插件会把成功的 bio_python 代码模式与错误修复经验记到本地（$DSH_HOME/dsh-bio-genie/memory/）：

- 写非平凡代码前，可先 bio_memory action=patterns 查同类任务是否已有成功模板
- bio_python 失败时，查 bio_memory action=lessons：若错误签名命中，直接套用 fix_hint
- 失败→修复成功的配对会自动沉淀为经验，下次同类错误直接给出修法

## 科学严谨性

所有生物学结论必须可溯源到工具输出，不可仅凭模型推断（详见 persona）：
- ✅ 有工具输出支撑的结论直接引用数据
- ❌ 纯推断的结论（如「这是抑癌基因」「这段序列来自人类」）必须标注 [推断-未验证] 并说明需要什么工具验证

## 常见坑

- Bio.SeqIO.parse() 是生成器，多次复用先 list()。
- 现代 Biopython 的 Seq 无 alphabet，直接用 .translate()/.transcribe()。
- bio_python 代码里调 NCBI 必须设 Bio.Entrez.email，且注意 3 req/s 速率限制。
- bio_enrichr 的结果按 adjusted_p_value 升序解读；combined_score 越高证据越强。
- ImportError → 先 bio_env 看环境，必要时 reinstall。
- R 首次引导慢（5-20 分钟）；R 包加载也慢（DESeq2 ~10s），bio_r 默认超时 120s 不够就传大 timeoutMs。
- R 报 "there is no package called 'X'" → X 不在核心包集（org.Hs.eg.db 等），换等效实现或如实告知边界。

加载领域 skill（bio-io、bio-seq、bio-align…）获取详细配方后再写非平凡代码。

## 使用指南（说明书，按需加载）

插件内置 8 份 agent 指南（docs/agent-guide），注册为 dsh-bio-genie-guide-* 系列 skill：

| 指南 | 何时加载 |
|------|---------|
| dsh-bio-genie-guide | 总览/阅读地图/铁律 |
| dsh-bio-genie-guide-tools | 查工具参数与返回结构 |
| dsh-bio-genie-guide-skills | skill 导航与分类体系（功能层级 × 语言解释器） |
| dsh-bio-genie-guide-python | 写 bio_python 代码前 |
| dsh-bio-genie-guide-workflows | 命中典型场景 |
| dsh-bio-genie-guide-plotting | 画图需求 |
|| dsh-bio-genie-guide-troubleshooting | 报错/超能力需求 |

// ---- 工具调试面板：可调试工具的参数 schema（供 server.js 和 client.js 共用）----
export const TOOL_SCHEMAS = [
  { name: 'seq_analyze', label: '序列分析', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCGATCGATCG...', desc: '核酸或蛋白质序列' },
    { key: 'seq_type', type: 'select', options: ['auto','dna','rna','protein'], default: 'auto', desc: '序列类型' },
  ]},
  { name: 'seq_translate', label: '序列翻译', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCGATCG...', desc: 'DNA/RNA 序列' },
    { key: 'table', type: 'number', default: 1, desc: '遗传密码表编号' },
    { key: 'to_stop', type: 'boolean', default: false, desc: '遇到终止密码子停止' },
  ]},
  { name: 'seq_gc_skew', label: 'GC Skew', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCG...', desc: 'DNA 序列' },
    { key: 'window', type: 'number', default: 100, desc: '窗口大小' },
  ]},
  { name: 'seq_find_orf', label: 'ORF 查找', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCG...', desc: 'DNA 序列' },
    { key: 'min_len', type: 'number', default: 30, desc: '最小 ORF 长度' },
  ]},
  { name: 'seq_kmer', label: 'K-mer 统计', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGATCG...', desc: '核酸序列' },
    { key: 'k', type: 'number', default: 3, desc: 'k 值' },
    { key: 'top', type: 'number', default: 10, desc: '返回前 N 个' },
  ]},
  { name: 'seq_restriction', label: '限制酶切', engine: 'python', params: [
    { key: 'sequence', type: 'text', required: true, placeholder: 'ATGCGAATTCGATCG...', desc: 'DNA 序列' },
    { key: 'enzymes', type: 'text', placeholder: 'EcoRI,BamHI', desc: '酶名列表（逗号分隔）' },
    { key: 'linear', type: 'boolean', default: true, desc: '线性分子' },
  ]},
  { name: 'entrez_search', label: 'NCBI 检索', engine: 'python', params: [
    { key: 'term', type: 'text', required: true, placeholder: 'TP53[Gene Name] AND human[Organism]', desc: '检索式' },
    { key: 'db', type: 'select', options: ['nucleotide','gene','protein'], default: 'nucleotide', desc: '数据库' },
    { key: 'retmax', type: 'number', default: 5, desc: '最大返回数' },
  ]},
  { name: 'enrichr', label: 'Enrichr 富集', engine: 'python', params: [
    { key: 'genes', type: 'text', required: true, placeholder: 'TP53,BRCA1,EGFR', desc: '基因列表（逗号分隔）' },
    { key: 'library', type: 'text', default: 'GO_Biological_Process_2023', desc: '富集库' },
    { key: 'top', type: 'number', default: 10, desc: '返回前 N 条' },
  ]},
  { name: 'pubmed_search', label: 'PubMed 检索', engine: 'python', params: [
    { key: 'term', type: 'text', required: true, placeholder: 'CRISPR gene editing', desc: '检索式' },
    { key: 'retmax', type: 'number', default: 10, desc: '最大返回数' },
  ]},
  { name: 'metabolic_model', label: '代谢模型', engine: 'python', params: [
    { key: 'action', type: 'select', options: ['list','load','info'], default: 'list', desc: '操作类型' },
    { key: 'model_id', type: 'text', default: 'textbook', desc: '模型 ID' },
  ]},
  { name: 'fba', label: 'FBA 分析', engine: 'python', params: [
    { key: 'model_id', type: 'text', default: 'textbook', desc: '模型 ID' },
    { key: 'objective', type: 'text', placeholder: 'Biomass_Ecoli_core', desc: '目标函数（可选）' },
  ]},
  { name: 'gene_knockout', label: '基因敲除', engine: 'python', params: [
    { key: 'model_id', type: 'text', default: 'textbook', desc: '模型 ID' },
    { key: 'gene', type: 'text', required: true, placeholder: 'b2779', desc: '基因 ID' },
  ]},
  { name: 'pathway_search', label: '通路搜索', engine: 'python', params: [
    { key: 'target_metabolite', type: 'text', required: true, placeholder: 'glycolysis', desc: '目标代谢物/关键词' },
    { key: 'organism', type: 'text', default: 'eco', desc: '生物代码' },
    { key: 'limit', type: 'number', default: 10, desc: '返回数量' },
  ]},
  { name: 'pathway_design', label: '通路设计', engine: 'python', params: [
    { key: 'target_product', type: 'text', required: true, placeholder: 'ethanol', desc: '目标产物' },
    { key: 'host_organism', type: 'text', default: 'eco', desc: '宿主生物' },
    { key: 'strategy', type: 'select', options: ['shortest','max_yield','fewest_steps'], default: 'shortest', desc: '设计策略' },
  ]},
]
| dsh-bio-genie-guide-rigor | 写结论报告前 |`