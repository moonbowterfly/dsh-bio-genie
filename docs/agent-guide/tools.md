---
language: none
---

# 工具全参考（31 个）

> 每个工具：功能 → 参数（★=必填）→ 返回关键字段 → 典型触发词。**选工具第一优先，双引擎执行器（bio_python/bio_r）第二优先**——先按任务选引擎（见 dsh-bio-genie 主 skill 的双引擎路由表），再选工具。

## 一、执行器

### bio_python — 任意 Python 代码执行器

写完整程序到 `code` 参数，在插件隔离环境（biopython + numpy/pandas/scipy/matplotlib/seaborn/Pillow + figurelib）中执行。工作目录 = 会话工作区。

| 参数 | 说明 |
|---|---|
| code ★ | 完整 Python 源码 |
| workdir | 工作目录（绝对路径；默认会话工作区，无工作区时 `~/deepseek-harness/bio-genie-workspace`） |
| timeoutMs | 超时（默认 60000ms） |

返回：`ok / stdout / stderr / error / result / exitCode / timedOut / truncated / needs_repair`。
- `result`：你给顶层变量 `result` 赋的 JSON 可序列化值（小结果用它，省得解析 stdout）。
- `needs_repair: true`：stderr 有 traceback，修复代码后重试（最多 2 次修复）。
- 大输出（>1MB 会被截断）→ 写文件再报告路径，不要 print 大量数据。

编程规范 → 加载 `dsh-bio-genie-guide-python`。

### bio_r — R 执行器（差异表达/富集/微生物组）

写完整 R 程序到 `code` 参数，在插件隔离的 **R 4.6.0 + Bioconductor 3.23** 环境中执行。工作目录 = 会话工作区。

| 参数 | 说明 |
|---|---|
| code ★ | 完整 R 源码 |
| workdir | 工作目录（绝对路径；默认会话工作区） |
| timeoutMs | 超时（默认 120000ms——R 包加载慢，长任务请加大） |

返回：`ok / stdout / stderr / error / result / exitCode / timedOut / truncated / needs_repair`。
- `result`：顶层 `result <- <JSON 可序列化值>`（推荐命名 list；data.frame 亦可）。
- `needs_repair: true`：stderr 含 `Error`/`Execution halted`，修复重试（最多 3 次尝试）。
- 可用核心包：DESeq2/edgeR/limma、fgsea、phyloseq、Biostrings/GenomicRanges/SummarizedExperiment、ggplot2/ggtree/ComplexHeatmap、dplyr/tibble/readr（完整清单与版本见 `bio_r_env`；clusterProfiler 与 org.Hs.eg.db **不在**核心集——Windows 下 Bioc 3.23 无 GO.db 二进制）。
- **首次调用惰性引导**（下载 R + 核心包约 5-20 分钟）：提前告知用户等待，不要重复调用。

编程规范 → 加载 `dsh-bio-genie-guide-r`。

### bio_env — 环境诊断/重建（Python 侧）

| 参数 | 说明 |
|---|---|
| reinstall | true 时强制重建环境（引导失败或包损坏时用） |

返回：`ready / python / pythonVersion / biopython / numpy / envDir / bootstrapped`。

### bio_r_env — R 环境诊断/核心包重建

| 参数 | 说明 |
|---|---|
| reinstall | true 时重新安装核心包集（R 本体不重装） |

返回：`ready / rscript / rVersion / bioc / packages（核心包版本表）/ libDir / bootstrapped`。R 包加载失败时先查这里；`packages` 里没有的包 = 不在核心集（换等效实现或如实告知边界）。

### bio_log — 执行日志回溯

| 参数 | 说明 |
|---|---|
| action | `recent`（最近，默认）/ `search`（按 query 检索） |
| query | 检索词（如错误信息、op 名） |
| limit | 条数（默认 20） |

返回 `{count, entries[]}`——用于回溯"刚才跑过什么、哪步失败了"。

