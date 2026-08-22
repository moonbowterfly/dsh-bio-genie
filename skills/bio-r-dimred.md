---
language: r
---

# R 降维与聚类（Rtsne + cluster）

> 来源：Rtsne 包文档 + R base stats（原创整理）。**分工原则**：高维组学数据（表达矩阵/PCA 坐标）→ 用本 skill 做 t-SNE 可视化探索；UMAP 暂不可用（依赖 reticulate，需 Python 配置）；出版级降维图 → 走 Python figurelib。

## 对象模型

| 概念 | Rtsne 返回 | 说明 |
|------|-----------|------|
| 输入 | `matrix`（n 行 × p 列） | 行 = 样本，列 = 特征（基因/PC） |
| 输出 `$Y` | `matrix`（n × 2） | t-SNE 坐标（x, y） |
| 输出 `$D` | 距离矩阵 | 输入数据的成对距离 |
| perplexity | 标量 | 困惑度，控制局部 vs 全局结构平衡（默认 30） |

`cluster` 包是 R base 自带的，无需额外安装。

## 标准管道

### 管道 1：表达矩阵 → t-SNE 降维

```r
suppressPackageStartupMessages({
  library(Rtsne)
  library(dplyr)
})

# 输入：表达矩阵（行=基因，列=样本）或转置后（行=样本，列=基因）
# 从 CSV 读入
expr <- read.csv("expression_matrix.csv", row.names = 1)
# t-SNE 要求 行=样本，列=特征 → 转置
mat <- t(as.matrix(expr))

# 标准化（可选但推荐）
mat <- scale(mat)

# 运行 t-SNE
set.seed(42)  # 可复现
tsne_out <- Rtsne(mat, dims = 2, perplexity = 30, verbose = FALSE)

# 结果
tsne_df <- data.frame(
  tsne_1 = tsne_out$Y[, 1],
  tsne_2 = tsne_out$Y[, 2],
  sample = rownames(mat)
)

result <- list(
  n_samples = nrow(tsne_df),
  preview = head(tsne_df, 5)
)
```

### 管道 2：t-SNE + 层次聚类

```r
suppressPackageStartupMessages({
  library(Rtsne)
  library(cluster)
})

# 1. t-SNE 降维
set.seed(42)
tsne_out <- Rtsne(mat, dims = 2, perplexity = 30, verbose = FALSE)

# 2. 在 t-SNE 坐标上做层次聚类
dist_mat <- dist(tsne_out$Y)
hc <- hclust(dist_mat, method = "ward.D2")

# 3. 切割为 k 个簇
k <- 3
clusters <- cutree(hc, k = k)

# 4. 结果
tsne_df <- data.frame(
  tsne_1 = tsne_out$Y[, 1],
  tsne_2 = tsne_out$Y[, 2],
  cluster = factor(clusters),
  sample = rownames(mat)
)

result <- list(
  n_clusters = k,
  cluster_sizes = as.list(table(clusters)),
  preview = head(tsne_df, 5)
)
```

### 管道 3：PCA → t-SNE（高维数据常用前处理）

```r
# 先 PCA 降维再 t-SNE，减少噪声和计算量
pca_res <- prcomp(mat, center = TRUE, scale. = TRUE)
# 取前 50 个 PC（或累计方差 > 80% 的 PC 数）
n_pcs <- min(50, sum(cumsum(pca_res$sdev^2 / sum(pca_res$sdev^2)) < 0.8) + 1)
pc_mat <- pca_res$x[, 1:n_pcs]

set.seed(42)
tsne_out <- Rtsne(pc_mat, dims = 2, perplexity = 30, verbose = FALSE)
```

## 结果解读纪律

- **perplexity 选择**：经验值 5-50，样本数 < 50 时设 perplexity = floor(n/3)。同一数据不同 perplexity 看到的结构可能完全不同——**至少跑 2-3 个 perplexity 对比**。
- **t-SNE 不保距**：簇间距离不代表真实相似度，只看拓扑结构。不要用 t-SNE 坐标距离做统计推断。
- **set.seed() 必须**：t-SNE 有随机性，不设种子不可复现。
- **层次聚类 vs k-means**：层次聚类不需要预设 k（可用 silhouette 选最优 k）；k-means 适合大样本快速分群。

## 高频坑

- **输入维度**：`Rtsne()` 要求行=样本、列=特征。常见错误是传入了转置前的矩阵（行=基因）。
- **大数据集**：样本数 > 10000 时 `Rtsne` 很慢——先 PCA 降到 50 维再 t-SNE。
- **NaN/Inf**：标准化后如有零方差特征会产生 NaN → 先移除零方差行/列。
- **UMAP 不可用**：`umap` 包依赖 `reticulate`（Python 接口），本环境未配置。需要 UMAP 时可考虑 Python `scanpy` 的 `sc.tl.umap()`。

## 边界

- 本 skill 覆盖 t-SNE（Rtsne）+ 层次聚类（cluster::hclust）。k-means 用 base `kmeans()`。
- UMAP 需要 Python reticulate，暂不可用——降维可视化优先 t-SNE。
- 出版级降维图（带分群颜色/标注/图例）→ 走 Python ggplot2 或 figurelib。
