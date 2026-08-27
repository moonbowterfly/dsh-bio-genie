---
language: none
---

# 工具全参考（53 个）

> 每个工具：功能 → 参数（★=必填）→ 返回关键字段 → 典型触发词。**选工具第一优先，`bio_python` 执行器第二优先**。

## 一、执行器

### bio_python — 任意 Python 代码执行器

写完整程序到 `code` 参数，在插件隔离环境（biopython + numpy/pandas/scipy/matplotlib/seaborn/Pillow + figurelib）中执行。工作目录 = 会话工作区。

| 参数 | 说明 |
|---|---|
| code ★ | 完整 Python 源码 |
| workdir | 工作目录（绝对路径；默认会话工作区，无工作区时 `~/.dsh/sessions/default`） |
| timeoutMs | 超时（默认 60000ms） |

返回：`ok / stdout / stderr / error / result / exitCode / timedOut / truncated / needs_repair`。
- `result`：你给顶层变量 `result` 赋的 JSON 可序列化值（小结果用它，省得解析 stdout）。
- `needs_repair: true`：stderr 有 traceback，修复代码后重试（最多 2 次修复）。
- 大输出（>1MB 会被截断）→ 写文件再报告路径，不要 print 大量数据。

编程规范 → 加载 `dsh-bio-genie-guide-python`。

### bio_env — 环境诊断/重建

| 参数 | 说明 |
|---|---|
| reinstall | true 时强制重建环境（引导失败或包损坏时用） |

返回：`ready / python / pythonVersion / biopython / numpy / envDir / bootstrapped`。

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

### bio_goal — Autopilot 目标管理

| 参数 | 说明 |
|---|---|
| action ★ | `create` 创建目标 / `status` 查看当前目标 / `pause` 暂停 / `resume` 恢复 / `complete` 标记完成 / `block` 标记阻塞 |
| objective | 目标描述（action=create 必填） |
| maxGoalRounds | 轮次预算上限（action=create 可选，默认框架配置 256） |
| reason | 阻塞原因说明（action=block 必填，需用户输入用 code=need-human-input） |

把复杂分析任务注册为框架级持久目标（带轮次预算与状态机），配合 bio-autopilot 协议使用。触发词：创建目标、任务目标、autopilot、暂停/恢复任务。

## 二、语义化工具

### 序列分析

**bio_seq_analyze** — 一站式序列分析
| 参数 | 说明 |
|---|---|
| sequence ★ | DNA/RNA/蛋白序列字符串 |
| seq_type | `auto`（默认，自动判断）/ dna / rna / protein |
| codon_stats | `true` 时返回密码子统计（DNA 且长度 3 的倍数） |
| codon_host | 统计宿主：`ecoli`（默认）/ human / yeast |

返回：`length / seq_type / gc_fraction / gc_percent / reverse_complement / complement / translations`（DNA 六框 +1~+3、-1~-3；RNA 三框）`/ molecular_weight`（蛋白）/ `aa_composition`（蛋白）。`codon_stats=true` 时另附 `codon_stats`（`total_codons`/`optimal_codons`/`optimal_codon_ratio` 最优密码子占比/top_codons——简化指标，非严格 CAI）。
自动判断规则：含 U 无 T→RNA；含 IUPAC 模糊碱基（RYSWKMBDHVN）、X、gap（-/.）→DNA；出现非核酸字母→蛋白。含 X/gap 的序列安全（翻译前 X/gap→N，不崩溃）。

**bio_seq_translate** — 翻译：`sequence ★`、`table`（密码子表号，默认 1）、`to_stop`（首终止密码子截断）。返回 `{protein, table, to_stop}`。

**bio_seq_gc_skew** — GC skew：`sequence ★`、`window`（默认 100）。返回 `{window, gc_skew[]}`。

