---
language: r
---

# R 富集与 GSEA（fgsea）

> 来源：fgsea 官方 vignette（原创整理）。**分工原则**：基因列表（阈值截断）→ 用 Python `bio_enrichr`（更快、已内置限流缓存）；**排序数据（全基因组 log2FC 等）→ 用本 skill 的 fgsea**——GSEA 不丢信息、能检出整体弱趋势，是 Python 侧缺失的能力。

## 边界（诚实告知）

- **clusterProfiler 不可用**：其依赖 GO.db 在 Bioc 3.23 无 Windows 二进制（上游缺口），
  Windows 下装不上（enrichGO/gseGO 一并不可用）。R 侧富集引擎 = **fgsea**（排序 GSEA）；
  基因列表 ORA 一律走 Python `bio_enrichr`（内置 GO/KEGG/Reactome 库，更快）。
- 核心包集也**不含** org.Hs.eg.db / org.Mm.eg.db（物种注释库，体积大）。
- fgsea 需要**用户提供基因集**（GMT 风格 data.frame 或 MSigDB GMT 文件）——MSigDB 的
  GMT 文件可从官网下载到工作区后读入。

## fgsea 标准管道（排序 GSEA）

```r
suppressPackageStartupMessages({
  library(fgsea)
  library(dplyr)
  library(readr)
})

# 输入 1：排序列表 rank.csv（gene, stat）——stat 用 log2FC 或 t 统计量（有方向！）
rank_df <- read_csv("rank.csv", show_col_types = FALSE)
ranks <- setNames(rank_df$stat, rank_df$gene)
ranks <- sort(ranks, decreasing = TRUE)          # 降序，去掉 NA/重复
ranks <- ranks[!is.na(ranks)]

# 输入 2：基因集 GMT 文件（MSigDB 官方下载）
pathways <- fgsea::gmtPathways("h.all.v2024.1.Hs.symbols.gmt")

# 核心步骤
fgsea_res <- fgsea(pathways = pathways, stats = ranks,
                   minSize = 15, maxSize = 500, nPermSimple = 10000)
fgsea_res <- arrange(fgsea_res, pval)
result <- list(n_pathways = nrow(fgsea_res),
               top = head(select(fgsea_res, pathway, pval, padj, NES, size, leadingEdge), 8))

# 显著结果落盘
sig <- filter(fgsea_res, padj < 0.25)            # GSEA 惯例：padj<0.25 即可报告
write_csv(as.data.frame(sig), "gsea_results.csv")
```

## 结果解读纪律

- **NES**（normalized enrichment score）：正 = 上调富集，负 = 下调富集；|NES| 大小与显著性分开看。
- GSEA 惯例阈值 **padj < 0.25**（不同于 ORA 的 0.05）——报告时说明用的是 GSEA 阈值。
- `leadingEdge`：核心贡献基因——写解读时点名这些基因让结论可验证。
- minSize/maxSize 过滤过小/过大的基因集（默认 15/500 合理）。
- 重复基因名、NA stat 必须先清（`ranks[!duplicated(names(ranks))]`）。

## 边界内替代：ORA 一律走 Python bio_enrichr（clusterProfiler 不可用）

列表型富集不写 R 代码——直接用 `bio_enrichr genes=[...]`（GO/KEGG/Reactome 库已内置、
插件限流缓存，比 R 侧更快）。排序型 GSEA 用上文 fgsea 管道。两侧结果交叉验证即可。

## 与 Python 侧的协作模式

| 数据形态 | 路线 |
|---|---|
| 显著基因列表（几十~几百个） | `bio_enrichr`（GO/KEGG/Reactome，内置库）——R 侧无 ORA 引擎 |
| 全基因组排序（log2FC） | 本 skill：fgsea + 用户 GMT |
| 两者都要 + 交叉验证 | 列表→bio_enrichr；排序→fgsea；结论互相印证 |
| 富集结果解读/冗余消除 | bio-proto-enrichment-workflow（Python 协议，语言无关方法论） |
