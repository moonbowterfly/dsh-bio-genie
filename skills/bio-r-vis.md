---
language: r
---

# R 生态可视化（ggplot2 / ggtree / ComplexHeatmap）

> 来源：三包官方 vignette（原创整理）。**分工**：期刊统计图/多面板/中文图 → Python `figurelib`（出版级闭环、CJK 完善）；R 生态专属图（树图、复杂热图、ggplot 快速探索）→ 本 skill。

## ggplot2（快速探索 + 英文出版图）

```r
suppressPackageStartupMessages({
  library(ggplot2)
  library(readr)
  library(dplyr)
})
df <- read_csv("de_results.csv", show_col_types = FALSE)

# 火山图（差异表达标配）
p <- ggplot(df, aes(x = log2FoldChange, y = -log10(padj))) +
  geom_point(aes(color = padj < 0.05 & abs(log2FoldChange) > 1), size = 1.2, alpha = 0.7) +
  scale_color_manual(values = c("grey70", "#0072B2"), guide = "none") +
  geom_hline(yintercept = -log10(0.05), linetype = "dashed", color = "grey50") +
  labs(x = "log2 Fold Change", y = "-log10 adjusted p") +
  theme_minimal(base_size = 9)
ggsave("volcano.png", p, width = 4, height = 4, dpi = 300)
```

- 语法 = 数据 + 映射(aes) + 几何(geom)：分面 `facet_wrap(~group)`、箱线 `geom_boxplot` + `geom_jitter`（小样本叠点，同 bio-figure P1 纪律）。
- **期刊投稿规范复用 bio-figure 的五条硬性原则**（最终尺寸、矢量导出、色盲配色、误差交代）——ggplot2 出图同样适用。
- 中文标签：核心包无 showtext → 中文图交给 Python figurelib，ggplot 默认英文。

## ggtree（系统发育树可视化）

```r
suppressPackageStartupMessages({
  library(ggtree)
  library(ape)
})
# 输入 Newick（bio_python 的 Bio.Phylo 或用户提供）
tree <- ape::read.tree("tree.nwk")

p <- ggtree(tree) +
  geom_tiplab(size = 3, hjust = -0.1) +           # 叶标签
  geom_tippoint(aes(color = group), size = 2) +   # 分组着色（元数据须先 %<+% 挂载）
  theme_tree2()
ggsave("tree.png", p, width = 8, height = 6, dpi = 300)
```

- 元数据挂载：`p %<+% meta_df`（第一列必须是 tip 标签）。
- 与 bio-proto-phylo-nj（Python 建树）协作：Python 算树 → 写 Newick → R ggtree 美化。
- 环形布局 `ggtree(tree, layout = "circular")`。

## ComplexHeatmap（复杂热图：表达/富集矩阵）

```r
suppressPackageStartupMessages(library(ComplexHeatmap))
# mat：数值矩阵（行=基因/通路，列=样本）
mat_scaled <- t(scale(t(mat)))                     # 行 z-score（表达热图惯例）
ht <- Heatmap(mat_scaled,
              name = "z-score",
              col = circlize::colorRamp2(c(-2, 0, 2), c("#2166AC", "white", "#B2182B")),
              show_row_names = FALSE,
              column_split = group_vec,            # 样本分组条
              row_km = 3,                          # 行 k-means 聚类
              heatmap_legend_param = list(direction = "horizontal"))
png("heatmap.png", width = 1800, height = 2400, res = 300)
draw(ht)
dev.off()
```

- 配色纪律（同 bio-figure P9/P14）：发散矩阵用 RdBu 系（红白蓝），**表达数据严禁 rainbow/jet**。
- 行数 > 200 时关闭行名（show_row_names = FALSE），图才可读。
- 输出 PNG 用 `res = 300` 保证期刊分辨率；矢量版用 `pdf("heatmap.pdf"); draw(ht); dev.off()`。

## 高频坑

- `ggsave` 的 width/height 是英寸——按目标期刊尺寸设定，不要在 Word 里缩放。
- ggtree 的 `%<+%` 是 ggtree 专属操作符，须先 library(ggtree)。
- ComplexHeatmap 依赖 circlize（自动装）；colorRamp2 用 `circlize::` 显式调用防遮蔽。
- R 绘图默认不友好色盲——`scale_color_manual(values = c("#0072B2","#D55E00","#009E73","#CC79A7"))`（Okabe-Ito）手工指定。
- 所有图文件用绝对路径写工作区并报告路径；每张图只讲一个结论（bio-figure P8）。
