---
language: none
---

# 工具全参考（99 个）

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

**bio_seq_introns** — 内含子-外显子结构：`accession`（**基因组类**登录号 NG_/NC_，如 `NG_005905`）或 `genbank_file`（二选一）、`gene`（按 gene/locus_tag **精确**匹配，不区分大小写）、`max_features`（默认 10）。返回 `{record_id, record_length, organism, count, available_genes, transcripts[{feature_type, name, gene, strand, location, exon_count, intron_count, exons[{start,end,length}], introns[{start,end,length,donor_dinucleotide,acceptor_dinucleotide,splice_class}], protein_length_aa, coding_length_bp}], splice_summary{total_introns, canonical_GT_AG, canonical_fraction}}`。
**坐标约定**：均为基因组坐标的 **1-based 闭区间**，且**按转录方向（5′→3′）排序**——负链基因的外显子坐标因此**递减**；其 donor/acceptor 已反向互补到转录方向后再判定 GT-AG（直接取基因组首末二核苷酸会把正负链混为一谈，经典 GT-AG 会全判错）。
**基因过滤为精确匹配**：product 描述常提及邻近基因名（NBR1 的 product 写着 "next to BRCA1 gene 1 protein"），子串匹配会让查 BRCA1 的用户拿到 NBR1。未匹配时返回 `available_genes` 全清单便于纠正。
**其他**：同一基因同时有 CDS 与 mRNA 注释时只返回 CDS（外显子集合相同且不含 UTR）；成熟 mRNA 与原核记录本无内含子，工具会明确说明（不会返回空结果冒充"没查到"）。

**bio_rna_fold** — RNA 二级结构预测（ViennaRNA，首次调用自动装）：`sequence ★`（RNA；DNA 自动 T→U）、`output_file`（可选结构示意图 PNG）、`also_ensemble`（默认 true）。返回 `{sequence_length, structure_dot_bracket, mfe_kcal_per_mol, base_pairs, pair_list[{i,j,pair}], gc_fraction, ensemble{free_energy_ensemble_kcal_per_mol, mfe_structure_agrees, mean_base_pair_distance}}`。**ΔG 越负越稳**；`mean_base_pair_distance` 越小结构越确定（越大说明存在多个竞争构象）。预测结构非实验结构，引用时注明。

**bio_sc_qc** — 单细胞 RNA-seq 质控（scanpy，首次调用自动装）：`input_file ★`（`.h5ad` 或 10X `.h5`）、`output_dir`（默认工作区 `sc_qc/`）、`species`（human/mouse/zebrafish/other，**决定线粒体基因前缀：human=`MT-`，mouse=`mt-`，选错 MT% 恒为 0**）、`mad_counts`/`mad_genes`/`mad_mt`（MAD 阈值，默认 5/5/3）、`min_genes`（默认 200）、`min_cells`（默认 3）、`mt_cap`（线粒体%硬上限，可选）、`apply_filter`（默认 true）、`make_plots`（默认 true）。
返回 `{cells_raw, genes_raw, cells_after_filter, cells_removed, cells_retained_fraction, qc_before{median_*}, thresholds{counts_range, genes_range, pct_mt_max, ...}, filter_breakdown{failed_counts_mad, failed_genes_mad, failed_mt_mad, failed_min_genes}, genes_after_filter, filtered_file, with_qc_file, qc_figure, comparison_figure}`。MAD 过滤按 scverse 最佳实践（先 log1p 再算中位数绝对偏差）。

### FASTA/GFF 批量工具箱（序列与注释）

**bio_fasta_extract** — FASTA 批量提取/过滤/子序列
| 参数 | 说明 |
|---|---|
| input ★ | 输入 FASTA 文件路径 |
| ids / id_file | 要提取的 ID 列表 / 每行一个 ID 的文件（可同用，去重合并） |
| regions | 坐标区域数组，如 `["chr1:100-200"]`（1-based 闭区间） |
| region_table | TSV 区域表（文件路径或文本；3 列 seqid/start/end 或 4 列 name/seqid/start/end——表格复制坐标场景） |
| filter | 条件过滤：`{min_len, max_len, min_gc, max_gc, id_regex}` |
| id_match | ID 匹配方式：`exact`（默认）/ first_word / contains |
| longest | `true` 时按 ID 分组（竖线/点/空白前）取最长序列 |
| output_file | 输出路径（默认 `<输入名>.extracted.fasta`） |

返回：`{count, requested, missing[], missing_count, total_bp, output_file, preview[]}`。流式索引（先扫一遍建 offset 再按需 seek），大文件友好；全部请求零命中时报错（fail-closed），部分缺失列出 missing。

**bio_fasta_stats** — 批量统计
`input ★`、`per_sequence`（默认 true）、`write_table`（默认 true）、`window_size`/`window_step`（可选滑窗）、`output_file`。
返回：`{n, total_bp, mean_len, median_len, min_len, max_len, n50, n90, gc_percent, length_histogram{bins}, per_sequence_preview[], table_file, window_stats?}`。

