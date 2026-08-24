---
language: python
---

# 生存分析（Survival Analysis）

> 吸收自 bio-research survival-analysis skill + Google DeepMind science-skills 最佳实践 + Nature 2025 综述

## When to Use

做生存分析、KM 曲线、Cox 回归、预后模型、表达-生存关联时加载本 skill。

## 环境

- **Python**：lifelines（`pip install lifelines`）
  ```python
  from lifelines import KaplanMeierFitter, CoxPHFitter, logrank_test
  from lifelines.utils import concordance_index
  ```
- **数据格式**：三列核心——`time`（随访时间）、`event`（1=发生终点事件，0=删失）、协变量列

## 统计方法选择决策树

```
生存分析任务
├─ 仅描述生存曲线 → Kaplan-Meier
│   └─ 两组比较 → log-rank 检验
├─ 多因素回归
│   ├─ 比例风险假设满足 → Cox PH 回归
│   │   └─ 高维特征（p>>n）→ LASSO-Cox / SCAD-Cox
│   └─ 比例风险假设不满足 → 分层 Cox / 时变系数 / Aalen 加法模型
├─ 竞争风险（死于其他原因 vs 疾病相关死亡）→ Fine-Gray / cmprsk
├─ 预测模型评价 → 时间依赖 ROC / C-index / 校准曲线
└─ 预后可视化 → 森林图 / 列线图 / 风险表
```

## 标准分析流程（TCGA 风格表达-生存分析）

### 1. 数据准备
```python
import pandas as pd
df = pd.read_csv('survival_data.csv')
# 检查：time>0, event∈{0,1}, 无缺失
print(f"样本量: {len(df)}, 事件数: {df['event'].sum()}, 删失率: {1-df['event'].mean():.1%}")
```

### 2. 分组（⚠️ 避免 p-hacking）
```python
# 按基因表达中位数分组（最常用）
median_expr = df['gene_expression'].median()
df['group'] = (df['gene_expression'] >= median_expr).map({True: 'High', False: 'Low'})

# ⚠️ 不要「试切点直到显著」——必须在分析前确定切点方法
# 如果要优化切点，用 maximally selected rank statistics（maxstat 方法）
```

### 3. Kaplan-Meier + log-rank
```python
kmf = KaplanMeierFitter()

fig, ax = plt.subplots(figsize=(8, 6))
for group in ['High', 'Low']:
    mask = df['group'] == group
    kmf.fit(df.loc[mask, 'time'], df.loc[mask, 'event'], label=group)
    kmf.plot_survival_function(ax=ax)

# log-rank 检验
results = logrank_test(
    df.loc[df['group']=='High', 'time'],
    df.loc[df['group']=='Low', 'time'],
    df.loc[df['group']=='High', 'event'],
    df.loc[df['group']=='Low', 'event']
)
ax.set_title(f'KM Curve (log-rank p = {results.p_value:.4f})')
plt.savefig('figures/km_curve.png', dpi=300, bbox_inches='tight')
```

### 4. Cox 比例风险回归（多因素校正）
```python
cph = CoxPHFitter(penalizer=0.01)
cph.fit(df[['time', 'event', 'gene_expression', 'age', 'stage']], 
        duration_col='time', event_col='event')
cph.print_summary()  # 报告 HR (95% CI) 和 p 值

# 森林图
cph.plot()
plt.savefig('figures/forest_plot.png', dpi=300, bbox_inches='tight')
```

### 5. 比例风险假设检验（⚠️ 关键步骤）
```python
# Schoenfeld 残差检验
cph.check_assumptions(df[['time', 'event', 'gene_expression', 'age', 'stage']], 
                       p_value_threshold=0.05)
# 如果不满足 PH 假设 → 分层 Cox 或时变系数
```

### 6. 预测能力评价
```python
# C-index
c_index = concordance_index(df['time'], -cph.predict_partial_hazard(df), df['event'])
print(f'C-index: {c_index:.3f}')

# 时间依赖 ROC（需 R timeROC 或 Python scikit-survival）
```

## 报告规范

| 指标 | 必须报告 | 说明 |
|------|----------|------|
| 中位生存时间 | ✅ | KM 估计，High vs Low 组 |
| log-rank p 值 | ✅ | 精确 p 值，不只写 <0.05 |
| Cox HR (95% CI) | ✅ | 每个变量的 HR 和置信区间 |
| C-index | ✅ | 模型预测能力 |
| 风险表 | ✅ | KM 曲线必须带 number at risk |
| PH 假设检验 | ✅ | Schoenfeld 残差 p 值 |
| 删失比例 | ✅ | 说明删失比例和原因 |

## 统计严谨性清单

- [ ] **样本量**：每组事件数 ≥ 10（非样本数，是事件数）
- [ ] **p-hacking**：切点在分析前确定，不试多个切点
- [ ] **混杂因素**：Cox 回归校正临床协变量（年龄、分期等）
- [ ] **PH 假设**：cox.zph 或 Schoenfeld 检验不显著
- [ ] **效应量**：报告 HR + 95%CI，不只看 p 值
- [ ] **竞争风险**：有竞争事件时用 Fine-Gray，不用 KM
- [ ] **多重比较**：多基因分析时校正（BH-FDR）

## 常见错误

| 错误 | 正确做法 |
|------|----------|
| 只看 p<0.05 就说「显著」 | 报告 HR + 95%CI，讨论效应大小 |
| 试多个切点直到显著 | 分析前确定切点方法（中位数/maxstat） |
| 不检验 PH 假设 | 必须做 Schoenfeld 残差检验 |
| 忽略竞争风险 | 有竞争事件时用 cmprsk::crr |
| 样本量小仍过度解读 | 报告置信区间宽度，说明统计功效限制 |
