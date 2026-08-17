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
  {
    name: 'bio-figure',
    description: '出版级科研绘图顾问（吸收 scipilot-figure-skill）：8 步思考-绘制工作流、图型决策速查表、18 条画图陷阱、期刊规格、中文 CJK 支持。任何画图/数据可视化需求先加载本 skill。',
    file: 'bio-figure.md',
  },
  // ---- 协议库（高频任务的可执行工作流，含代码模板 + 常见坑）----
  {
    name: 'bio-proto-seq-qc',
    description: '序列质控工作流：批量统计长度/GC/N比例/碱基组成并标记低质量序列。',
    file: 'protocols/seq-qc.md',
  },
  {
    name: 'bio-proto-format-convert',
    description: '序列格式批量转换工作流：FASTA/GenBank/EMBL/FASTQ 互转，流式处理大文件。',
    file: 'protocols/format-convert.md',
  },
  {
    name: 'bio-proto-pairwise-align',
    description: '双序列比对工作流：PairwiseAligner 参数选择、一致度与差异位点定位。',
    file: 'protocols/pairwise-align.md',
  },
  {
    name: 'bio-proto-msa-consensus',
    description: '多序列比对解析工作流：保守性统计、consensus 生成、保守区段提取。',
    file: 'protocols/msa-consensus.md',
  },
  {
    name: 'bio-proto-blast-remote',
    description: '远程 BLAST 工作流：qblast 提交、结果解析、E-value 解读与污染排查。',
    file: 'protocols/blast-remote.md',
  },
  {
    name: 'bio-proto-entrez-batch',
    description: 'Entrez 批量获取工作流：esearch→分批 efetch、限流合规、写出序列文件。',
    file: 'protocols/entrez-batch.md',
  },
  {
    name: 'bio-proto-restriction-cloning',
    description: '限制酶克隆设计工作流：位点检查、消化片段预测、克隆可行性判断。',
    file: 'protocols/restriction-cloning.md',
  },
  {
    name: 'bio-proto-orf-annotation',
    description: 'ORF 预测工作流：六框扫描、完整/截断判定、翻译产物注释。',
    file: 'protocols/orf-annotation.md',
  },
  {
    name: 'bio-proto-motif-pwm-scan',
    description: 'Motif/PWM 扫描工作流：PWM 构建、伪计数、PSSM 阈值扫描与 MEME 解析。',
    file: 'protocols/motif-pwm-scan.md',
  },
  {
    name: 'bio-proto-phylo-nj',
    description: '系统发育树工作流：距离矩阵、NJ/UPGMA 建树、树操作与输出。',
    file: 'protocols/phylo-nj.md',
  },
  {
    name: 'bio-proto-pdb-analysis',
    description: '蛋白结构分析工作流：残基距离、活性位点邻域、结构叠加 RMSD。',
    file: 'protocols/pdb-analysis.md',
  },
  {
    name: 'bio-proto-codon-optimization',
    description: '密码子优化工作流：使用统计、按宿主频率表回译、回译验证。',
    file: 'protocols/codon-optimization.md',
  },
  {
    name: 'bio-proto-enrichment-workflow',
    description: '富集分析工作流：bio_enrichr 多库交叉、p 值解读、结论自洽性检查。',
    file: 'protocols/enrichment-workflow.md',
  },
  {
    name: 'bio-proto-literature-review',
    description: '文献调研工作流：PubMed 检索式技巧、批量摘要、OpenAlex 补充检索、引用可溯源汇总。',
    file: 'protocols/literature-review.md',
  },
  {
    name: 'bio-proto-pub-figure',
    description: '出版级出图执行协议：profile→选图→setup_style→9 类图配方→自检→导出→审计的完整闭环（figurelib 代码模板）。',
    file: 'protocols/pub-figure.md',
  },
  {
    name: 'bio-proto-coords',
    description: '基因组坐标系统协议：0/1-based 转换、BED/GFF/VCF 惯例、GRCh37/38、indel 左对齐归一化、区间运算与审计清单。',
    file: 'protocols/coords.md',
  },
  {
    name: 'bio-proto-statistics',
    description: '统计分析协议：检验选择决策树、scipy 模板、多重校正（Bonferroni/BH-FDR）、效应量与功效、实验设计要点、APA 报告规范。',
    file: 'protocols/statistics.md',
  },
]

/**
 * 指南清单（docs/agent-guide/*.md，注册为 dsh-bio-genie-guide-* 嵌入式 skill）。
 * 面向最终使用者（dsh 里的 agent）的说明书：总览/工具参考/skill 导航/
 * bio_python 编程/工作流/绘图专题/故障排查/严谨性。与领域 skill 的区别：
 * 指南教"怎么用插件整体"，领域/协议 skill 教"怎么做某类分析"。
 */