**bio_seq_find_orf** — 最长 ORF：`sequence ★`、`min_len`（默认 30nt）、`table`。返回 `{orf: {start, end, length, frame, protein}}`，无 ORF 为 `orf: null`。坐标 0-based 半开。

**bio_seq_kmer** — k-mer 频率：`sequence ★`、`k`（默认 3）、`top`（默认 10）。返回 `{k, total_kmers, unique_kmers, top{}}`。

**bio_seq_io_read** — 读序列文件：`path ★`、`format`（fasta/genbank，默认按扩展名）、`limit`（默认 50）。返回 `{format, count, records[{id, name, description, length, seq_preview}]}`。UTF-8/GBK 自适应。

**bio_seq_io_write** — 写序列文件：`path ★`、`records ★`（`[{id, sequence, description?}]`）、`format`（默认 fasta）。返回 `{path, format, written}`。

**bio_seq_restriction** — 限制酶位点：`sequence ★`、`enzymes`（酶名列表，不传=全部商业常用酶 ~700 种）、`enzyme_set`（commonly/all）、`linear`（默认 true）、`detail`（默认 `false` 摘要模式：**未指定酶时每位点仅返回识别位点+计数**（避免全库扫描超长输出），指定酶时每酶最多 10 个坐标 + `cut_positions_truncated` 标记；`true` 返回全部坐标）。返回 `{sites: {酶名: {cut_positions, recognition_site, count}}, coordinate_base, cut_positions_are, requested?, missing_enzymes?}`。cut_positions 是 **1-based 切点坐标**（切点后第一个碱基，≠ 识别位点起始，偏移由酶切模式决定）。

### 比对与系统发育

**bio_blast_search** — 远程 BLAST（NCBI qblast）：`sequence ★`、`program`（blastn/blastp/blastx，默认 blastn）、`database`（默认 nt 或 nr）、`hitlist_size`（默认 10）、`expect`。**qblast 服务端排队 1-10 分钟属正常，不要重复调用**。返回命中 accession/描述/e-value/score/一致性。

**bio_msa** — 多序列比对：`sequences`（FASTA 字符串）或 `file_path`（二选一）、`program`（clustalw/muscle，默认 clustalw）。调用本机 clustalw/muscle 二进制；缺失时返回 `status=program_missing` 友好提示。返回 Clustal+FASTA 双格式比对、共识序列、保守性统计。

**bio_phylo_build** — 建树：`alignment`（可接 bio_msa 的 alignment_fasta）或 `alignment_file`、`format`（默认 fasta）、`method`（nj/upgma）、`out_file`（可选写 Newick）。返回 Newick 字符串、叶节点数、总枝长。

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

### 组学分析

**bio_deseq2** — 差异表达分析（Python 实现）：`counts_file ★`（counts 矩阵 CSV，行=基因列=样本）、`meta_file ★`（样本信息 CSV，**必须含 `sample` 与 `condition` 两列**——condition 为分组列，取值如 ctrl/trt；用其他列名会报 KeyError）、`contrast`（对比组，格式 `trt_vs_ctrl`）。返回差异基因表。触发词：差异表达。

**bio_gsea** — GSEA 富集分析（Python 实现）：`de_results_file ★`（差异表达结果 CSV）、`gene_sets`（基因集，默认 `hallmark`）。返回富集通路。触发词：GSEA、富集。

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
| "counts 矩阵差异表达" | `bio_deseq2` |
| "全基因组排序 GSEA" | `bio_gsea` |
| "远程 BLAST / 多序列比对 / 建树" | `bio_blast_search` / `bio_msa` / `bio_phylo_build` |
| "微生物组多样性/PCoA" | `bio_python`（scikit-bio/sklearn 配方，见领域 skill） |
| 以上都覆盖不了 | `bio_python`（先查 `dsh-bio-genie-guide-skills` 的领域/协议） |

