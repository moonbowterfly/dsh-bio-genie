---
language: python
---

# 生物数据机器学习（ML）

> 覆盖分类、回归、降维、聚类、特征分析、统计检验的完整 ML 工具链。

## 工具速查

| 工具 | 用途 | 输入 |
|------|------|------|
| `bio_ml_pipeline` | 端到端 ML（训练+评估） | CSV + 目标列 |
| `bio_ml_reduce` | PCA / t-SNE 降维 | CSV 数值矩阵 |
| `bio_ml_feature` | 特征重要性排序 | CSV + 目标列 |
| `bio_ml_cluster` | K-Means / 层次聚类 | CSV 数值矩阵 |
| `bio_stats_test` | 自动统计检验 | CSV + 分组列 + 数值列 |

## 典型工作流

### 1. 分类预测（基因表达 → 表型）
```
bio_ml_pipeline(path="expression.csv", target="phenotype", task="classification", model="random_forest")
→ accuracy / cv_mean / feature_importance
```

### 2. 数据探索（降维可视化）
```
bio_ml_reduce(path="data.csv", method="pca", n_components=2)
→ 坐标 + 方差解释率
```

### 3. 差异分析（实验组 vs 对照组）
```
bio_stats_test(path="results.csv", group_col="condition", value_col="expression", test_type="auto")
→ p 值 + 效应量 + 各组统计
```

### 4. 特征筛选（找关键变量）
```
bio_ml_feature(path="data.csv", target="class", top=10)
→ 特征重要性排序 + 相关性矩阵
```

## 注意事项

- 所有工具输入为 **CSV 文件路径**（绝对路径或工作区内相对路径）
- 自动处理缺失值（中位数填充）和分类目标（LabelEncoder）
- 分类任务默认 80/20 划分 + 5 折交叉验证
- 效应量用 Cohen's d（两组）或 η²（多组）