**bio_fasta_table** — FASTA↔TSV 互转
`input ★`、`action`（to_table 默认 / to_fasta）、`fields`（to_table 列：id/description/length/gc_percent）、`include_sequence`（加 sequence 列）、`id_col`/`sequence_col`/`description_col`（to_fasta 列名）、`output_file`。
要点：to_fasta 要求表格含指定序列列（缺列明确报错）；含序列列时 roundtrip 无损。

**bio_fasta_ids** — ID 批量重写
`input ★`、`action`（simplify 默认 / rename / prefix / suffix）、`map_file`（rename：两列映射）、`pattern`+`group`（simplify 自定义正则）、`text`（prefix/suffix）、`keep_description`、`output_file`。
simplify 默认截到首个空白/竖线/点之前（`geneA.1`→`geneA`）；rename 未命中 ID 原样保留并计入 `unmapped_preview`。

**bio_seq_batch_translate** — 批量翻译
`input ★`、`frame`（auto 默认 / 0 / 1 / 2 / all6）、`table`（默认 1）、`to_stop`、`trim_stop`、`output_file`。
返回：`{count_in, count_out, warnings[], output_file}`。all6 每序列输出 6 条（`id|frame+1` 等）；长度非 3 倍数与内部终止密码子进 warnings。

**bio_orf_predict** — ORF 预测
`input ★`、`min_aa`（默认 30）、`strands`（both 默认 / plus）、`mode`（complete 默认 / complete_partial）、`max_orfs_per_seq`（默认 200）、`table`、`output_file`。
返回：`{n_orfs, top_orfs[{id, start, end, strand_frame, length_nt, length_aa, kind}], output_file}`。坐标 1-based 闭区间、含终止密码子；kind：complete / partial_end（无终止）/ partial_start（无 ATG）。

**bio_protein_params** — 蛋白参数（ProtParam 等效）
`sequence`（单序列）或 `input`（FASTA 批量）、`label`、`limit`、`output_file`。
返回：`{count, results[{id, length, molecular_weight_kda, isoelectric_point, gravy, aromaticity, aliphatic_index, extinction_coeff_280_reduced, extinction_coeff_280_cystine, aa_composition_percent}]}`。批量 >100 条时表落盘。

**bio_ssr_mine** — SSR 微卫星挖掘
`input ★`、`max_motif_len`（默认 6）、`min_repeats`（自定义阈值 `"1:12,2:7,3:5"`；默认 单10/双6/三5/四5/五4/六4）、`output_file`。
返回：`{total_ssr, by_type, preview[{id, type, motif, position, repeats, length}], output_file}`。同一区间多周期命中保留最短周期。

**bio_primer_check** — 引物定位/扩增子
`primers`（`[{name?, sequence}]`）和/或 `pairs`（`[{name?, forward, reverse}]`）、`input`（目标 FASTA）或 `sequences`、`max_mismatch`（默认 0）、`min_amplicon`/`max_amplicon`。
返回：`{primers[{name, n_hits, hits[{target, position, end, mismatches}]}], pairs[{name, n_amplicons, amplicons[{target, forward_at, reverse_at, size}]}]}`。3' 端种子严格匹配；reverse 引物按合成序传入（内部自动 rc 搜索）；坐标 1-based。

**bio_gff_positions** — GFF 位置表
`gff ★`、`types`（默认 ["gene"]）、`attrs`（附加属性列，默认 ["ID","Name"]）、`output_file`。
返回表列：seqid/type/start/end/strand/length + 属性列。types 无匹配时列出文件中的实际类型。

**bio_gff_sequences** — 基因组+GFF 特征序列提取
`genome ★`、`gff ★`、`feature`（CDS 默认 / gene / mRNA / exon / promoter）、`ids`（过滤）、`promoter_len`（默认 2000）、`limit`、`check_cds`、`output_file`。
要点：CDS 按转录本归组、区间并集拼接（自动处理 1bp 重叠，报告 `overlap_nt_removed`）；负链整体反向互补；拼接后检查长度 %3 与内部终止密码子（warnings）。promoter 取 TSS 上游（负链 TSS=gene end）。
返回：`{count, n_not_multiple_of_3, total_bp, output_file, warnings[], preview[]}`。

**bio_gff_ops** — GFF 统计/过滤/区域提取
`gff ★`、`action`（stats 默认 / filter / extract_region）、`types`/`seqids`/`region`/`attr_regex`（过滤条件）、`output_file`。
stats 返回：`{by_type, per_seqid_top, gene_length_stats{count, mean, min, max, n50}}`。

### 出版级可视化

**bio_plot_gene_structure** — 基因结构图
`gff ★`、`ids`（指定基因）、`max_genes`（默认 20）、`width`、`title`、`lang`（zh/en）、`output_file`。
返回：`{n_genes, genes[{id, exons, length_bp}], files[]}`。外显子盒+内含子线+链方向标记；输出 300dpi PNG + 可编辑文本 SVG。