### bio_memory — 会话记忆查询

| 参数 | 说明 |
|---|---|
| action | `patterns`（成功代码模式，默认）/ `lessons`（错误→修复经验）/ `search` |
| query | 检索词 |
| limit | 条数（默认 10） |

写非平凡代码前查 patterns 有无现成模板；bio_python 失败时查 lessons 命中错误签名直接套 fix_hint。经验会自动沉淀（失败→修复成功的配对）。

## 二、语义化工具

### 序列分析

**bio_seq_analyze** — 一站式序列分析
| 参数 | 说明 |
|---|---|
| sequence ★ | DNA/RNA/蛋白序列字符串 |
| seq_type | `auto`（默认，自动判断）/ dna / rna / protein |

返回：`length / seq_type / gc_fraction / gc_percent / reverse_complement / complement / translations`（DNA 六框 +1~+3、-1~-3；RNA 三框）`/ molecular_weight`（蛋白）/ `aa_composition`（蛋白）。
自动判断规则：含 U 无 T→RNA；含 IUPAC 模糊碱基（RYSWKMBDHVN）、X、gap（-/.）→DNA；出现非核酸字母→蛋白。含 X/gap 的序列安全（翻译前 X/gap→N，不崩溃）。

**bio_seq_translate** — 翻译：`sequence ★`、`table`（密码子表号，默认 1）、`to_stop`（首终止密码子截断）。返回 `{protein, table, to_stop}`。

**bio_seq_gc_skew** — GC skew：`sequence ★`、`window`（默认 100）。返回 `{window, gc_skew[]}`。

**bio_seq_find_orf** — 最长 ORF：`sequence ★`、`min_len`（默认 30nt）、`table`。返回 `{orf: {start, end, length, frame, protein}}`，无 ORF 为 `orf: null`。坐标 0-based 半开。

**bio_seq_kmer** — k-mer 频率：`sequence ★`、`k`（默认 3）、`top`（默认 10）。返回 `{k, total_kmers, unique_kmers, top{}}`。

**bio_seq_io_read** — 读序列文件：`path ★`、`format`（fasta/genbank，默认按扩展名）、`limit`（默认 50）。返回 `{format, count, records[{id, name, description, length, seq_preview}]}`。UTF-8/GBK 自适应。

**bio_seq_io_write** — 写序列文件：`path ★`、`records ★`（`[{id, sequence, description?}]`）、`format`（默认 fasta）。返回 `{path, format, written}`。

**bio_seq_restriction** — 限制酶位点：`sequence ★`、`enzymes`（酶名列表，不传=全部商业常用酶 ~700 种）、`enzyme_set`（commonly/all）、`linear`（默认 true）。返回 `{sites: {酶名: {cut_positions, recognition_site, count}}, requested?, missing_enzymes?}`。cut_positions 是 **1-based 切点坐标**（切点后第一个碱基）。

### 数据检索（网络）

**bio_entrez_search** — NCBI 检索：`term ★`（如 `"TP53[Gene Name] AND human[Organism]"`）、`db`（nucleotide/protein/gene，默认 nucleotide）、`retmax`（默认 5）、`email`（建议传）。
返回 `{db, count, ids[], summaries[]}`。db=gene 时 summary 含 `name/chromosome/map_location/chr_start/chr_stop/aliases/summary`；db=nucleotide/protein 含 `title/length/accession`。

**bio_entrez_fetch** — 按 ID 取序列：`ids ★`、`db`、`rettype`（默认 fasta）、`email`。返回 `{db, rettype, data}`（文本，上限 50k 字符）。

