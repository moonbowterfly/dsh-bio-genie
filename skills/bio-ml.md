---
language: python
---

# 生物数据机器学习（ML）

> 覆盖分类、回归、降维、聚类、特征分析、统计检验。

## 工具速查

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `bio_ml_pipeline` | 端到端 ML | path★, target★, task, model |
| `bio_ml_reduce` | PCA/t-SNE | path★, method, n_components |
| `bio_ml_feature` | 特征重要性 | path★, target★, top |
| `bio_ml_cluster` | K-Means/层次 | path★, method, n_clusters |
| `bio_stats_test` | 统计检验 | path★, group_col★, value_col★, test_type |

## 典型工作流

### 1. 分类预测（基因表达 → 表型）
```python
bio_ml_pipeline(path="expression.csv", target="phenotype", task="classification")
→ accuracy, cv_mean, feature_importance
```

### 2. 降维可视化（高维数据 → 2D/3D）
```python
bio_ml_reduce(path="data.csv", method="pca", n_components=2)
→ 坐标 + 方差解释率
```

### 3. 差异分析（实验组 vs 对照组）
```python
bio_stats_test(path="results.csv", group_col="condition", value_col="expression")
→ p 值 + 效应量 + 各组统计
```

### 4. 完整分析流程（数据 → 模型 → 报告）
```
1. bio_fig_profile(path="data.csv")       # 先了解数据结构
2. bio_ml_pipeline(path="data.csv", ...)  # 训练模型
3. bio_ml_feature(path="data.csv", ...)   # 找关键特征
4. bio_stats_test(path="data.csv", ...)   # 统计验证
```

## 模型选择指南

| 数据特征 | 推荐模型 | 理由 |
|----------|----------|------|
| 小样本（<100） | random_forest | 抗过拟合 |
| 大样本（>1000） | svm | 泛化好 |
| 线性可分 | logistic/linear | 简单快速 |
| 特征多 | random_forest | 内置特征选择 |

## 分类 vs 回归判断

- **目标是离散类别**（A/B/C）→ `task="classification"`
- **目标是连续数值**（浓度、表达量）→ `task="regression"`
- **不确定**→ 看目标列的数据类型

## 统计检验选择

| 场景 | 检验方法 | 说明 |
|------|----------|------|
| 两组比较，正态分布 | t-test | 参数检验 |
| 两组比较，非正态 | Mann-Whitney U | 非参数检验 |
| 多组比较 | ANOVA | 参数检验 |
| 分类变量关联 | Chi-squared | 列联表分析 |
| 自动选择 | test_type="auto" | 根据数据自动判断 |

## 注意事项

- 输入必须是 **CSV 文件路径**（不是 DataFrame）
- 自动处理缺失值（中位数填充）和分类目标（LabelEncoder）
- 分类任务默认 80/20 划分 + 5 折交叉验证
- `random_forest` 模型最稳定，适合作为默认选择
- 结果中的 `feature_importance` 按重要性排序，前 3 个通常最有价值