**bio_plot_gene_locations** — 基因位置图
`gff ★`、`chroms`、`ids`（高亮）、`width`、`max_labels`（默认 30）、`title`、`output_file`。
每条染色体一条比例条带 + 基因刻度；ids 中基因红点高亮并标注。

**bio_plot_gene_density** — 基因密度图
`gff ★`、`window`（默认 100000 bp）、`chroms`、`per_mb`（默认 false=计数）、`width`、`output_file`。
返回 `{window, chroms[{chrom, bins, genes}], files[]}`。

**bio_plot_heatmap** — 聚类热图
`matrix ★`（TSV/CSV）、`cluster_rows/cluster_cols`（默认 true）、`scale`（none/row/col）、`cmap`（默认 RdBu_r；rainbow/jet 色系直接报错）、`width/height`、`output_file`。
行/列 average-linkage 层次聚类 + 树状图；色标范围按 2-98 百分位裁剪。

**bio_plot_venn** — Venn 图（2-3 组）
`groups`（数组的数组）或 `group_files`（每行一个元素）、`labels`、`title`、`output_file`。>3 组报错并提示改用 UpSet。

**bio_plot_upset** — UpSet 图
`groups` / `group_files`、`labels`、`top_n`（默认 20）、`min_size`、`include_singletons`、`output_file`。支持 2-12 组；交集按规模排序。

**bio_plot_enrichment** — 富集条形图
`table ★`、`term_col/p_col/count_col`（默认按列名自动识别）、`top_n`（默认 20）、`output_file`。
按 -log10(p) 排序横向条形；count 列存在时标注 n=。

**bio_plot_domains** — 蛋白结构域示意图
`table ★`、`protein_col/start_col/end_col/domain_col/length_col`（自动识别）、`max_proteins`（默认 25）、`output_file`。
同域名同色（Okabe-Ito 调色板）；域盒上下错位排列避免遮挡。

> 全部绘图工具：`lang=zh`（默认）自动配置中文字体；输出默认 300dpi PNG+SVG（可用 `formats` 增补 PDF）。

### 共线性分析

**bio_collinearity** — 共线性/同线性分析（DAGchainer 链化 + 置换检验）
`prefix`（读 `<prefix>.gff` 与 `<prefix>.blast`）或显式 `gff` + `blast`。
参数：`match_score`（默认 50）、`match_size`（5）、`gap_penalty`（-1）、`e_value`（1e-5）、`max_gaps`（25）、`overlap_window`（5）、`in_synteny`（0=种内+种间默认 / 1=仅种内 / 2=仅种间）、`output_file`。
输入：GFF 4 列（物种前缀/gene/start/end；同物种内基因唯一）+ BLAST outfmt 6（取第 11 列 E-value）。
输出：`.collinearity` 交换格式（参数快照 + 统计 + 块头 `## Alignment i: score= e_value= N= mol_pair plus/minus` + 锚点行），可被生态下游工具直接消费。
返回：`{n_genes, n_anchors, n_mol_pairs, n_blocks, n_collinear_genes, percentage, top_blocks[], output_file}`。

**bio_kaks** — Ka/Ks（dN/dS）计算（NG86 + Jukes-Cantor）
`sequence1 ★` / `sequence2 ★`（CDS 内容或文件路径）、`label1` / `label2`、`protein_aln`（可选：两行蛋白比对文本）。
流程：蛋白比对（内部 BLOSUM62 或给定）→ 回译密码子对齐 → NG86 位点/替换计数（多碱基差异路径平均）→ JC 校正。
返回：`{S, N, Sd, Nd, pS, pN, Ks, Ka, omega, interpretation, Ks_reason?, Ka_reason?, codons_used, codons_excluded}`。
哨兵约定：pS/pN ≥ 0.75（饱和）或 Ks==0 时对应字段为 `null`（`Ks_reason` 说明）；生态兼容语义 = `-2`。
注意：成对 omega 为平均选择压力；位点级正选择需位点模型（codeml M1a/M2a、M7/M8）。

**bio_plot_synteny** — 共线性可视化（双物种）
`collinearity ★`（.collinearity 文件）、`gff ★`（4 列，用于染色体长度）、`view`（bands 条带连线 / dotplot 点阵）、`species_pair`（物种前缀对，如 "at&os"；默认自动取块数最多的对）、`max_lines`（默认 200）、`width`/`height`、`title`、`output_file`。
返回：`{species_pair, view, n_blocks_drawn, chroms, files[]}`。

**bio_plot_circos** — 基因组环图（极坐标）
`gff ★`、`window`（密度窗口 bp，默认 500000）、`width`、`title`、`output_file`。
返回：`{n_chroms, total_bp, window, chroms[], files[]}`。染色体弧（按长度比例）+ 内圈基因密度轨道。

## 外部工具链（批次 D）

