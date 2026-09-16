/**
 * dsh-bio-genie — skill 目录（41 个领域/研究/协议 skill + 1 个 genie 主 skill + 8 份指南，共 50 个注册条目）
 *
 * 每个 skill body 在插件加载时从 skills/*.md 读入，经 ctx.skills.register
 * 注册为 embedded runtime skill（不依赖文件系统发现，实现"one is all"）。
 *
 * 每项的 `category` 字段给设置面板「Skill 模块」按功能层级分组：
 *   - main:     主 skill（dsh-bio-genie，注册见 src/index.js 的 GENIE_SKILL_CONTENT）
 *   - domain:   Biopython 领域（17 个）
 *   - research: 科研方法（5 个，含证据分级与结论强度）
 *   - protocol: 协议库——高频任务的可执行工作流（19 个）
 *   - guide:    docs/agent-guide 说明书（走 GUIDE_MANIFEST，8 份）
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
    description: 'Core workflow: turn a bioinformatics wish into Biopython code via the bio_python tool. Load first for any analysis.',
    file: 'bio-core.md',
  },
  {
    name: 'bio-io',
    category: 'domain',
    description: 'Read/write sequence files with Bio.SeqIO: FASTA, FASTQ, GenBank, EMBL, Swiss-Prot; conversion; streaming.',
    file: 'bio-io.md',
  },
  {
    name: 'bio-seq',
    category: 'domain',
    description: 'Sequence manipulation: reverse complement, translate, GC content/skew, molecular weight, Tm (Bio.SeqUtils).',
    file: 'bio-seq.md',
  },
  {
    name: 'bio-align',
    category: 'domain',
    description: 'Pairwise/multiple alignment with Bio.Align.PairwiseAligner and Bio.AlignIO: scoring, IO, consensus.',
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
    description: 'Parse search outputs (BLAST, HMMER, Exonerate) with Bio.SearchIO: hits, HSPs, alignments.',
    file: 'bio-searchio.md',
  },
  {
    name: 'bio-entrez',
    category: 'domain',
    description: 'Query NCBI E-utilities with Bio.Entrez: esearch/efetch/esummary/elink for sequences, taxonomy, literature.',
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
    description: 'Protein structure with Bio.PDB: parse PDB/mmCIF, iterate atoms/residues/chains, distances, superimpose.',
    file: 'bio-structure.md',
  },
  {
    name: 'bio-motif',
    category: 'domain',
    description: 'Sequence motifs with Bio.motifs: PWMs, motif creation, scanning sequences, reading MEME/JASPAR output.',
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
    description: 'Bio.SeqUtils utilities, genetic codes/codon tables (Bio.Data.CodonTable), translation tables, codon usage.',
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
  {
    name: 'bio-ml',
    category: 'domain',
    description: '生物数据机器学习：分类/回归/降维/聚类/特征分析/统计检验（scikit-learn + scipy）。',
    file: 'bio-ml.md',
  },
  {
    name: 'bio-dna-design',
    category: 'domain',
    description: 'DNA/质粒设计：引物设计、密码子优化、组装策略（Gibson/Golden Gate）、质粒图谱生成。',
    file: 'bio-dna-design.md',

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
    description: '出版级出图执行协议：profile→选图→setup_style→10 类图配方（含显著性标注、不等宽多面板）→自检→导出→审计闭环。',
    file: 'protocols/pub-figure.md',
  },
  {
    name: 'bio-proto-differential-figure',
    category: 'protocol',
    description: '差异分析出版配方：differential_plot volcano/MA 双模、三层视觉角色（NS 灰/显著彩/标注黑）、标注预算、caption_fragments、陷阱表。',
    file: 'protocols/differential-figure.md',
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
    description: '统计分析协议：检验选择决策树、scipy/statsmodels 模板、多重校正、效应量对照、样本量与功效规划、实验设计、统计陷阱表。',
    file: 'protocols/statistics.md',
  },
  {
    name: 'bio-proto-ngs-pipeline',
    category: 'protocol',
    description: 'NGS 重型流程协议（nf-core/Nextflow）：环境门、测试档先行、样本表校验、决策点、产物验证。',
    file: 'protocols/ngs-pipeline.md',
  },
  // ---- 科研专精（preset skills，含统计严谨性 + 完整代码模板）----
  {
    name: 'bio-survival-analysis',
    category: 'research',
    description: '生存分析工作流：Kaplan-Meier/log-rank、Cox 回归（单/多因素）、PH 假设检验、竞争风险、时间依赖 ROC（lifelines）。',
    whenToUse: '做生存分析、KM 曲线、Cox 回归、预后模型、表达-生存关联时。',
    file: 'bio-survival-analysis.md',
  },
  {
    name: 'bio-variant-analysis',
    category: 'research',
    description: '变异分析完整工作流：VCF 读取/过滤、ClinVar 致病性注释、gnomAD 群体频率、ACMG 分类标准。Python vcfpy 实现。',
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
    description: '文献检索与综述：PubMed 检索式、PRISMA 2020 系统综述流程、偏倚评估工具选择、信息提取、综述写作与引用格式。',
    whenToUse: '文献检索、文献综述、系统综述/Meta 分析、研究背景调研、参考文献收集时。',
    file: 'bio-literature-review.md',
  },
  {
    name: 'bio-evidence-appraisal',
    category: 'research',
    description: '证据分级与结论强度：判断结论能说多强、能不能这么写（证据层级、GRADE 降级域、四轴评估、验证深度、引用角色与措辞边界）。',
    whenToUse: '判断一批文献谁更强、某个结论能说多强、写讨论/结论前定措辞、系统综述做偏倚评级时。',
    file: 'bio-evidence-appraisal.md',
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
    description: '53 个工具完整参考：每个工具的参数/返回字段/典型触发词 + 愿望→工具选择速查 + 缓存限流说明。',
    whenToUse: '不确定某个 bio_* 工具的参数、返回结构或选哪个工具时。',
    file: 'tools.md',
  },
  {
    name: 'dsh-bio-genie-guide-skills',
    category: 'guide',
    description: '全部 skill 导航：主 skill + 17 领域 + 17 协议 + 4 研究方法 + 8 指南的加载时机与触发任务表。',
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
    whenToUse: '用户提出生物学/序列分析/FASTA/GC含量/限制酶/翻译/ORF/k-mer/基因信息查询/通路富集/文献检索/参考基因组/NCBI 检索/BLAST/多序列比对/系统发育树等需求时。',
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
| bio_seq_analyze | 长度/GC%/反向互补/三框翻译/分子量（codon_stats=true 时含密码子统计） |
| bio_seq_translate | DNA→蛋白翻译（密码子表） |
| bio_seq_gc_skew | GC skew |
| bio_seq_find_orf | 最长 ORF |
| bio_seq_kmer | k-mer 频率 |
| bio_seq_io_read | 读 FASTA/GenBank |
| bio_seq_io_write | 写序列文件 |
| bio_seq_restriction | 限制酶切位点（1-based 切割位置；detail=false 时未指定酶只给计数，指定酶 ≤10 坐标；true 全量） |
| bio_blast_search | 远程 BLAST（NCBI qblast，1-10 分钟，勿重复调用） |
| bio_msa | 多序列比对（clustalw/muscle，缺二进制会返回提示） |
| bio_phylo_build | 系统发育树（nj/upgma → Newick，可接 bio_msa 输出） |
| bio_entrez_search / bio_entrez_fetch | NCBI 检索/取序列（db=gene 有基因元数据摘要） |
| bio_enrichr | 通路/GO 富集分析（基因符号列表 → p 值排序条目） |
| bio_pubmed_search / bio_pubmed_abstract | PubMed 文献检索 / 结构化摘要 |
| bio_plasmid_search / bio_plasmid_info | Addgene 质粒库检索（找现成质粒）/ 按 ID 取完整元数据（抗性/拷贝数/启动子/插入片段） |
| bio_uniprot | UniProt 蛋白知识库（mode=entry/ptm/xref/pathway/sequence/search） |
| bio_seq_introns | 内含子-外显子结构与剪接位点（GenBank 多段 CDS → 外显子/内含子坐标 + GT-AG 判定） |
| bio_seq_dotplot | 序列点阵图（滑窗一致性 → 相似区段/重复/重排 + 300 DPI PNG） |
| bio_phylo_compare | 系统发育树比较（Robinson-Foulds 距离 + 拓扑差异明细） |
| bio_rna_fold | RNA 二级结构预测（ViennaRNA MFE + ΔG + 碱基对，可出结构图） |
| bio_sc_qc | 单细胞 RNA-seq 质控（scanpy：指标 → MAD 过滤 → 出图 → 保存 h5ad） |
| bio_ref_genome | 参考基因组 assembly 信息（Ensembl） |
| bio_fig_profile | 数据剖析 + 图型建议（画统计图前先跑） |
| bio_fig_export | 图文件合规审计（DPI/格式/尺寸/字体嵌入）+ 可选 PNG 预览 |
| bio_fig_qa | 绘图环境自检（CJK 中文字体 / 期刊预设） |
| bio_fig_lint | FIG 级出版语义 lint（红绿对/rainbow/色相数/灰度坍缩/统计元数据，画完图立刻自检） |
| bio_primer3_design | 工业级引物设计（Primer3 热力学评分，候选引物对排序） |
| bio_dna_optimize | 多约束 DNA 优化（DNA Chisel：去酶切位点/GC 窗口/密码子联合优化） |
| bio_clone_simulate | 克隆模拟（pydna：Gibson 环化组装模拟，首次调用自动装 pydna） |
| bio_crispr_guide / bio_crispr_verify | sgRNA 设计（PAM 扫描+off-target+效率分）/ 编辑验证（两序列比对+indel 定量） |
| bio_dna_syncheck | DNA 合成约束检查（GC/同聚物/发夹/重复 → 可合成性评分 0-100） |
| bio_wetlab_design | 湿实验方案设计（PCR/Gibson/Golden Gate/限制酶/CRISPR/菌株构建/转化） |
| bio_plasmid_map | 质粒图谱（传 genbank_file/sequence 出 PNG/SVG 图形并返回 output_file；否则文本注释图 mode=text） |
| bio_sbol_write / bio_sbol_read | SBOL 3 标准化设计写出/读取（tyto 本体解析） |
| bio_production_envelope | 生产包络线（产物理论上限预测） |
| bio_circuit_compile / bio_circuit_simulate | 基因回路编译（→SBML+网络图）/ ODE/SSA 动力学仿真（首次调用自动装 biocrnpyler/bioscrape） |
| bio_log | 执行日志回溯（最近/检索） |
| bio_memory | 会话记忆查询（成功模式/修复经验） |
| bio_env | 环境诊断 |
| bio_goal | Autopilot 目标管理（create/status/pause/resume/complete/block，框架级持久目标 + 轮次预算） |

**Autopilot 与计算防火墙（v3 新增行为约定）**

- 复杂需求按 bio-autopilot 协议推进：先《分析计划》→ 自动执行无风险步骤 →
  关键决策点用 ask_user_question 暂停（给推荐选项）→ 完成输出《结果报告》（含溯源表）
- 长任务（>10 步）用 bio_goal 创建框架级目标
- 计算防火墙：回复中的数值必须来自工具输出的 _provenance 台账；框架 rigor-guard
  会在回合收尾扫描，无溯源数字会被 steer 打回要求验证后再发

**产物目录规范（工作区标准布局，所有分析/任务必须遵守）**

每个会话工作区预先创建四个规范目录，写文件时按类型落位，禁止散落在工作区根目录：

- result/ = 最终交付物（综合报告 Markdown、标准文件如 SBOL/FASTA、验证结论）
- figures/ = 出版级图形（300 DPI PNG/PDF 等可视化产物，bio_fig_export 审计对象）
- out/ = 中间数据（临时 FASTA、CSV、中间脚本输出，可随时清理）
- 工作区根目录 = 仅放编译类工具默认输出（如 SBML 模型文件、网络拓扑图）等“漏网之鱼”，
  凡有可归类文件必须移入上述目录，并在报告中给出相对路径（如 result/xxx.md、figures/xxx.png）

**文件相对路径一律基于会话工作区（session.header.cwd）解析**，不要用服务器启动目录或绝对主目录。



**第二优先：执行器**（语义化工具覆盖不到的场景）

- Python 侧 bio_python：双序列比对（Bio.Align.PairwiseAligner）、PDB 结构（Bio.PDB）、
  motif（Bio.motifs）、多序列处理、自定义分析流程、出版级绘图（figurelib）
- 用法：写完整程序 → code 参数 → print 输出 → result 变量返回结构化值

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
| 统计检验/多重校正/功效/样本量规划 | bio-proto-statistics |
| 系统综述（PRISMA）与文献偏倚评估 | bio-literature-review |
| 证据强弱判断/结论措辞/引用角色 | bio-evidence-appraisal |


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
11. 画统计图/论文图：先 bio_fig_profile 剖析数据再选图型（见 bio-figure skill）；中文图先 bio_fig_qa 查字体；绘制配方见 bio-proto-pub-figure（figurelib 可 import）；**画完立刻 bio_fig_lint 自检视觉选择**（红绿对/rainbow/色相数/灰度/统计元数据）；投稿前 bio_fig_export 审计。
12. 统计结论必须跑检验（bio-proto-statistics）：组间比较给 p 值+效应量，多重比较必须校正；误差棒图注写清 SD/SEM/CI + n。
13. BLAST 用 bio_blast_search（勿在 bio_python 里自己调 qblast）；MSA→建树流水线：bio_msa 的 alignment_fasta 输出直接传给 bio_phylo_build 的 alignment 参数；bio_msa 返回 status=program_missing 时提示用户安装 clustalw/muscle，或改走 bio_python 兜底。
14. 合成生物学路由：高质量引物用 bio_primer3_design（简单预估才用 bio_primer_design）；多约束序列改造（去酶切位点+密码子优化）用 bio_dna_optimize（简单密码子替换才用 bio_seq_optimize）；克隆可行性/组装模拟用 bio_clone_simulate（首次调用会自动安装 pydna，提示用户等待）；质粒出图传给 bio_plasmid_map（genbank_file 或 sequence+features，确认返回 mode=graphic 且 output_file 为实际路径——仅传 features 只有文本注释图）。
15. 代谢工程路由：bio_fba 的 analysis_type=fva 做通量可变性分析、pfba 做节俭 FBA、loopless 消除热力学不可行循环、geometric 唯一最小通量解、optionsfva 完整通量范围；bio_gene_knockout 的 analysis_type=double 找合成致死对、essentiality 做全基因必需性扫描、optknock 自动找最大化目标产物分泌的敲除组合（默认乙酸 EX_ac_e）；产物产量上限预测用 bio_production_envelope（target=产物交换反应，vary=生物量反应）。
16. SBOL 标准化：导出设计用 bio_sbol_write（role 写术语名如 promoter，自动解析为 SO URI）；读取外部 SBOL 文件用 bio_sbol_read（可提取序列对接下游分析）。
17. 基因回路：组件列表（promoter 可带 regulators）→ bio_circuit_compile 得 SBML + 网络拓扑图 → bio_circuit_simulate 做 ODE/SSA 仿真出浓度曲线。首次调用自动安装 biocrnpyler/bioscrape（~20MB，提示用户等待）；simulation_type=ssa 用于噪声/随机性分析。
18. CRISPR：设计 sgRNA 用 bio_crispr_guide（指定 Cas 类型，默认 SpCas9 NGG，按 efficiency_score 降序 + off-target 升序排序，top_n 默认 10）；编辑验证用 bio_crispr_verify（需提供 wild_type 与 edited 序列，返回 indel/substitution 统计与编辑效率）。
19. DNA 合成前置检查：合成前用 bio_dna_syncheck 评估可合成性（GC/同聚物/发夹/重复），critical 问题需先解决再送合成公司；合成后用 bio_dna_syncheck 复查合成产物序列。
21. 文献与证据路由：系统综述/PRISMA 流程用 bio-literature-review；判断「这批文献谁更强、结论能说多强」用 bio-evidence-appraisal（证据层级 + GRADE + 四轴 + 措辞边界）；所有引用必须经 bio_pubmed_search 核验，**禁止凭记忆写 PMID/DOI**。
20. 湿实验方案：干实验结论转湿实验 protocol 用 bio_wetlab_design（protocol_type 指定方案类型，input_data 传上游工具输出）。典型链路：bio_primer3_design → bio_wetlab_design(pcr_amplification)；bio_clone_simulate → bio_wetlab_design(gibson_assembly)；bio_crispr_guide → bio_wetlab_design(crispr_editing)；bio_gene_knockout(optknock) → bio_wetlab_design(strain_construction)。
22. 质粒库检索路由：用户要"找现成质粒/有没有人做过"（描述功能而非给 ID）→ bio_plasmid_search 检索 Addgene，命中后用 bio_plasmid_info 取完整字段（抗性/拷贝数/启动子/生长菌株/插入片段），再按需接 bio_plasmid_map / bio_clone_simulate / bio_dna_syncheck 做下游设计。**边界：本工具只给检索与公开元数据，不给序列**——序列需用户在 Addgene 登录后自行下载；不要声称已取得序列、不要编造序列。引用质粒必须给出 Addgene ID 与名称。检索为实时抓取，结构化失败会响亮报错（空结果只代表 Addgene 确实无匹配）。
23. 蛋白注释路由：查蛋白功能/PTM/交叉引用/通路/序列用 bio_uniprot（mode 参数切换），**不要用 bio_entrez_fetch 绕道去取蛋白注释**——UniProt 的注释粒度远高于 GenBank。PTM 位点为序列坐标且带证据码；通路取自交叉引用，可再交叉核对 KEGG（bio_pathway_search）。
24. 基因结构路由：内含子-外显子与剪接位点用 bio_seq_introns（需**基因组类**登录号 NG_/NC_；gene 参数是**精确匹配**——product 描述常提及邻近基因名，子串匹配会串基因；未匹配时工具返回 available_genes 供纠正；坐标按转录方向排序，负链递减）；建树一致性用 bio_phylo_compare（RF 距离 0 = 拓扑一致；比较前两棵树叶名须归一）；序列相似区段/重复/重排的可视化核验用 bio_seq_dotplot。
25. RNA 结构与单细胞路由：RNA 二级结构/稳定性用 bio_rna_fold（MFE ΔG 越负越稳；mean_base_pair_distance 越小结构越确定）；单细胞数据质控用 bio_sc_qc（species 选错会导致 MT% 恒为 0——human 用 MT- 前缀、mouse 用 mt-）。二者首次调用自动装依赖（ViennaRNA / scanpy），提示用户等待。


## 自动代码修复（ACR）— 三层职责边界

**核心原则**：开发时主动消除错误根源（修复插件 bug、补 requirements），运行时只在「确定可解的失败」上自愈，其余交给 agent。**自愈与修复不是二选一，是分层协作**。

bio_python 失败时返回 \`needs_repair: true\` + 完整 stderr。下面分三层规定各自职责，agent 只接手「agent 该干的部分」：

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
- 组间比较优先 bio_stats_test（CSV 场景，自动选检验并给效应量）；它覆盖不到的场景（配对/事后检验/功效）用 bio-proto-statistics 的 scipy+statsmodels 配方——两者都是内置依赖，可直接 import。

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
| dsh-bio-genie-guide-troubleshooting | 报错/超能力需求 |
| dsh-bio-genie-guide-rigor | 写结论报告前 |
`