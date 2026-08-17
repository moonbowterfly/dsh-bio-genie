---
language: none
---

# Skill 体系导航（33 个）

> skill 是插件内置的可加载知识库（配方/工作流/坑）。加载方式：用 skill 工具按名字加载。**写非平凡代码前先加载对应领域 skill；命中协议场景直接加载协议。**

## 一、主 skill：`dsh-bio-genie`

任何生物分析**先加载**。内容：工具分层决策树（语义化工具表 → 协议映射表 → 调用规则 → ACR → 会话记忆 → 科学严谨性）。它告诉你去哪、用哪个工具、加载哪个 skill。

## 二、15 个领域 skill（Biopython 模块配方）

| Skill | 覆盖 | 何时加载 |
|---|---|---|
| `bio-core` | 核心工作流：bio_python 用法、许愿→代码 | 任何分析的起点 |
| `bio-io` | Bio.SeqIO 读写/格式转换/大文件流式 | 涉及序列文件 IO |
| `bio-seq` | Bio.Seq/SegUtils：GC、Tm、分子量、反向互补 | 序列操作 |
| `bio-align` | PairwiseAligner/AlignIO：双序列/多序列比对 | 比对任务 |
| `bio-blast` | Bio.Blast：NCBIWWW/NcBIXML | 远程 BLAST |
| `bio-searchio` | Bio.SearchIO：BLAST/HMMER/Exonerate 输出解析 | 解析检索输出 |
| `bio-entrez` | Bio.Entrez：esearch/efetch/esummary/elink | bio_python 里调 NCBI |
| `bio-phylo` | Bio.Phylo：Newick/Nexus、树操作、画树 | 系统发育 |
| `bio-structure` | Bio.PDB：结构解析、距离、叠合 | 蛋白结构 |
| `bio-motif` | Bio.motifs：PWM、MEME/JASPAR | motif 分析 |
| `bio-restriction` | Bio.Restriction：酶切/消化 | 克隆设计 |
| `bio-utils` | 密码子表、遗传密码、密码子用法 | 翻译相关 |
| `bio-graphics` | GenomeDiagram：序列图谱（线性/环形） | 画质粒/基因组图谱 |
| `bio-popgen` | Bio.PopGen：Fst、LD、单倍型 | 群体遗传 |
| `bio-figure` | **出版级绘图顾问**：8 步工作流、选图决策、18 陷阱、期刊规格、CJK | 任何画图需求（见 guide-plotting） |

## 三、17 个协议 skill（高频任务工作流，含代码模板+坑）

| 协议 | 触发任务 |
|---|---|
| `bio-proto-seq-qc` | 批量序列质控（长度/GC/N 比例统计） |
| `bio-proto-format-convert` | 格式批量转换（FASTA/GenBank/FASTQ 互转） |
| `bio-proto-pairwise-align` | 双序列比对/突变定位 |
| `bio-proto-msa-consensus` | 多序列比对解析/consensus/保守性 |
| `bio-proto-blast-remote` | 远程 BLAST 注释（qblast/E-value/污染排查） |
| `bio-proto-entrez-batch` | 批量取 NCBI 序列（esearch→分批 efetch→限流合规） |
| `bio-proto-restriction-cloning` | 克隆设计/酶切片段预测/可行性 |
| `bio-proto-orf-annotation` | ORF 预测：六框扫描/完整性/翻译注释 |
| `bio-proto-motif-pwm-scan` | PWM 构建/伪计数/PSSM 扫描/MEME 解析 |
| `bio-proto-phylo-nj` | 建树：距离矩阵/NJ/UPGMA/树操作 |
| `bio-proto-pdb-analysis` | 结构：残基距离/活性位点/RMSD |
| `bio-proto-codon-optimization` | 密码子优化：宿主频率表回译/验证 |
| `bio-proto-enrichment-workflow` | 富集解读：多库交叉/背景集/冗余消除/OLS4 消歧 |
| `bio-proto-literature-review` | 文献调研：PubMed 检索式/批量摘要/OpenAlex 补充 |
| `bio-proto-pub-figure` | **出版级出图执行**：9 类图配方/figurelib 调用/自检闭环 |
| `bio-proto-coords` | 基因组坐标：0/1-based 转换/BED-GFF-VCF 惯例/GRCh37-38/左对齐 |
| `bio-proto-statistics` | 统计：检验选择/scipy 模板/多重校正/效应量与功效 |

## 四、加载策略

1. **先加载 `dsh-bio-genie`** → 决策树告诉你路径。
2. **命中协议任务**（"批量转换格式""建树""富集分析"）→ 直接加载对应 `bio-proto-*`，按模板执行。
3. **语义化工具覆盖不了、且无协议命中** → 加载对应领域 skill（bio-align/bio-phylo…）拿配方，写 bio_python 代码。
4. **画图** → 永远先 `bio-figure`（决策）+ `bio-proto-pub-figure`（执行）。
5. **统计/坐标/富集解读** → 分别用 statistics/coords/enrichment-workflow 协议。

## 五、指南 skill（本系列）

| 指南 | 用途 |
|---|---|
| `dsh-bio-genie-guide` | 总览（本文件族的 README） |
| `dsh-bio-genie-guide-tools` | 工具全参考 |
| `dsh-bio-genie-guide-skills` | 本文件 |
| `dsh-bio-genie-guide-python` | bio_python 编程指南 |
| `dsh-bio-genie-guide-workflows` | 端到端工作流 |
| `dsh-bio-genie-guide-plotting` | 绘图专题 |
| `dsh-bio-genie-guide-troubleshooting` | 故障排查与边界 |
| `dsh-bio-genie-guide-rigor` | 严谨性与报告规范 |

> 语言标注：每个 skill 开头 frontmatter 的 `language:` 字段标明其可执行内容运行在哪个解释器（`python` / `r` / `mixed` / `none`=纯知识导航）。加载 skill 前先看该字段，确认与任务匹配。