**缓存与限流**（插件已内置，无需你处理）：NCBI 查询类 350ms 间隔、Enrichr 600ms；查询类工具（entrez_search/enrichr/pubmed_search/pubmed_abstract/ref_genome）相同参数 24h 内命中缓存（最多 100 条）。bio_python 代码里直接调 Bio.Entrez 时**必须自己**设 email + 遵守 3 req/s。

**bio_metabolic_model** — 代谢模型管理：`action`（`list` 列出可用模型 / `load` 加载模型 / `info` 显示详情）、`model_id`（默认 `textbook`，COBRApy 内置 E. coli core）。触发词：代谢模型、SBML、代谢网络。

**bio_fba** — 通量平衡分析（FBA）：`model_id`（默认 `textbook`）、`objective`（目标函数反应，可选）、`reactions`（可选，逗号分隔 reaction id 如 `"EX_succ_e,PPC"`，传参时 flux/flux_ranges 只返回这些反应；全库 FVA 约 95 反应、45KB 级，只关心少数反应时务必传它缩小输出；不存在的 id 返回带 hint 的提示）。返回最优生长速率、主要反应通量、代谢物影子价格。触发词：FBA、通量平衡、生长速率预测。

**bio_gene_knockout** — 基因敲除分析：`model_id`（默认 `textbook`）、`analysis_type`（`single` 默认，此时 `gene`★ 必填，基因 ID 如 `b2779` / `essentiality` / `double` / `optknock` 模式下无需传 gene）。返回敲除后生长速率、变化百分比、必需性判断。触发词：基因敲除、必需基因。

**bio_pathway_search** — 代谢通路搜索（KEGG）：`target_metabolite`★（目标代谢物/关键词）、`organism`（默认 `eco`）、`limit`（默认 10）。触发词：代谢通路、KEGG 通路。

**bio_pathway_design** — 代谢通路设计：`target_product`★（目标产物）、`host_organism`（默认 `eco`）、`strategy`（`shortest`/`max_yield`/`fewest_steps`）。触发词：通路设计、代谢工程。

**bio_ml_pipeline** — 通用 ML 管道：`path`★（CSV 文件）、`target`★（目标列）、`task`（classification/regression）、`model`（random_forest/svm/logistic/linear）。返回评估指标 + 特征重要性。触发词：机器学习、训练、分类、回归。

**bio_ml_reduce** — 降维分析：`path`★（CSV）、`method`（pca/tsne）、`n_components`（默认 2）。返回降维坐标 + 方差解释率。触发词：PCA、t-SNE、降维。

**bio_ml_cluster** — 聚类分析：`path`★（CSV）、`method`（kmeans/hierarchical）、`n_clusters`（默认 3）。返回聚类标签 + 轮廓系数。触发词：聚类、K-Means。

**bio_ml_feature** — 特征重要性：`path`★（CSV）、`target`★（目标列）、`top`（默认 10）。返回特征排序 + 相关性矩阵。触发词：特征选择、变量筛选。

**bio_stats_test** — 统计检验：`path`★（CSV）、`group_col`★、`value_col`★、`test_type`（auto/ttest/mannwhitney/anova/chi2）。返回 p 值 + 效应量。触发词：t 检验、ANOVA、显著性。

**bio_primer_design** — PCR 引物设计：`sequence`★（模板序列）、`product_size`（默认 500）、`tm_target`（默认 60）、`top_n`（默认 5）、`tm_diff_max`（默认 5）。返回正/反向引物对（每个候选含 `quality`=good/ok/poor 与 `issues` 说明；`fwd_position`/`rev_position` 为 **0-based 切片索引**；无满意候选时返回 `advice` 调整建议）。触发词：引物、PCR、Tm。

**bio_seq_optimize** — 密码子优化：`sequence`★（CDS）、`organism`（ecoli/human/yeast）。返回优化序列 + GC%。触发词：密码子优化、表达优化。

**bio_assembly_design** — 组装策略：`fragments`★（DNA 片段列表）、`method`（auto/gibson/golden_gate/restriction）。返回组装方案 + 接头设计 + `next_step`（提示用 bio_clone_simulate 做环化组装模拟）。触发词：组装、Gibson、Golden Gate。

