---
language: r
---

# R 差异表达分析（DESeq2 / edgeR / limma）

> 来源：DESeq2 / edgeR / limma 官方 vignette。差异表达是 R/Bioconductor 的**权威主场**。

## 选择哪个包

| 场景 | 包 | 模型 |
|---|---|---|
| 有生物学重复（每组 n≥2），RNA-seq counts | **DESeq2**（默认首选） | 负二项 + shrinkage |
| 每组 n=1（无重复，谨慎下结论） | edgeR exactTest | 负二项 |
| 微阵列/limma-voom 流程 | limma | 线性模型 |
| 多时间点/多因素/交互作用 | DESeq2（design 公式灵活） | 广义线性模型 |

## DESeq2 标准管道（两组比较）

```r
suppressPackageStartupMessages({
  library(DESeq2); library(readr); library(dplyr)
})

# 输入：counts.csv（整数矩阵）+ meta.csv（sample, condition）
# ⚠️ as.matrix() 对含字符列的 data.frame 会全部转字符！
#    必须先 column_to_rownames 移除基因列再转矩阵。
counts <- read_csv("counts.csv", show_col_types = FALSE) %>%
  tibble::column_to_rownames("gene") %>% as.matrix()
meta <- read_csv("meta.csv", show_col_types = FALSE)
counts <- counts[, meta$sample]                      # 对齐列序
meta$condition <- factor(meta$condition, levels = c("ctrl", "trt"))

dds <- DESeqDataSetFromMatrix(countData = counts, colData = meta, design = ~ condition)
dds <- DESeq(dds)
res <- lfcShrink(dds, coef = resultsNames(dds)[2], type = "normal")
out <- as.data.frame(res) %>% tibble::rownames_to_column("gene") %>% arrange(padj)
readr::write_csv(out, "de_results.csv")

sig <- filter(out, padj < 0.05 & abs(log2FoldChange) > 1)
result <- list(
  n_genes = nrow(out),
  n_up = sum(sig$log2FoldChange > 0),
  n_down = sum(sig$log2FoldChange < 0),
  top = head(select(out, gene, baseMean, log2FoldChange, padj), 10),
  out_file = "de_results.csv")
```

## 多因素设计（如 condition + batch）

```r
# design 公式用 + 连接因素；主效应模型
meta$batch <- factor(meta$batch)
dds <- DESeqDataSetFromMatrix(counts, meta, design = ~ batch + condition)
dds <- DESeq(dds)
# 提取 condition 效应（排除 batch 影响）
res <- results(dds, contrast = c("condition", "trt", "ctrl"))
```

## 交互作用模型（如 drug × genotype）

```r
# design 含交互项：检测 drug 效应是否依赖 genotype
dds <- DESeqDataSetFromMatrix(counts, meta, design = ~ genotype + treatment + genotype:treatment)
dds <- DESeq(dds)
# 提取交互作用
resultsNames(dds)
res_interaction <- results(dds, name = "genotypemut.treatmentdrug")
```

## 时间序列分析（多时间点）

```r
# 时间作为有序因子 + LRT 检验整体差异
meta$time <- factor(meta$time, levels = c("0h", "6h", "12h", "24h"), ordered = TRUE)
dds <- DESeqDataSetFromMatrix(counts, meta, design = ~ time)
dds <- DESeq(dds, test = "LRT", reduced = ~ 1)  # LRT 检验时间效应
res <- results(dds)
# 逐时间点比较（vs 0h）
res_6h <- results(dds, contrast = c("time", "6h", "0h"))
```

## 火山图（ggplot2）

```r
library(ggplot2)
out$significance <- ifelse(out$padj < 0.05 & out$log2FoldChange > 1, "Up",
                    ifelse(out$padj < 0.05 & out$log2FoldChange < -1, "Down", "NS"))
ggplot(out, aes(log2FoldChange, -log10(padj), color = significance)) +
  geom_point(alpha = 0.6, size = 1.5) +
  scale_color_manual(values = c("Up" = "#e74c3c", "Down" = "#3498db", "NS" = "grey60")) +
  geom_vline(xintercept = c(-1, 1), linetype = "dashed", alpha = 0.5) +
  geom_hline(yintercept = -log10(0.05), linetype = "dashed", alpha = 0.5) +
  labs(x = "log2 Fold Change", y = "-log10 adjusted p-value", title = "Volcano Plot") +
  theme_minimal()
ggsave("volcano.pdf", width = 7, height = 5)
```

## MA 图

```r
ggplot(out, aes(log10(baseMean), log2FoldChange, color = significance)) +
  geom_point(alpha = 0.5, size = 1) +
  scale_color_manual(values = c("Up" = "#e74c3c", "Down" = "#3498db", "NS" = "grey60")) +
  geom_hline(yintercept = 0, linetype = "dashed") +
  labs(x = "log10 mean expression", y = "log2 fold change", title = "MA Plot") +
  theme_minimal()
ggsave("ma.pdf", width = 7, height = 5)
```

## 结果解读纪律

- 显著阈值：**padj < 0.05 且 |log2FC| > 1**（双标准；只按 padj 会报出大量生物学无意义的小变化）。
- padj 是 BH-FDR 校正值——别拿 pvalue 讲故事。
- `lfcShrink` 的 log2FoldChange 才是可靠的效应量；未收缩的原始 log2FC 在小样本下被高估。
- `baseMean` = 归一化平均表达；过滤低表达（baseMean < 10）可减少多重校正负担。
- 样本量 < 3/组时结论明确标注"探索性"。

## edgeR 快速路径（无重复/大样本）

```r
library(edgeR)
y <- DGEList(counts = counts, group = meta$condition)
keep <- filterByExpr(y)
y <- y[keep, , keep.lib.sizes = FALSE]
y <- calcNormFactors(y)               # TMM 归一化
y <- estimateDisp(y)                  # 有重复
et <- exactTest(y)
top <- topTags(et, n = Inf)$table     # logFC / logCPM / PValue / FDR
```

## 下游衔接

1. 显著基因列表 → `bio_enrichr`（Python，ORA）或 bio-proto-r-gsea（排序数据 GSEA）。
2. 火山图/MA 图 → 本模板 ggplot2 或 Python figurelib（出版级）。
3. 输出 CSV 用绝对路径写工作区，报告文件路径 + 关键数字。

## 高频坑

- counts 必须是**整数矩阵**（小数 = 输入错误，DESeq2 直接报错）。
- `condition` 列必须是 factor；对照组的参考水平用 `relevel(factor, ref = "ctrl")` 控制。
- 设计公式里数字型协变量要 `scale()`，否则对比解释混乱。
- rownames 是基因 ID；`as.data.frame(res)` 丢 rownames 时用 `rownames_to_column`。
- 首次加载 DESeq2 慢（~10s）：bio_r 默认超时 120s 够用，若叠加重分析传大 timeoutMs。
- 多因素设计的 `resultsNames(dds)` 可能包含 `Intercept`、`batch_b_vs_a`、`condition_trt_vs_ctrl` 等——用 `name` 参数精确指定要提取的系数。
