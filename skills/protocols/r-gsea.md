---
name: bio-proto-r-gsea
domain: functional-analysis
inputs: [排序基因列表 CSV（gene+stat）+ GMT 基因集文件]
outputs: [GSEA 结果表 CSV + 显著通路解读]
requires_network: false
language: r
---

# R GSEA 排序富集工作流协议（fgsea）

**适用场景**：用户有全基因组**排序**数据（如差异表达分析的 log2FC 全表），想知道"哪些通路整体上调/下调"——注意与 ORA 的区别：输入不是截断列表而是带方向的排序。

## 输入约定

- `rank.csv`：两列 `gene, stat`；stat 用 log2FC 或 t 值（**带方向**，正=上调）。
- `*.gmt`：MSigDB 基因集文件（用户从 https://www.gsea-msigdb.org 下载放入工作区；h.all / c2.cp / c5 按需选）。
- 若用户只有显著基因列表没有排序 → 用 `bio_enrichr`（ORA），不要硬做 GSEA。

## 工具调用序列

```r
bio_r（code = 下方模板，timeoutMs = 180000）
```

### 代码模板（写入 bio_r 的 code 参数）

```r
suppressPackageStartupMessages({
  library(fgsea); library(readr); library(dplyr)
})
rank_df <- read_csv("rank.csv", show_col_types = FALSE)
ranks <- setNames(rank_df$stat, rank_df$gene)
ranks <- ranks[!is.na(ranks) & !duplicated(names(ranks))]
ranks <- sort(ranks, decreasing = TRUE)

pathways <- fgsea::gmtPathways(list.files(pattern = "\\.gmt$")[1])
fg <- fgsea(pathways = pathways, stats = ranks,
            minSize = 15, maxSize = 500, nPermSimple = 10000) %>% arrange(pval)
out <- as.data.frame(fg) %>% select(-leadingEdge)   # leadingEdge 是 list，单独处理
readr::write_csv(out, "gsea_results.csv")

sig <- filter(fg, padj < 0.25)
result <- list(
  n_pathways = nrow(fg),
  n_sig_up = sum(sig$NES > 0), n_sig_down = sum(sig$NES < 0),
  top = head(select(sig, pathway, pval, padj, NES, size), 10),
  out_file = "gsea_results.csv")
```

## 解读要点（接 bio-r-enrichment 的解读纪律）

- 阈值：**padj < 0.25**（GSEA 惯例，与 ORA 的 0.05 不同，报告时明确）。
- NES 正负 = 通路在排序中偏上/下调；leadingEdge 基因点名解读。
- 冗余：相似通路簇按 NES 绝对值最大者代表（同 enrichment-workflow 的冗余消除原则）。

## 常见坑

- ranks 有重复基因名或 NA → 先清理，否则 fgsea 报错或结果不可信。
- GMT 文件路径：工作区相对路径直接 `list.files(pattern="\\.gmt$")` 取第一个，或绝对路径传入。
- nPermSimple=10000 是速度/精度平衡；基因集数 > 5000 时用 `nPermSimple = 1000` 先跑通。
- stat 用 p 值（无方向）做 ranks 是错的——GSEA 需要有方向的统计量。
