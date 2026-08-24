---
language: none
---

# Skill 体系导航（47 个）

> skill 是插件内置的可加载知识库（配方/工作流/坑）。加载方式：用 skill 工具按名字加载。**写非平凡代码前先加载对应领域 skill；命中协议场景直接加载协议。**

## 〇、Skill 分类体系（先懂分类，再选 skill）

本插件的 skill 沿**两个正交维度**分类，加载前先看懂两个标签：

### 维度一：按功能层级（这个 skill 是干什么的）

| 层级 | 命名特征 | 分类依据 |
|---|---|---|
| 主 skill | `dsh-bio-genie`（唯一） | **路由中枢**：工具分层决策树、协议映射、调用规则。任何生物分析先加载它 |
| 领域 skill | `bio-*`（21 个） | 按 **能力域**划分——按 Biopython 模块（io/seq/align/…）与专题（机器学习/生存分析/变异分析/论文写作等）——教「某个模块/方法族怎么用」 |
| 协议 skill | `bio-proto-*`（17 个） | 按 **高频任务**划分（质控/建树/富集/绘图/差异表达/GSEA…）——教「某类任务怎么完整做完」，含可执行代码模板 + 常见坑 |
| 指南 skill | `dsh-bio-genie-guide-*`（8 个） | 插件**整体说明书**——教「这个插件怎么用」，按主题划分 |

合计：主 1 + 领域 21 + 协议 17 + 指南 8 = **47 个**。

### 维度二：按语言解释器（这个 skill 的代码跑在哪个环境）

每个 skill 开头 frontmatter 都有 `language:` 字段。**分类依据 = 可执行内容运行在哪个解释器环境**：

| 值 | 含义 | 判定依据 |
|---|---|---|
| `python` | 仅用插件内置 Python 环境（bio_python / bio_* 工具 / figurelib） | 代码模板全是 Python，只调 Python 生态 |
| `mixed` | 同一工作流混用多种路径（语义化工具 + bio_python 代码） | 正文会明确标注哪一步用哪个工具/路径 |
| `none` | 纯知识/导航/参考，不执行任何代码 | 无代码模板、无工具调用序列 |

**当前状态**：R 引擎已移除（2026-08）——全部领域/协议 skill 均为 `python` 或 `none`；差异表达与 GSEA 由 Python 语义化工具 `bio_deseq2` / `bio_gsea` 承担。

### 加载判定顺序（分类的实际用法）

```
1. 先加载主 skill dsh-bio-genie → 由决策树定路径
2. 命中协议任务（"建树""富集""差异表达""GSEA"）→ 直接加载对应 bio-proto-* 协议
3. 语义化工具覆盖不了且无协议命中 → 加载对应领域 skill 拿配方，写 bio_python 代码
4. 不确定插件整体用法 / 工具参数 / 出错原因 → 加载对应指南
```

## 一、主 skill：`dsh-bio-genie`

任何生物分析**先加载**。内容：工具分层决策树（语义化工具表 → 协议映射表 → 调用规则 → ACR → 会话记忆 → 科学严谨性）。它告诉你去哪、用哪个工具、加载哪个 skill。

## 二、21 个领域 skill（全 Python 配方）

| Skill | 覆盖 | 何时加载 |
|---|---|---|
| `bio-core` | 核心工作流：bio_python 用法、许愿→代码 | 任何 Python 分析的起点 |
| `bio-io` | Bio.SeqIO 读写/格式转换/大文件流式 | 涉及序列文件 IO |
| `bio-seq` | Bio.Seq/SeqUtils：GC、Tm、分子量、反向互补 | 序列操作 |
| `bio-align` | PairwiseAligner/AlignIO：双序列/多序列比对 | 比对任务 |
| `bio-blast` | Bio.Blast：NCBIWWW/NCBIXML | 远程 BLAST |
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
| `bio-ml` | scikit-learn 生物机器学习：特征工程/分类/降维 | ML 建模任务 |
| `bio-dna-design` | DNA 序列设计：引物/探针/元件设计约束 | 序列设计任务 |
| `bio-survival-analysis` | lifelines 生存分析：KM/log-rank/Cox | 生存分析任务 |
| `bio-variant-analysis` | 变异分析：VCF 解析/注释/过滤 | 变异任务 |
| `bio-literature-review` | 文献调研方法学：检索式/筛选/综述结构 | 文献综述任务 |
| `bio-paper-writing` | 论文写作：IMRaD 结构/图表规范/投稿 | 写作任务 |

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
2. **命中协议任务**（"批量转换格式""建树""富集分析""差异表达""GSEA"）→ 直接加载对应 `bio-proto-*`，按模板执行；差异表达/GSEA 优先用语义化工具 `bio_deseq2` / `bio_gsea`。
3. **语义化工具覆盖不了、且无协议命中** → 加载对应领域 skill（bio-align/bio-phylo…）拿配方，写 bio_python 代码。
4. **画图** → 期刊统计图永远先 `bio-figure`（决策）+ `bio-proto-pub-figure`（执行）。
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