**bio_hmm_search** — HMM 轮廓搜索/建库（HMMER 引擎，纯 pip 依赖）
`action ★`（build / search）、`msa`（build：对齐 FASTA）、`hmm`（search：.hmm 文件或目录）、`sequences`（search：目标 FASTA）、`e_value_max`（默认 0.01）、`top`（默认 50）、`output_file`。
返回：build → `{n_sequences, alignment_length, hmm_file}`；search → `{n_hits, hits[{hmm, target, evalue, score, bias, description}]}`（按 E-value 排序）。
说明：首次调用经第二层依赖机制安装 pyhmmer（无需外部程序）；单 HMM 建库后可直接搜索。

**bio_msa_trim** — 多序列比对裁剪（trimAl 引擎，首次调用自动获取）
`input ★`、`method`（automated1 默认 / gappyout / strict / gt）、`gt`（method=gt 时的比例阈值）、`output_file`。
返回：`{sequences, columns_before, columns_after, columns_removed, output_file, binary}`。
说明：二进制钉 v1.5.0（v1.5.1 的官方 Windows 构建在部分环境无法启动），自举到插件私有目录。

**bio_phylo_ml** — ML 最大似然建树（IQ-TREE2 引擎，首次调用自动获取）
`alignment_file` 或 `alignment`（内容）、`model`（默认 MFP=自动模型选择）、`bootstrap`（超快自助次数，默认 1000；0=不跑）、`threads`（默认 AUTO）、`seed`、`output_prefix`。
返回：`{best_model, bootstrap, tree_newick, report_excerpt, output_prefix, binary}`。
说明：模型选择 + UFBoot 一步到位；大数据集请适当调大 timeout 感知预期（工具层 timeoutMs=900s）。

### 比对与系统发育

**bio_blast_search** — 远程 BLAST（NCBI qblast）：`sequence ★`、`program`（blastn/blastp/blastx，默认 blastn）、`database`（默认 nt 或 nr）、`hitlist_size`（默认 10）、`expect`。**qblast 服务端排队 1-10 分钟属正常，不要重复调用**。返回命中 accession/描述/e-value/score/一致性。

**bio_msa** — 多序列比对：`sequences`（FASTA 字符串）或 `file_path`（二选一）、`program`（clustalw/muscle，默认 clustalw）。调用本机 clustalw/muscle 二进制；缺失时返回 `status=program_missing` 友好提示。返回 Clustal+FASTA 双格式比对、共识序列、保守性统计。

**bio_phylo_build** — 建树：`alignment`（可接 bio_msa 的 alignment_fasta）或 `alignment_file`、`format`（默认 fasta）、`method`（nj/upgma）、`out_file`（可选写 Newick）。返回 Newick 字符串、叶节点数、总枝长。

**bio_phylo_compare** — 树比较：`tree1 ★` / `tree2 ★`（Newick 字符串或文件路径）、`detail`（默认 true）。返回 `{shared_leaves, tree1_splits, tree2_splits, shared_splits, robinson_foulds_distance, max_possible_rf, normalized_rf, trees_identical_topology, splits_only_in_tree1[], splits_only_in_tree2[]}`。**RF 为无根树分裂对称差**（0 = 拓扑完全一致；归一化值 0-1）。两棵树叶名须为同一套，缺失叶自动剪除并在 `dropped_from_*` 列出；<4 个共有叶会拒绝比较。

**bio_seq_dotplot** — 序列点阵图：`seq1 ★` / `seq2 ★`（内容或文件路径）、`window`（默认 15）、`threshold`（一致性阈值 0-1，默认 0.7）、`output_file`（默认工作区 `dotplot.png`）。返回 `{dots, dot_density, main_diagonal_hits, self_comparison, output_file, anchor_step}`。同源区段=主对角，反向重复=副对角，串联重复=平行带。锚点超 3000 自动步进降采样。

### 数据检索（网络）

**bio_entrez_search** — NCBI 检索：`term ★`（如 `"TP53[Gene Name] AND human[Organism]"`）、`db`（nucleotide/protein/gene，默认 nucleotide）、`retmax`（默认 5）、`email`（建议传）。
返回 `{db, count, ids[], summaries[]}`。db=gene 时 summary 含 `name/chromosome/map_location/chr_start/chr_stop/aliases/summary`；db=nucleotide/protein 含 `title/length/accession`。

**bio_entrez_fetch** — 按 ID 取序列：`ids ★`、`db`、`rettype`（默认 fasta）、`email`。返回 `{db, rettype, data}`（文本，上限 50k 字符）。

**bio_enrichr** — 通路富集：`genes ★`（符号列表 5-500 个）、`library`（默认 `GO_Biological_Process_2023`；另可选 `GO_Molecular_Function_2023`、`GO_Cellular_Component_2023`、`KEGG_2021_Human`、`Reactome_2022`、`MSigDB_Hallmark_2020`、`WikiPathway_2023_Human`）、`top`（默认 10）。
返回 `{library, gene_count, total_terms, top, results[{rank, term, p_value, odds_ratio, combined_score, overlap_genes[], overlap_count, adjusted_p_value}]}`。**解读按 adjusted_p_value 升序**；GO 与 KEGG 的 p 值不可互相比较（背景集不同）。