**bio_enrichr** — 通路富集：`genes ★`（符号列表 5-500 个）、`library`（默认 `GO_Biological_Process_2023`；另可选 `GO_Molecular_Function_2023`、`GO_Cellular_Component_2023`、`KEGG_2021_Human`、`Reactome_2022`、`MSigDB_Hallmark_2020`、`WikiPathway_2023_Human`）、`top`（默认 10）。
返回 `{library, gene_count, total_terms, top, results[{rank, term, p_value, odds_ratio, combined_score, overlap_genes[], overlap_count, adjusted_p_value}]}`。**解读按 adjusted_p_value 升序**；GO 与 KEGG 的 p 值不可互相比较（背景集不同）。

**bio_pubmed_search** — 文献检索：`term ★`（支持 PubMed 语法）、`retmax`（默认 10）、`email`。返回 `{db, count, pmids[], results[{pmid, title, journal, date, authors[], doi, has_abstract}]}`。

**bio_pubmed_abstract** — 结构化摘要：`ids ★`（PMID 列表）、`email`。返回 `{db, count, results[{pmid, title, abstract, authors[], journal, date, doi}]}`。一次 ≤30 个 PMID。

**bio_ref_genome** — 参考基因组信息：`species ★`（human/mouse/rat/zebrafish/fly/yeast/arabidopsis/ecoli 等常用名或 Ensembl 目录名）。返回 `{species, assembly_name, assembly_accession, assembly_date, karyotype, chromosomes[{name, length}], scaffold_count, download_urls}`。

### 出版级绘图

**bio_fig_profile** — 数据剖析+图型建议（画图前必跑）：`path ★`（CSV/TSV/Excel）、`group_cols`（分组列名数组）。返回 `{source, n_rows, n_cols, columns{列名:{type, n, mean, median, sd, min, max, skewness, n_outliers_iqr, missing_rate, ...}}, correlation, group_summary, warnings[], suggestions[]}`。suggestions 是图型建议+风险警告（小样本均值柱、偏态、跨量级）。

**bio_fig_export** — 图文件合规审计：`paths ★`（图文件路径数组）、`min_dpi`（默认 300）、`width_in/height_in`（目标尺寸英寸，同传才校验）、`preview`（生成 PNG 预览）。返回 `{count, results[{path, verdict(PASS/INFO/WARN/FAIL), issues[{severity, message}], info, preview_png?, preview_error?}]}`。拦截：JPEG 数据图、DPI 不足、尺寸偏差、PDF Type3 字体。

**bio_fig_qa** — 绘图环境自检：`lang`（zh/en，默认 zh）、`journal`（nature/science/ieee/general，默认 nature）。返回 `{matplotlib, cjk_fonts[], cjk_ready, preset_test{journal, lang, ok, applied, error}, hint}`。**cjk_ready=false 时中文标签必然方框**——改英文标签或提示装 Noto CJK。

## 三、工具选择速查（愿望 → 工具）

| 用户愿望 | 工具路径 |
|---|---|
| "这条序列的 GC/翻译/反向互补" | `bio_seq_analyze` |
| "找 ORF / 限制酶切位点 / k-mer" | `bio_seq_find_orf` / `bio_seq_restriction` / `bio_seq_kmer` |
| "读/写 FASTA 文件" | `bio_seq_io_read` / `bio_seq_io_write` |
| "查 TP53 基因信息" | `bio_entrez_search db=gene` |
| "下载 NM_007294 序列" | `bio_entrez_fetch` |
| "这组基因富集到哪些通路" | `bio_enrichr`（×2-3 个库交叉） |
| "查 CRISPR 相关文献" | `bio_pubmed_search` → `bio_pubmed_abstract` |
| "人类参考基因组版本" | `bio_ref_genome species=human` |
| "这组数据怎么画/画成论文图" | `bio_fig_profile` → bio_python 画 → `bio_fig_export` 审计 |
| "中文图会不会出方框" | `bio_fig_qa` |
| "counts 矩阵差异表达" | `bio_r`（bio-proto-r-de 协议） |
| "全基因组排序 GSEA" | `bio_r`（bio-proto-r-gsea 协议） |
| "微生物组多样性/PCoA" | `bio_r`（bio-r-microbiome skill） |
| "系统发育树美化/复杂热图" | `bio_r`（bio-r-vis skill） |
| 以上都覆盖不了 | `bio_python` / `bio_r`（先查 `dsh-bio-genie-guide-skills` 的领域/协议） |

