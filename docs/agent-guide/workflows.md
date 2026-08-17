---
language: python
---

# 端到端工作流（10 个场景）

> 每个场景：用户愿望 → 工具调用序列 → 产出 → 注意点。命中场景按序列执行，不要跳步、不要发明步骤。

## 1. 序列质控与特征统计

愿望："分析这个文件里所有序列的长度、GC 含量，标记低质量序列。"

```
bio_seq_io_read path="D:/data/genes.fasta" limit=200        # 先看有多少条
→ 若条数少（<50）：逐条 bio_seq_analyze
→ 若条数多：bio_python 批量统计（模板见 bio-proto-seq-qc）
产出：汇总表（id | 长度 | GC% | N 比例）+ 低质量序列清单 + 文件路径
```

## 2. 组合分析（GC + ORF + 酶切）

愿望："这条序列的 GC、最长 ORF、EcoRI 位点都查一下。"

```
bio_seq_analyze sequence="..."          # GC + 六框翻译
bio_seq_find_orf sequence="..."         # 最长 ORF（注意默认 min_len=30nt）
bio_seq_restriction sequence="..." enzymes=["EcoRI","BamHI"]  # 酶切位点
产出：三项结果汇总 + 生物学解读（ORF 是否完整、酶切产物片段预测）
```

## 3. 远程 BLAST 注释

愿望："这段未知序列是什么物种的什么基因？"

```
加载 bio-proto-blast-remote（含 qblast 模板与 E-value 解读）
bio_python：Bio.Blast.NCBIWWW.qblast 提交 → 解析前 10 个 hit
产出：hit 表（accession | identity | E-value | 物种/基因名）
注意：qblast 是网络提交，等待时间数秒~分钟；E-value < 1e-10 才可信
```

## 4. 基因信息查询

愿望："查 TP53 的基本信息。"

```
bio_entrez_search term="TP53[Gene Name] AND human[Organism]" db="gene" retmax=3 email="..."
产出：基因名/染色体位置 17p13.1/别名/功能摘要
进阶：bio_entrez_fetch ids=["NM_000546"] 取 mRNA 序列 → bio_seq_translate 验证 CDS
```

## 5. 通路富集分析

愿望："这组差异表达基因富集到哪些通路？"

```
bio_enrichr genes=["TP53","BRCA1",...] library="GO_Biological_Process_2023" top=10
bio_enrichr genes=[同列表] library="KEGG_2021_Human" top=10
bio_enrichr genes=[同列表] library="Reactome_2022" top=10      # 可选交叉
加载 bio-proto-enrichment-workflow 做解读
产出：按 adjusted_p_value 排序的表 + 功能主题归并（DNA 修复/细胞周期…）
注意：GO 与 KEGG p 值不可互相比较；冗余 term 按基因重叠>70% 去重
```

## 6. 文献调研

愿望："CRISPR prime editing 近年综述。"

```
bio_pubmed_search term='"prime editing"[Title/Abstract] AND review[Publication Type] AND 2023:2026[dp]' retmax=30
bio_pubmed_abstract ids=[挑出的 PMID]          # 一次 ≤30 个
（可选）bio_python 用 OpenAlex REST 补预印本/引用量（模板见 bio-proto-literature-review）
产出：表格 PMID | 年份 | 期刊 | 核心发现一句话；引用必须带 PMID/DOI
```

## 7. 系统发育树

愿望："这 20 条 16S 序列的亲缘关系。"

```
bio_seq_io_read path="16s.fasta" limit=20
加载 bio-proto-phylo-nj（距离矩阵 + NJ/UPGMA 模板）
bio_python：ClustalOmega/PairwiseAligner 做 MSA → DistanceCalculator → NJ 建树 → 写 .nwk
产出：树文件（Newick）+ 关键分组结论
注意：插件不内置 MAFFT/IQ-TREE（外部二进制）——如实说明用 Bio.Phylo 近似法
```

## 8. 蛋白结构分析

愿望："分析这个 PDB 里活性位点残基间的距离。"

```
（用户提供或 bio_python 下载 PDB 文件）
加载 bio-proto-pdb-analysis（距离/RMSD 模板）
bio_python：Bio.PDB 解析 → 残基对距离计算 → 输出距离矩阵
产出：距离表 + 结构解读；DSSP/ResidueDepth 等外部程序不在环境内（如实说明）
```

## 9. 出版级绘图（完整闭环）

愿望："把这组表达数据画成论文级箱线图（Nature 单栏）。"

```
bio_fig_qa lang="zh"                        # 中文图先查字体
bio_fig_profile path="expr.csv" group_cols=["group"]   # 剖析+图型建议+风险
加载 bio-figure（决策）+ bio-proto-pub-figure（配方）
bio_python：setup_style(journal='nature') → 箱线+stripplot → audit_layout → export_figure
bio_fig_export paths=["figs/fig1.pdf","figs/fig1.png"] min_dpi=300 width_in=3.5 height_in=2.625
→ FAIL 就回改重导，直到 PASS/WARN 合理
产出：PDF/SVG/PNG + 灰度预览 + 审计结论
```

## 10. 统计检验

愿望："两组数据的差异显著吗？"

```
加载 bio-proto-statistics（检验选择树）
bio_python：scipy 检验（ttest_ind/mannwhitneyu）+ 效应量（Cohen's d）+ 校正
产出：检验名 + 统计量 + p 值 + 效应量 + 置信区间 + APA 风格一句话结论
注意：多重比较必须校正（BH-FDR/Bonferroni）；p 值不二分解读
```

## 通用纪律

- 每个场景第一步先想：**语义化工具能覆盖吗**（能就别写代码）。
- 文件路径一律绝对路径；产出文件报告完整路径。
- 网络步骤（BLAST/Entrez/Enrichr）失败时：一次重试 → 仍失败如实报告（限流/网络），不无限重试。
- 每个场景结尾：**生物学解读**一段（结论 + 证据出处 + 局限）。