**bio_pubmed_search** — 文献检索：`term ★`（支持 PubMed 语法）、`retmax`（默认 10）、`email`。返回 `{db, count, pmids[], results[{pmid, title, journal, date, authors[], doi, has_abstract}]}`。

**bio_pubmed_abstract** — 结构化摘要：`ids ★`（PMID 列表）、`email`。返回 `{db, count, results[{pmid, title, abstract, authors[], journal, date, doi}]}`。一次 ≤30 个 PMID。

**bio_ref_genome** — 参考基因组信息：`species ★`（human/mouse/rat/zebrafish/fly/yeast/arabidopsis/ecoli 等常用名或 Ensembl 目录名）。返回 `{species, assembly_name, assembly_accession, assembly_date, karyotype, chromosomes[{name, length}], scaffold_count, download_urls}`。

**bio_uniprot** — UniProt 蛋白知识库（真实 REST）：`accession`（UniProt 号，如 P38398）、`mode`（`entry` 默认完整摘要 / `ptm` 修饰位点+证据码 / `xref` 交叉引用按库归并 / `pathway` 通路 / `sequence` FASTA / `search` 关键词检索）、`query`（search 模式检索式）、`limit`（search 默认 10）。
`entry` 返回 `{protein{accession, entry_name, protein_name, genes[], organism, taxon_id, length, mass_da, function[]}, feature_counts, key_features[], xref_database_count}`；`ptm` 返回 `{ptm_counts, total_sites, sites_by_type}`（Modified residue / Cross-link / Glycosylation / Lipidation / Disulfide bond，位点为 1-based 序列坐标 + ECO 证据码）；`xref` 返回 `{database_counts, database_total, xref_total}`（GO/RefSeq/PDB/Reactome/KEGG 等，100+ 库）。**蛋白注释不要绕道 bio_entrez_fetch**，UniProt 粒度远高。

**bio_plasmid_search** — Addgene 质粒库检索（实时抓取公开目录页，无需登录）：`query ★`、`limit`（默认 20，上限 50）、`sort`（relevance/newest/oldest/alpha_asc/alpha_desc）。返回 `{total_matches, returned, truncated, results[{addgene_id, name, category, purpose, depositor, publication, insert, use, popularity, url}]}`。**只给检索与元数据，不给序列**——序列需用户在 Addgene 登录后获取。空结果只代表 Addgene 确无匹配；结构变化会**响亮报错**而非静默返回空。

**bio_plasmid_info** — 按 ID 取质粒完整元数据：`plasmid_id ★`（如 `"52961"` = lentiCRISPR v2）。返回 `{name, description, fields{...30+ 字段}, sections{按节分组}, sequence_access{sequences_page, login_required, how_to_get}}`。字段含 Purpose / Bacterial Resistance(s) / Copy number / Growth Strain(s) / Growth Temperature / Vector type / Selectable markers / Total vector size (bp) / Promoter / Tag / Insert Size (bp) / Cloning method / 5′·3′ cloning site 与测序引物等。

**bio_source_audit** — 数据来源审计（「先查后写」工具化）：把交付物里的标识符/序列与权威来源逐项核验。`mode ★`（`identifiers` 存在性+比对项 / `sequences` 序列溯源 / `scan` 候选抽取·不联网）、`items_json` 或 `items_file`（JSON 数组）、`text` 或 `file`（scan）、`out_md`（可选审计报告）。
`identifiers` 条目：`{"db": "ncbi_nucleotide|ncbi_protein|ncbi_gene|uniprot|pdb|ensembl|pmid", "id": "...", "expect": {"organism_contains"?, "title_contains"?, "length"?, "year"?, "gene_contains"?}}`；`sequences` 条目：`{"db", "id", "sequence"}`——逐字命中（正链）或反向互补一致（负链）均算命中，返回 strand 与 1-based 位置。**六态严禁混用**：`verified` / `mismatch` / `partial` / `not_found`（源明确无记录）/ `unreachable`（未能查询，不是准确性结论）/ `error`。单次 ≤25 条；多源核验自带节流。

### 出版级绘图

**bio_fig_profile** — 数据剖析+图型建议（画图前必跑）：`path ★`（CSV/TSV/Excel）、`group_cols`（分组列名数组）。返回 `{source, n_rows, n_cols, columns{列名:{type, n, mean, median, sd, min, max, skewness, n_outliers_iqr, missing_rate, ...}}, correlation, group_summary, warnings[], suggestions[]}`。suggestions 是图型建议+风险警告（小样本均值柱、偏态、跨量级）。

**bio_fig_export** — 图文件合规审计：`paths ★`（图文件路径数组）、`min_dpi`（默认 300）、`width_in/height_in`（目标尺寸英寸，同传才校验）、`preview`（生成 PNG 预览）。返回 `{count, results[{path, verdict(PASS/INFO/WARN/FAIL), issues[{severity, message}], info, preview_png?, preview_error?}]}`。拦截：JPEG 数据图、DPI 不足、尺寸偏差、PDF Type3 字体。

