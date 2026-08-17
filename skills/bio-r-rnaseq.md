---
language: r
---

# R 差异表达分析（DESeq2 / edgeR / limma）

> 来源：DESeq2 / edgeR / limma 官方 vignette（原创整理）。差异表达是 R/Bioconductor 的**权威主场**——这是本插件引入 R 引擎的首要价值（Python 侧无内置等效）。

## 选择哪个包

| 场景 | 包 | 模型 |
|---|---|---|
| 有生物学重复（每组 n≥2），RNA-seq counts | **DESeq2**（默认首选） | 负二项 + shrinkage |
| 每组 n=1（无重复，谨慎下结论） | edgeR exactTest（estimateDisp 设合理值） | 负二项 |
| 微阵列/limma-voom 流程 | limma | 线性模型 |

## DESeq2 标准管道（对象模型，照此顺序）

```r
suppressPackageStartupMessages({
  library(DESeq2)
  library(readr)
  library(dplyr)
})

# 输入：counts.csv（整数矩阵，行=基因，列=样本）+ meta.csv（sample, condition）
# ⚠️ as.matrix() 对含字符列的 data.frame 会强制全部转字符！
#    必须先移除基因列再转矩阵。
counts <- read_csv("counts.csv", show_col_types = FALSE) %>%
  tibble::column_to_rownames("gene") %>% as.matrix()
meta <- read_csv("meta.csv", show_col_types = FALSE)
meta$condition <- factor(meta$condition)                   # 必须 factor！

dds <- DESeqDataSetFromMatrix(countData = counts,
                              colData = meta,
                              design = ~ condition)
dds <- DESeq(dds)                                          # 核心步骤：~10-60s
res <- results(dds, contrast = c("condition", "trt", "ctrl"))  # 处理 vs 对照
# type = "normal" 无需额外包；apeglm 结果更佳但需安装 apeglm（不在核心集）
res <- lfcShrink(dds, coef = "condition_trt_vs_ctrl", type = "normal")
res_df <- as.data.frame(res) %>% tibble::rownames_to_column("gene")
res_df <- arrange(res_df, padj)
readr::write_csv(res_df, "de_results.csv")
result <- list(n_genes = nrow(res_df),
               n_sig = sum(res_df$padj < 0.05, na.rm = TRUE),
               top = head(select(res_df, gene, baseMean, log2FoldChange, padj), 10))
```

## 结果解读纪律

- 显著阈值：**padj < 0.05 且 |log2FC| > 1**（双标准；只按 padj 会报出大量生物学无意义的小变化）。
- padj 是 BH-FDR 校正值（DESeq2 内建）——别拿 pvalue 讲故事。
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

1. 显著基因列表 → `bio_enrichr`（Python，ORA）或本插件 r-gsea 协议（排序数据）。
2. 火山图/MA 图 → Python `figurelib`（出版级）或 R ggplot2（英文标签）。
3. 输出 CSV 用绝对路径写工作区，报告文件路径 + 关键数字。

## 高频坑

- counts 必须是**整数矩阵**（小数 = 输入错误，DESeq2 直接报错）。
- `condition` 列必须是 factor；对照组的参考水平用 `relevel(factor, ref = "ctrl")` 控制。
- 设计公式里数字型协变量要 `scale()`，否则对比解释混乱。
- rownames 是基因 ID；`as.data.frame(res)` 丢 rownames 时用 `rownames_to_column`。
- 首次加载 DESeq2 慢（~10s）：bio_r 默认超时 120s 够用，若叠加重分析传大 timeoutMs。
- DESeq2 内部多线程：默认单线程即可，小矩阵别折腾并行。