**bio_plasmid_map** — 质粒图谱：`name`、`size`、`features`★（特征列表）。传 `genbank_file` 或 `features`+`sequence` 时输出 PNG/SVG 图形文件（dna-features-viewer，`output_format`/`out_file`/`figure_width`/`highlight_regions` 可控），返回 `mode=graphic` + `output_file`（绝对路径）；**仅传 features 时只有文本注释图（`mode=text`，`output_file=null`，不生成文件）**。触发词：质粒图、载体图谱、plasmid map。

### 合成生物学（Phase 1）

**bio_crispr_guide** — CRISPR 向导 RNA 设计：`sequence ★`（靶序列）、`cas`（Cas 变体）、`gc_min`/`gc_max`（GC% 区间）、`max_offtargets`、`max_mismatches`、`top_n`。返回候选 gRNA 列表（GC%/脱靶风险评分排序）。触发词：CRISPR、gRNA、向导 RNA、基因编辑。

**bio_crispr_verify** — CRISPR 编辑验证：`wild_type ★`（编辑前序列）、`edited ★`（编辑后序列）。返回比对长度/一致性/编辑摘要/突变清单/编辑效率估计。触发词：编辑验证、敲入敲除确认、测序结果核对。

**bio_dna_syncheck** — DNA 合成可行性检查：`sequence ★`、`min_gc_window`/`max_gc_window`（窗口 GC 上下限）、`homopolymer_threshold`、`poly_run_min`。返回不可合成区域/需改序位点。触发词：合成可行性、gene synthesis、合成难度。

**bio_wetlab_design** — 湿实验方案生成：`protocol_type ★`（pcr_amplification / gibson_assembly / golden_gate / restriction_cloning / crispr_editing / strain_construction / transformation）、`input_data ★`（上游工具输出的 **dict 对象**，如 bio_primer3_design / bio_clone_simulate 的返回）、`host_organism`、`scale`（small/medium/large）。返回完整 protocol（试剂体系/反应条件/QC）。选型前提：`strain_construction` 仅用于敲除增产场景，`input_data` 须含 knockouts/recommended_knockouts（来自 optknock），否则返回 guidance 引导；非敲除场景（过表达/异源表达）用 `transformation` 或 `crispr_editing`。触发词：实验方案、protocol、湿实验步骤。

**bio_primer3_design** — 工业级引物设计（Primer3）：`sequence ★`、`target_region [start,len]`、`primer_size`/`tm_range`/`gc_range`、`max_hairpin_tm`/`max_self_any_tm`、`num_return`（默认 5）。返回候选引物对（Tm/GC%/发夹/二聚体评分 + penalty 排序，rank 1 推荐；`position` 为 **0-based** Primer3 约定）。与 bio_primer_design（简单版）区分：需要可投稿级引物质量时用本工具。触发词：Primer3、工业级引物、qPCR 引物。依赖说明：primer3-py 属第二层按需依赖（auto），首次调用本工具时运行时自动补装，无需手动操作。

**bio_dna_optimize** — 多约束 DNA 优化（DNA Chisel）：`protein_sequence` 或 `dna_sequence`（二选一）、`host_organism`（默认 e_coli）、`constraints`（remove_restriction_sites/gc_range/avoid_motifs）、`codon_optimize`（默认 true）。保持氨基酸不变，多约束满足后做密码子优化，返回优化序列 + 修改报告。与 bio_seq_optimize（简单替换）区分。触发词：多约束优化、去除酶切位点、DNA Chisel。依赖说明：dnachisel 属第二层按需依赖（auto），首次调用时自动补装（PyPI 上限 3.2.16，安装约束 >=3.2,<4）。