**bio_fig_qa** — 绘图环境自检：`lang`（zh/en，默认 zh）、`journal`（nature/science/ieee/general，默认 nature）。返回 `{matplotlib, cjk_fonts[], cjk_ready, preset_test{journal, lang, ok, applied, error}, hint}`。**cjk_ready=false 时中文标签必然方框**——改英文标签或提示装 Noto CJK。

**bio_fig_lint** — FIG 级出版语义 lint（画完图立刻自检视觉选择，无 fig 对象依赖）：`colors_used`（实际用色 hex 数组）、`cmap_used`（连续 colormap 名）、`n_categorical`（类别总数）、`err_semantics`（误差棒语义声明，未画传 "none"）、`has_stat_metadata`（图上 p 值/星号是否有检验元数据）、`n_available`（exact n 是否声明）、`min_pt`（默认 5）。返回 `{issues[{severity, message}], verdict(PASS/WARN/FAIL), hint}`。拦截：红绿对（FIG003）、rainbow/jet 色图（FIG004）、纯色相编码 >8 类（FIG005）、灰度坍缩（FIG015）、误差棒/统计谱系/exact n 未声明（FIG008/009/010）。**识别规则**：分类=Okabe-Ito 色板；连续=viridis/cividis/batlow；diverging 必须 center=0。

### 组学分析

**bio_deseq2** — raw counts 差异表达：`counts_file ★`（行=基因、列=样本，有限非负整数）、`meta_file ★`（含 `sample` 和设计因子，默认 `condition`）、`contrast`（`trt_vs_ctrl`）、`design`（如 `~type + condition`）、`factor`/`numerator`/`denominator`（显式比较）、`backend`（默认 `pydeseq2`，旧近似需显式 `legacy_welch`）、`out_csv`（全精度完整表路径）。正式后端固定核验 PyDESeq2 0.5.4，负二项 GLM、离散度估计、Wald 检验、BH-FDR；**本版不执行 LFC 收缩**。旧 Welch 不需要 PyDESeq2，返回自己的局限声明。完整样本匹配、设计秩和比较水平受检；`method` 保存实际样本顺序、输入 hash、过滤与后端版本。缺包/拟合/写盘失败不降级。`out_csv` 未给时返回 `full_results`。触发词：差异表达。

**bio_gsea** — GSEApy 1.3.1 正式 prerank：`de_results_file ★`（完整受检基因排序表，含 `gene` 和 `ranking_column`，默认 `stat`）、`gene_set_file`（GMT）或 `gene_sets`（真实命名库，二选一且无示例回退）、`seed`、`permutation_num`、`min_size`/`max_size`、`out_csv`。`species`/`id_namespace` 与 `gene_set_species`/`gene_set_id_namespace` 用于拒绝已知冲突；缺可验证身份时标 `unverified`。NA 排除计数、GMT 字节 hash、集合原始/交集规模、完整结果路径/行数/hash 随结果返回。零有效集合产出空表并标 `no_effective_sets`。触发词：GSEA、富集。

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
| "找个现成的 CRISPR 质粒 / 有没有人做过" | `bio_plasmid_search` → `bio_plasmid_info` |
| "这个质粒的抗性/拷贝数/启动子" | `bio_plasmid_info plasmid_id=52961` |
| "这个蛋白的功能/PTM/结构/通路" | `bio_uniprot`（mode 切换；PTM 用 mode=ptm） |
| "这个基因的内含子外显子/剪接位点" | `bio_seq_introns`（需 NG_/NC_ 登录号） |
| "两棵进化树是否一致" | `bio_phylo_compare`（RF 距离） |
| "看序列有没有重复/重排" | `bio_seq_dotplot` |
| "这条 RNA 的二级结构/稳不稳" | `bio_rna_fold` |
| "报告里的登录号/序列是不是真的" | `bio_source_audit`（先 scan 抽候选 → identifiers/sequences 核验） |
| "单细胞数据质控/过滤低质量细胞" | `bio_sc_qc` |
| "这组数据怎么画/画成论文图" | `bio_fig_profile` → bio_python 画 → `bio_fig_export` 审计 |
| "中文图会不会出方框" | `bio_fig_qa` |
| "图配色/投稿自查" | 画完 → `bio_fig_lint`（红绿对/rainbow/灰度/统计元数据自检） |
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

**bio_ml_pipeline** — 通用 ML 管道：`path`★、`target`★、`task`（classification/regression）、`model`（random_forest/svm/logistic/linear）、`seed`、`group_col`（患者/组隔离）、`exclude_cols`（样本/患者 ID 等明确排除列）、`test_size`、`cv`（0 关闭或至少 2）。先划分，再由 Pipeline 在每折独立拟合；CV 仅训练集，holdout 最后一次评估。分类不可分层、组/训练类不足与折失败返回不可评估，不输出伪独立 accuracy。返回真实索引、特征列表、变换后维度及指标。触发词：机器学习、训练、分类、回归。

