---
language: r
---

# R 微生物组分析（phyloseq）

> 来源：phyloseq 官方 vignette（原创整理）。微生物组多样性（alpha/beta/PCoA/PERMANOVA）是 R 生态的权威能力（对应改进报告中 Python 侧 scikit-bio 候选缺口——本插件选择 R 路线落地）。

## 输入约定

用户通常有：OTU/ASV 丰度表（CSV：行=OTU，列=样本）、样本分组表、分类注释表（可选）。biom 格式（QIIME 输出）的转换包不在核心集——**让用户给 CSV**，或先如实说明边界。

```r
suppressPackageStartupMessages({
  library(phyloseq)
  library(readr)
  library(dplyr)
})

# 1. 丰度表：第一列 OTU id → rownames
otu_df <- read_csv("otu.csv", show_col_types = FALSE) %>% as.data.frame()
rownames(otu_df) <- otu_df[[1]]; otu_df <- otu_df[, -1, drop = FALSE]

# 2. 样本表
samp <- read_csv("meta.csv", show_col_types = FALSE) %>% as.data.frame()
rownames(samp) <- samp$sample; samp$group <- factor(samp$group)

# 3. 组装 phyloseq 对象
otu <- otu_table(as.matrix(otu_df), taxa_are_rows = TRUE)   # 行=OTU 必须声明！
sam <- sample_data(samp)
ps <- phyloseq(otu, sam)

# （可选）分类注释表 → tax_table() 一并传入
```

## 标准分析管道

```r
# alpha 多样性（Shannon/Simpson/Chao1/Observed）
alpha <- estimate_richness(ps, measures = c("Shannon", "Simpson", "Observed"))
alpha$sample <- rownames(alpha)
alpha <- left_join(alpha, data.frame(sample = rownames(samp), group = samp$group), by = "sample")

# 组间 alpha 差异（非参数检验）
shannon_trt <- alpha$Shannon[alpha$group == "trt"]
shannon_ctrl <- alpha$Shannon[alpha$group == "ctrl"]
wt <- wilcox.test(shannon_trt, shannon_ctrl)
result <- list(alpha = alpha, wilcox_p = wt$p.value)

# beta 多样性 + PCoA
ps_rel <- transform_sample_counts(ps, function(x) x / sum(x))   # 相对丰度
dist_bc <- distance(ps_rel, method = "bray")                     # Bray-Curtis
ord <- ordinate(ps_rel, method = "PCoA", distance = dist_bc)

# PERMANOVA（分组解释力）
perm <- adonis2(dist_bc ~ group, data = as(sam, "data.frame"), permutations = 999)

# 图（英文标签；中文图走 Python figurelib）
p <- plot_ordination(ps_rel, ord, color = "group") + theme_minimal()
ggsave("pcoa.png", p, width = 6, height = 5, dpi = 300)
result <- list(pcoa_file = "pcoa.png",
               permanova_r2 = perm$R2[1], permanova_p = perm$`Pr(>F)`[1],
               alpha_top = head(arrange(alpha, desc(Shannon)), 5))
```

## 解读纪律

- alpha 多样性：Shannon（丰富度+均匀度）、Observed（物种数）——**只报检验过的差异**（wilcox/kruskal），并给效应方向（哪组高）。
- beta：Bray-Curtis 距离 + PCoA 前两轴解释方差比例要报告；PERMANOVA 的 R² 是"分组解释了百分之几的变异"——R² 小但 p 显著 = 分组有真实但微弱的结构，别过度解读。
- 相对丰度 vs 绝对计数：变换方法要在方法里写明。
- 稀有度曲线（rarefaction）注意：现代共识倾向不重抽样，用归一化替代——协议默认相对丰度路线。
- 每组样本数 <5 时结论标"探索性"。

## 高频坑

- `otu_table(..., taxa_are_rows = TRUE)` 不声明会导致 OTU 和样本维度互换，下游全错。
- 样本表 rownames 必须与丰度表列名**完全一致**（顺序无关，名字必须对齐）。
- `adonis2` 在 vegan 包（phyloseq 自动依赖）里，用 `vegan::adonis2` 显式调用更稳。
- 距离矩阵计算前先做相对丰度变换，否则测序深度差异直接主导 beta 距离。
- ggplot2 出图用 `ggsave(..., dpi = 300)` 保证期刊分辨率；中文标签转 Python figurelib。