export const GUIDE_MANIFEST = [
  {
    name: 'dsh-bio-genie-guide',
    description: 'dsh-bio-genie 使用指南总览：许愿式心智模型、三层工具架构、环境引导机制、输出规范、五条铁律、阅读地图。',
    whenToUse: '用户首次使用本插件、或不确定整体怎么用本插件时。',
    file: 'README.md',
  },
  {
    name: 'dsh-bio-genie-guide-tools',
    description: '21 个工具完整参考：每个工具的参数/返回字段/典型触发词 + 愿望→工具选择速查 + 缓存限流说明。',
    whenToUse: '不确定某个 bio_* 工具的参数、返回结构或选哪个工具时。',
    file: 'tools.md',
  },
  {
    name: 'dsh-bio-genie-guide-skills',
    description: '33 个 skill 导航：主 skill + 15 领域 + 17 协议的加载时机与触发任务表。',
    whenToUse: '需要决定加载哪个领域/协议 skill 时。',
    file: 'skills.md',
  },
  {
    name: 'dsh-bio-genie-guide-python',
    description: 'bio_python 编程指南：执行契约、可用库清单（含 figurelib）、代码模板、ACR 修复表、限流纪律、高频陷阱。',
    whenToUse: '写任何非平凡 bio_python 代码前。',
    file: 'python-cookbook.md',
  },
  {
    name: 'dsh-bio-genie-guide-workflows',
    description: '10 个端到端工作流：序列质控/组合分析/BLAST/基因查询/富集/文献/建树/结构/绘图/统计，每个含工具调用序列。',
    whenToUse: '用户需求命中某个典型分析场景时。',
    file: 'workflows.md',
  },
  {
    name: 'dsh-bio-genie-guide-plotting',
    description: '出版级绘图专题：fig 三工具分工、8 步闭环、figurelib API、中文 CJK、主动拦截、五条硬性原则。',
    whenToUse: '任何画图/数据可视化/论文配图需求。',
    file: 'plotting.md',
  },
  {
    name: 'dsh-bio-genie-guide-troubleshooting',
    description: '故障排查与插件边界：环境/bio_python/网络类故障处理表 + 用户要超能力时的替代方案。',
    whenToUse: '工具报错、分析失败、或用户需求超出插件能力时。',
    file: 'troubleshooting.md',
  },
  {
    name: 'dsh-bio-genie-guide-rigor',
    description: '科学严谨性与报告规范：溯源规则、报告模板、p 值/效应量纪律、命名单位约定、诚实边界。',
    whenToUse: '写结论/报告/生物学解读前。',
    file: 'rigor.md',
  },
]

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

**第二优先：bio_python 执行器**（覆盖 Biopython 全部功能，适合语义化工具覆盖不到的场景）

- 序列比对（Bio.Align）、PDB 结构（Bio.PDB）、系统发育（Bio.Phylo）、
  motif（Bio.motifs）、BLAST（Bio.Blast）、多序列处理、自定义分析流程
- 用法：写完整 Python 程序 → code 参数 → print 输出 → result 变量返回结构化值

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

## 自动代码修复（ACR）

bio_python 失败时返回 \`needs_repair: true\`，stderr 说明了失败原因。修复代码后重新调用，不要一次失败就放弃：

- ImportError/ModuleNotFoundError → 检查模块名拼写；缺依赖先 bio_env（reinstall=true）
- HTTP 429/速率限制 → 代码里加 time.sleep()
- FileNotFoundError → 检查路径（相对路径基于工作区；不确定就用绝对路径）
- KeyError/AttributeError → 读 stderr 行号定位，检查数据结构

同一任务最多自动修复 2 次（共 3 次尝试），仍失败就停止，如实向用户报告错误，不要无限重试。

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

加载领域 skill（bio-io、bio-seq、bio-align…）获取详细配方后再写非平凡代码。

## 使用指南（说明书，按需加载）

插件内置 8 份 agent 指南（docs/agent-guide），注册为 dsh-bio-genie-guide-* 系列 skill：

| 指南 | 何时加载 |
|------|---------|
| dsh-bio-genie-guide | 总览/阅读地图/铁律 |
| dsh-bio-genie-guide-tools | 查工具参数与返回结构 |
| dsh-bio-genie-guide-skills | 选领域/协议 skill |
| dsh-bio-genie-guide-python | 写 bio_python 代码前 |
| dsh-bio-genie-guide-workflows | 命中典型场景 |
| dsh-bio-genie-guide-plotting | 画图需求 |
| dsh-bio-genie-guide-troubleshooting | 报错/超能力需求 |
| dsh-bio-genie-guide-rigor | 写结论报告前 |`