**bio_ml_reduce** — 降维分析：`path`★（CSV）、`method`（pca/tsne）、`n_components`（默认 2）。返回降维坐标 + 方差解释率。触发词：PCA、t-SNE、降维。

**bio_ml_cluster** — 聚类分析：`path`★（CSV）、`method`（kmeans/hierarchical）、`n_clusters`（默认 3）。返回聚类标签 + 轮廓系数。触发词：聚类、K-Means。

**bio_ml_feature** — 特征重要性：`path`★（CSV）、`target`★（目标列）、`top`（默认 10）。返回特征排序 + 相关性矩阵。触发词：特征选择、变量筛选。

**bio_stats_test** — 统计检验：`path`★（CSV）、`group_col`★、`value_col`★、`test_type`（auto/ttest/mannwhitney/anova/chi2）。返回 p 值 + 效应量。触发词：t 检验、ANOVA、显著性。

**bio_primer_design** — PCR 引物设计：`sequence`★（模板序列）、`product_size`（默认 500）、`tm_target`（默认 60）、`top_n`（默认 5）、`tm_diff_max`（默认 5）。返回正/反向引物对（每个候选含 `quality`=good/ok/poor 与 `issues` 说明；`fwd_position`/`rev_position` 为 **0-based 切片索引**；无满意候选时返回 `advice` 调整建议）。触发词：引物、PCR、Tm。

**bio_seq_optimize** — 密码子优化：`sequence`★（CDS）、`organism`（ecoli/human/yeast）。返回优化序列 + GC%。触发词：密码子优化、表达优化。

**bio_assembly_design** — 组装策略：`fragments`★（DNA 片段列表，含载体共需 ≥2 个）、`vector`（可选线性化载体序列，**会被并入片段列表**——只有单个插入片段时传它即可，无需自己拼接）、`method`（auto/gibson/golden_gate/restriction）。返回组装方案 + 接头设计 + `next_step`（提示用 bio_clone_simulate 做环化组装模拟）。触发词：组装、Gibson、Golden Gate。

**bio_plasmid_map** — 质粒图谱：`name`、`size`、`features`★（特征列表）。传 `genbank_file` 或 `features`+`sequence` 时输出 PNG/SVG 图形文件（dna-features-viewer，`output_format`/`out_file`/`figure_width`/`highlight_regions` 可控），返回 `mode=graphic` + `output_file`（绝对路径）；**仅传 features 时只有文本注释图（`mode=text`，`output_file=null`，不生成文件）**。触发词：质粒图、载体图谱、plasmid map。

### 合成生物学（Phase 1）

**bio_crispr_guide** — CRISPR 向导 RNA 设计：`sequence ★`（靶序列）、`cas`（Cas 变体）、`gc_min`/`gc_max`（GC% 区间）、`max_offtargets`、`max_mismatches`、`top_n`。返回候选 gRNA 列表（GC%/脱靶风险评分排序）。触发词：CRISPR、gRNA、向导 RNA、基因编辑。

**bio_crispr_verify** — CRISPR 编辑验证：`wild_type ★`（编辑前序列）、`edited ★`（编辑后序列）。返回比对长度/一致性/编辑摘要/突变清单/编辑效率估计。触发词：编辑验证、敲入敲除确认、测序结果核对。

**bio_dna_syncheck** — DNA 合成可行性检查：`sequence ★`、`min_gc_window`/`max_gc_window`（窗口 GC 上下限）、`homopolymer_threshold`、`poly_run_min`。返回不可合成区域/需改序位点。触发词：合成可行性、gene synthesis、合成难度。

**bio_wetlab_design** — 湿实验方案生成：`protocol_type ★`（pcr_amplification / gibson_assembly / golden_gate / restriction_cloning / crispr_editing / strain_construction / transformation）、`input_data ★`（上游工具输出的 **dict 对象**，如 bio_primer3_design / bio_clone_simulate 的返回）、`host_organism`、`scale`（small/medium/large）。返回完整 protocol（试剂体系/反应条件/QC）。选型前提：`strain_construction` 仅用于敲除增产场景，`input_data` 须含 knockouts/recommended_knockouts（来自 optknock），否则返回 guidance 引导；非敲除场景（过表达/异源表达）用 `transformation` 或 `crispr_editing`。触发词：实验方案、protocol、湿实验步骤。

**bio_primer3_design** — 工业级引物设计（Primer3）：`sequence ★`、`target_region [start,len]`（**要扩增的区间**：引物落在区间内，产物长度自动约束为≈区间长度）、`must_include [start,len]`（产物必须包含的内部区域：引物不得进入该区，**不可触及序列端点**）、`primer_size`/`tm_range`/`gc_range`、`max_hairpin_tm`/`max_self_any_tm`、`num_return`（默认 5）。返回候选引物对（Tm/GC%/发夹/二聚体评分 + penalty 排序，rank 1 推荐；`position` 为 **0-based** Primer3 约定）。**扩增全长**用 `target_region=[0, 序列长度]` 或直接省略。`n_returned=0` 时返回结构化诊断（`explain_raw` 的 Primer3 原因 + `effective_constraints` 实际生效约束），按其指引调整一次即可，不要盲目逐项放宽参数。与 bio_primer_design（简单版）区分：需要可投稿级引物质量时用本工具。触发词：Primer3、工业级引物、qPCR 引物。依赖说明：primer3-py 属第二层按需依赖（auto），首次调用本工具时运行时自动补装，无需手动操作。

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