**缓存与限流**（插件已内置，无需你处理）：NCBI 查询类 350ms 间隔、Enrichr 600ms；查询类工具（entrez_search/enrichr/pubmed_search/pubmed_abstract/ref_genome）相同参数 24h 内命中缓存（最多 100 条）。bio_python 代码里直接调 Bio.Entrez 时**必须自己**设 email + 遵守 3 req/s。

**bio_metabolic_model** — 代谢模型管理：`action`（`list` 列出可用模型 / `load` 加载模型 / `info` 显示详情）、`model_id`（默认 `textbook`，COBRApy 内置 E. coli core）。触发词：代谢模型、SBML、代谢网络。

**bio_fba** — 通量平衡分析（FBA）：`model_id`（默认 `textbook`）、`objective`（目标函数反应，可选）。返回最优生长速率、主要反应通量、代谢物影子价格。触发词：FBA、通量平衡、生长速率预测。

**bio_gene_knockout** — 基因敲除分析：`model_id`（默认 `textbook`）、`gene`★（基因 ID 如 `b2779`）。返回敲除后生长速率、变化百分比、必需性判断。触发词：基因敲除、必需基因。

**bio_pathway_search** — 代谢通路搜索（KEGG）：`target_metabolite`★（目标代谢物/关键词）、`organism`（默认 `eco`）、`limit`（默认 10）。触发词：代谢通路、KEGG 通路。

**bio_pathway_design** — 代谢通路设计：`target_product`★（目标产物）、`host_organism`（默认 `eco`）、`strategy`（`shortest`/`max_yield`/`fewest_steps`）。触发词：通路设计、代谢工程。

**bio_ml_pipeline** — 通用 ML 管道：`path`★（CSV 文件）、`target`★（目标列）、`task`（classification/regression）、`model`（random_forest/svm/logistic/linear）。返回评估指标 + 特征重要性。触发词：机器学习、训练、分类、回归。

**bio_ml_reduce** — 降维分析：`path`★（CSV）、`method`（pca/tsne）、`n_components`（默认 2）。返回降维坐标 + 方差解释率。触发词：PCA、t-SNE、降维。

**bio_ml_cluster** — 聚类分析：`path`★（CSV）、`method`（kmeans/hierarchical）、`n_clusters`（默认 3）。返回聚类标签 + 轮廓系数。触发词：聚类、K-Means。

**bio_ml_feature** — 特征重要性：`path`★（CSV）、`target`★（目标列）、`top`（默认 10）。返回特征排序 + 相关性矩阵。触发词：特征选择、变量筛选。

**bio_stats_test** — 统计检验：`path`★（CSV）、`group_col`★、`value_col`★、`test_type`（auto/ttest/mannwhitney/anova/chi2）。返回 p 值 + 效应量。触发词：t 检验、ANOVA、显著性。

**bio_primer_design** — PCR 引物设计：`sequence`★（模板序列）、`product_size`（默认 500）、`tm_target`（默认 60）。返回正/反向引物对。触发词：引物、PCR、Tm。

**bio_seq_optimize** — 密码子优化：`sequence`★（CDS）、`organism`（ecoli/human/yeast）。返回优化序列 + GC%。触发词：密码子优化、表达优化。

**bio_assembly_design** — 组装策略：`fragments`★（DNA 片段列表）、`method`（auto/gibson/golden_gate/restriction）。返回组装方案 + 接头设计。触发词：组装、Gibson、Golden Gate。

**bio_plasmid_map** — 质粒图谱：`name`（质粒名）、`size`（总大小）、`features`★（特征列表）。返回文本质粒注释图。触发词：质粒图、载体图谱。
