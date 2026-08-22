---
name: bio-proto-r-de
domain: transcriptomics
inputs: [counts 矩阵 CSV + 样本分组表]
outputs: [差异表达结果表 CSV + 火山图 + 富集分析]
requires_network: false
language: r
---

# R 差异表达工作流协议（DESeq2）

**适用场景**：用户有 RNA-seq 定量后的 counts 矩阵和分组信息，要"哪些基因差异表达"。

## 输入约定

- `counts.csv`：整数矩阵；第一列基因 ID，其余列每样本 counts；列名 = 样本名。
- `meta.csv`：至少两列 `sample, condition`；condition 取值如 ctrl/trt。
- 用文件系统工具先确认两文件列名对齐（样本集合一致）。

## 工具调用序列

```
bio_r（code = 下方模板，timeoutMs = 180000）
```

## 代码模板

```r
suppressPackageStartupMessages({
  library(DESeq2); library(readr); library(dplyr); library(ggplot2)
})

# ===== 1. 读取数据 =====
counts <- read_csv("counts.csv", show_col_types = FALSE) %>%
  tibble::column_to_rownames("gene") %>% as.matrix()
meta <- read_csv("meta.csv", show_col_types = FALSE)

# 对齐列序
counts <- counts[, meta$sample]
meta$condition <- factor(meta$condition, levels = c("ctrl", "trt"))

# ===== 2. DESeq2 分析 =====
dds <- DESeqDataSetFromMatrix(countData = counts, colData = meta, design = ~ condition)
dds <- DESeq(dds)
res <- lfcShrink(dds, coef = resultsNames(dds)[2], type = "normal")

out <- as.data.frame(res) %>%
  tibble::rownames_to_column("gene") %>%
  arrange(padj)

# ===== 3. 筛选显著基因 =====
sig <- filter(out, padj < 0.05 & abs(log2FoldChange) > 1)

# ===== 4. 保存结果 =====
readr::write_csv(out, "de_results.csv")
readr::write_csv(sig, "de_significant.csv")

# ===== 5. 火山图 =====
out$significance <- ifelse(out$padj < 0.05 & out$log2FoldChange > 1, "Up",
                    ifelse(out$padj < 0.05 & out$log2FoldChange < -1, "Down", "NS"))
p <- ggplot(out, aes(log2FoldChange, -log10(padj), color = significance)) +
  geom_point(alpha = 0.6, size = 1.5) +
  scale_color_manual(values = c("Up" = "#e74c3c", "Down" = "#3498db", "NS" = "grey60")) +
  geom_vline(xintercept = c(-1, 1), linetype = "dashed", alpha = 0.5) +
  geom_hline(yintercept = -log10(0.05), linetype = "dashed", alpha = 0.5) +
  labs(x = "log2 Fold Change", y = "-log10 adjusted p-value",
       title = paste("Volcano Plot:", nrow(sig), "DEGs")) +
  theme_minimal()
ggsave("volcano.pdf", p, width = 7, height = 5)

# ===== 6. 返回结构化结果 =====
result <- list(
  n_genes = nrow(out),
  n_sig = nrow(sig),
  n_up = sum(sig$log2FoldChange > 0),
  n_down = sum(sig$log2FoldChange < 0),
  top_genes = head(select(sig, gene, log2FoldChange, padj), 10),
  output_files = list(
    all_results = "de_results.csv",
    significant = "de_significant.csv",
    volcano_plot = "volcano.pdf"
  ))
```

## 后续步骤

1. **富集分析**：显著基因列表 → `bio_enrichr`（Python）或 GSEA 排序列表 → `bio_r` fgsea。
2. **热图**：top 50 显著基因的表达热图 → `bio_r` ComplexHeatmap。
3. **报告**：n 上下调基因数 + 阈值声明 + top10 表 + 火山图 + 富集主题。

## 常见坑

- counts 有小数/非整数 → DESeq2 报错：先查输入。
- 样本名不匹配 → 显式 `counts[, meta$sample]` 对齐。
- 单因素两水平用 `resultsNames(dds)[2]`；多水平用 `contrast = c("condition","trt","ctrl")`。
- 无生物学重复 → 换 edgeR exactTest，结论标探索性。
- 首次运行环境若未引导会先下载 R + 包（约 5-20 分钟）。