**bio_clone_simulate** — 克隆模拟（pydna，**第二层依赖，首次调用自动安装**）：`backbone ★`、`inserts ★`（[{name,sequence}]）、`method`（gibson/golden_gate/restriction/ligation）、`overlap`（Gibson 同源臂下限，默认 20）、`restriction_enzymes`。Gibson 返回预期产物序列；Golden Gate/酶切做位点可行性检查。触发词：克隆模拟、Gibson 组装模拟、质粒构建验证。

**bio_sbol_write** — SBOL 3 写出：`components ★`（[{name,type,sequence,role}]）、`output_file ★`（**必须用 `.xml`/`.rdf`/`.ttl`/`.json` 扩展名**——pySBOL3 按扩展名识别格式，其他扩展名报 "Unable to determine file format"）、`namespace`。role 经 tyto 解析为 SO 本体 URI。返回写入路径 + 组件数。触发词：SBOL、标准化设计导出。

**bio_sbol_read** — SBOL 3 读取：`sbol_file ★`、`include_sequences`（默认 true）。返回组件列表（types/roles URI + 关联序列）。触发词：SBOL 读取、SBOL 解析。

### 代谢工程增强（Phase 2）

**bio_fba** 增强 — 新增 `analysis_type`：`fba`（默认，行为不变）/ `fva`（通量可变性，返回每反应 [min,max] 范围，`fraction_of_optimum` 可调）/ `pfba`（节俭 FBA，最小化总通量）。另支持 `reactions`（逗号分隔 reaction id）过滤输出反应，避免全库 FVA 45KB 级输出。

**bio_gene_knockout** 增强 — 新增 `analysis_type`：`single`（默认，行为不变，`gene` 必填）/ `double`（top_n 候选两两双敲，找合成致死对）/ `essentiality`（全基因必需性扫描）。

**bio_production_envelope** — 生产包络线：`target_reaction ★`（产物反应如 EX_ac_e）、`vary_reaction ★`（扫描反应如 BIOMASS）、`points`（默认 20）。返回 vary_flux→target_flux 曲线与产物理论上限。触发词：生产包络、产量预测。

### 基因回路建模（Phase 3，第二层按需安装）

**bio_circuit_compile** — 基因回路编译（BioCRNpyler，**第二层依赖，首次调用自动安装**）：`components ★`（[{type: promoter|rbs|cds|terminator, name, regulators?}]）、`name`（构建体名称，默认 circuit）、`context`（表达体系，txtl_extract/expression，默认 txtl_extract）、`out_file`（SBML 输出路径，可选，默认工作区 `<name>.xml`；⚠️ 参数名是 `out_file`，无 `output_sbml` 参数）。组装 DNA_construct → TxTlExtract → compile_crn()，返回 SBML 路径 + 物种数/反应数 + networkx 网络图 PNG。构建体 DNA 模板物种（`dna_part_*`）初始浓度默认设为 1.0（相对体系 RNAP=0.5/Ribo=10/RNase=0.25），避免默认仿真全零；显式设置的正值不会被覆盖。触发词：基因回路、回路编译、repressilator、CRN。

**bio_circuit_simulate** — 回路动力学仿真（Bioscrape，**第二层依赖，首次调用自动安装**）：`sbml_file ★`（bio_circuit_compile 的输出）、`simulation_type`（ode 默认 / ssa 随机模拟）、`timepoints`（{start, end, points}，默认 0-200 共 200 点）、`parameter_overrides`（参数覆盖 dict；**只能覆盖参数**（速率常数等），不能覆盖物种初始浓度——覆盖键不是 SBML parameter id 时返回 `invalid_overrides` + `hint`，不报错）、`out_file`（曲线图输出路径，可选）。返回动力学曲线图 PNG（matplotlib，物种浓度 vs 时间）+ 稳态值 + 峰值时间；稳态全零时 `note` 附诊断提示（检查 DNA 模板/物种初始浓度）。触发词：回路仿真、动力学模拟、SSA 随机模拟。