### 宿主侧设计工具（design 通道，B1-part-1）

**bio_chassis_profile** — 宿主底盘档案：`genome_files ★`（[{path, format}]，至少一个 fasta；gff3/genbank/segments_tsv 可选）、`coord_convention ★`（0-based-half-open / 1-based-inclusive，必须显式声明）、`contig_topology`、`condition`、`parts_evidence_file`、`casefile_dir`。返回 genome_ref@1 + host_profile@1（GC/密码子/contig 统计 + 证据完整度状态）；不含 GEM growth 锚点、不声明产品档位。门禁：HASH_FAILED / COORD_CONVENTION_UNDECLARED / DUPLICATE_CONTIG_NAME → BLOCKED。触发词：底盘档案、宿主画像、chassis profile。

**bio_integration_candidates** — 基因组整合位点候选：`host_profile`（或 `host_profile_ref`）+ `genome_files ★` + `cassette ★`（序列或长度）+ `candidates`/`scan` + `top_n`（≤16）。按正式 integration-ruleset 逐条强制评估（unknown_policy=block，绝不输出 safe）；无注释/注释不可信 → NOT_RUN；缺 ruleset → BLOCKED。触发词：整合位点、插入候选、integration site。

**bio_circuit_contextualize** — 回路表达情景化：`circuit ★`（components[] 或 sbol_file）+ `host_profile` + `coupling_mode`（仅产耦合草案，不可定量授权）+ `parts_evidence`。返回 expression_scenario@1（元件证据查表排名；无证据只给 rank + risk，禁绝对表达）+ 可选 kinetic_crn_ref@1（封装既有 bio_circuit_compile 输出）。ostir 不可用 → DEPENDENCY_UNAVAILABLE。触发词：表达情景、元件排名、耦合草案。

**design_consequence** — 耦合后果推理（design 通道）：`model_ref ★`（sbml + card）、`coupling_profile ★`、`medium`（必填，不支持默认富培养基）、`objective`（默认 biomass）、`scenarios[]`、`casefile_dir`（可选）、`strict`（默认 true）。返回 consequences@1（scenario → growth 方向预测与置信区间）+ design envelope（status/reason_code/artifact_refs/detail）。门禁拒绝 → BLOCKED；规则全 miss → NOT_RUN（禁猜映射）。触发词：设计后果、consequence、耦合后果推理、growth 方向预测。

**design_casefile_validate** — casefile 红线校验（design 通道）：`casefile_dir ★`（工作区内）。返回 checks[8]（SNAPSHOT_BINDING / MANIFEST_COMPLETE / MANIFEST_DISK_HASH / SCHEMA / R1 / R2 / R3 / DAG_ACYCLIC），全 PASS 才放行导出。触发词：案例包校验、红线检查、validate casefile。

### 修复管道（Repair Proposal v0）

**bio_repair_capture** — 登记一条**脱敏**的疑似插件问题观察（v0 受控修复事件管道）：`token ★`（bio_python 失败结果中的 `repair_observation_token`，短命一次性）。**只接受 token**——不接收原始日志/代码/路径/序列；产物为 OBSERVED incident（attribution=UNVERIFIED，不是插件 bug 认定）。触发词：登记观察、疑似插件问题、repair capture。

**bio_repair_status** — 只读状态：模式（proposal-only）、incident/receipt/lesson 计数、状态分布、最近条目（脱敏摘要）、完整性速览与 legacy 计数。触发词：repair 状态、修复管道、incident 列表。

**bio_repair_ledger_verify** — 离线台账完整性校验：逐条核对 sidecar 哈希/可读性/文件名规范，返回问题清单（无原始内容）。触发词：台账校验、ledger verify、完整性检查。

> 无 propose/verify/apply 工具（不提供编辑、执行、发布能力）；设计与边界见仓库 `docs/repair-proposal-v0.md`。`repairMode: 'off'` 可整体关闭本管道。

**design_casefile_export** — casefile 归档导出（design 通道）：`casefile_dir ★` + `format`（zip/report/both，默认 both）+ `audit_view_id` + `expected_parent_snapshot_sha`。对未收口快照执行确定性 report-finalize 事务（S_n → 含 report.md 的 S_(n+1)）→ 精确 validate → 导出；产物落 `exports/<snap12>/`，不入科学快照；纯导出要求目标快照恰含 1 个终态化报告，否则 INVALID_INPUT/REPORT_FINALIZE_REQUIRED。触发词：导出案例包、最终报告、归档 bundle。
