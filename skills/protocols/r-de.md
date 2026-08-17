---
name: bio-proto-r-de
domain: transcriptomics
inputs: [counts 矩阵 CSV + 样本分组表]
outputs: [差异表达结果表 CSV + 显著基因统计 + 火山图]
requires_network: false
language: r
---

# R 差异表达工作流协议（DESeq2）

**适用场景**：用户有 RNA-seq 定量后的 counts 矩阵（行=基因、列=样本）和分组信息，要"哪些基因差异表达"。

## 输入约定（先检查再跑）

- `counts.csv`：整数矩阵；第一列基因 ID，其余列每样本 counts；列名 = 样本名。
- `meta.csv`：至少两列 `sample, condition`；condition 取值如 ctrl/trt。
- 用文件系统工具先确认两文件列名对齐（样本集合一致）；不一致先报告用户，不要硬跑。

## 工具调用序列

```r
bio_r（code = 下方模板，timeoutMs = 180000）
```

### 代码模板（写入 bio_r 的 code 参数）

**坑**：`as.matrix()` 对含字符列的 data.frame 会将全部列转为字符！
**正确做法**：先用 `column_to_rownames` 移除基因列，再 `as.matrix`。

```r
suppressPackageStartupMessages({
  library(DESeq2); library(readr); library(dplyr)
})
counts <- read_csv("counts.csv", show_col_types = FALSE) %>%
  tibble::column_to_rownames("gene") %>% as.matrix()
meta <- read_csv("meta.csv", show_col_types = FALSE)
counts <- counts[, meta$sample]                      # 对齐列序
meta$condition <- factor(meta$condition, levels = c("ctrl", "trt"))

dds <- DESeqDataSetFromMatrix(countData = counts, colData = meta, design = ~ condition)
dds <- DESeq(dds)
# type = "normal" 无需额外包；apeglm 结果更好但需安装 apeglm（不在核心集）
res <- lfcShrink(dds, coef = resultsNames(dds)[2], type = "normal")
out <- as.data.frame(res) %>% tibble::rownames_to_column("gene") %>% arrange(padj)
readr::write_csv(out, "de_results.csv")

sig <- filter(out, padj < 0.05 & abs(log2FoldChange) > 1)
result <- list(
  n_genes = nrow(out),
  n_up = sum(sig$log2FoldChange > 0), n_down = sum(sig$log2FoldChange < 0),
  top = head(select(out, gene, baseMean, log2FoldChange, padj), 10),
  out_file = "de_results.csv")
```

## 后续步骤

1. **火山图**：bio_r + ggplot2（见 bio-r-vis），或 Python figurelib 出版级出图。
2. **富集**：显著基因列表 → `bio_enrichr`（ORA）；全表排序 → bio-proto-r-gsea（GSEA）。
3. **报告**：n 上下调基因数 + 阈值声明（padj<0.05 & |log2FC|>1）+ top10 表 + 富集主题。

## 常见坑

- counts 有小数/非整数 → DESeq2 报错：先查输入（上游归一化矩阵不是 counts）。
- 样本名不匹配 → 显式 `counts[, meta$sample]` 对齐；报错 "not all colData rows present" 即此因。
- 单因素两水平用 `resultsNames(dds)[2]`；多水平/多因素用 `contrast = c("condition","trt","ctrl")`。
- 无生物学重复（每组 n=1）→ 换 edgeR exactTest（见 bio-r-rnaseq），结论标探索性。
- 首次运行环境若未引导会先下载 R + 包（约 5-20 分钟）——提前告知用户，不要重复调用。
