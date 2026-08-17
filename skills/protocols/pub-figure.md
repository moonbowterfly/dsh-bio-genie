---
name: bio-proto-pub-figure
domain: visualization
inputs: [数据文件(CSV/TSV/Excel)或已有数据]
outputs: [出版级图文件(PDF/SVG/PNG) + 审计结论]
requires_network: false
language: python
---

# 出版级出图协议（执行层配方）

**适用场景**：用户要论文配图/统计图/多面板图。决策层（选什么图、避什么坑）在 `bio-figure` skill；本协议是执行层——**完整闭环：profile → 选图 → setup_style → 绘制 → 自检 → 导出 → 审计 → 回改**。

## 标准流程

```
bio_fig_profile(path="data.csv", group_cols=["group"])   # 1. 剖析 + 建议
bio_fig_qa(lang="zh")                                     # 2. 中文图先查字体
bio_python  →  setup_style + 按配方画图 + audit_layout    # 3-6. 绘制+自检
bio_python  →  export_figure 导出                          # 7. 导出
bio_fig_export(paths=["fig1.pdf"], min_dpi=300, ...)      # 8. 审计，FAIL 回改
```

bio_python 代码里可直接 `import figurelib`（bridge 进程的脚本目录在 sys.path 上）。

## 通用模板（每个配方都套这个骨架）

```python
import matplotlib.pyplot as plt
from figurelib.setup_style import setup_style
from figurelib.layout_tools import finalize_figure, add_panel_labels
from figurelib.visual_qa import audit_layout
from figurelib.export_figure import export_figure

setup_style(journal='nature', lang='en')          # 期刊预设；中文传 lang='zh'
fig, ax = plt.subplots(figsize=(3.5, 2.625))      # 直接定最终尺寸！
# ... 按下方配方画 ...
finalize_figure(fig)                              # 版面兜底（constrained_layout）
issues = audit_layout(fig)                        # 自检：缺字/裁切/刻度重叠
print('QA:', issues if issues else 'PASS')
paths = export_figure(fig, 'figs/fig1', formats=['pdf','svg','png'],
                      size_inches=(3.5, 2.625), dpi=300, grayscale_preview=True)
print('saved:', paths)
result = {'files': paths, 'qa_issues': issues}
```

## 九类配方

### 1. 折线图（时间/剂量，含误差带）

```python
import numpy as np
x = np.linspace(0, 10, 12)
y = np.array([np.sin(x)*2+3]*12)                  # 假装 12 只小鼠
y += np.random.default_rng(1).normal(0, .3, (12, 12))
mu, sem = y.mean(0), y.std(0, ddof=1) / np.sqrt(y.shape[0])
ax.plot(x, mu, color='#0072B2', lw=1.5, label='treated')
ax.fill_between(x, mu-sem, mu+sem, alpha=.25, color='#0072B2')
ax.set_xlabel('Time (h)'); ax.set_ylabel('Response')
# 图注: shaded band = SEM, n = 12 mice per group.
```

### 2. 柱状图（分组 + 误差棒 + 叠加原始点）

```python
import seaborn as sns
import pandas as pd
df = pd.read_csv('data.csv')
sns.barplot(data=df, x='condition', y='response', hue='group',
            errorbar='se', palette='colorblind', alpha=.9, ax=ax)
sns.stripplot(data=df, x='condition', y='response', hue='group',
              dodge=True, size=3, color='black', alpha=.6, ax=ax, legend=False)
# 每组 n<10 时禁用均值柱——见 bio-figure P1，改用配方 4
```

### 3. 散点图（回归 + r/p）

```python
from scipy import stats
r, p = stats.pearsonr(df['x'], df['y'])
ax.scatter(df['x'], df['y'], s=12, alpha=.7)
m, b = np.polyfit(df['x'], df['y'], 1)
ax.plot(df['x'], m*df['x']+b, color='#D55E00', lw=1)
ax.text(.05, .92, f'r = {r:.2f}, p = {p:.2g}', transform=ax.transAxes)
```

### 4. 箱线/小提琴 + stripplot（小样本必须叠点）

```python
import seaborn as sns
sns.violinplot(data=df, x='group', y='value', inner=None, cut=0,
               palette='colorblind', ax=ax)
sns.stripplot(data=df, x='group', y='value', size=3, color='black',
              alpha=.6, ax=ax)
```

### 5. 热力图（感知均匀色图）

```python
import seaborn as sns
sns.heatmap(corr, annot=True, fmt='.2f', cmap='RdBu_r', vmin=-1, vmax=1,
            square=True, ax=ax)
```

### 6. 误差棒图（剂量响应）

```python
means, sems = df.groupby('dose')['response'].agg(['mean','sem']).values.T
ax.errorbar(df['dose'].unique(), means[0], yerr=means[1], fmt='o-',
            capsize=3, color='#0072B2')
```

### 7. 分布图（直方图 + KDE + rug）

```python
import seaborn as sns
sns.histplot(df['value'], kde=True, color='#009E73', alpha=.5, ax=ax)
sns.rugplot(df['value'], height=.04, color='black', ax=ax)
```

### 8. 相关性矩阵 / 散点矩阵

```python
import seaborn as sns
# 8a. 相关性热力图（半矩阵）
mask = np.triu(np.ones_like(corr, dtype=bool))
sns.heatmap(corr, mask=mask, annot=True, cmap='RdBu_r', vmin=-1, vmax=1, ax=ax)
# 8b. pairplot 独立 Figure（≤8 列）
g = sns.pairplot(df, diag_kind='kde', corner=True, palette='colorblind')
```

### 9. 多面板组合（Figure 1：PCA + 火山 + 热图…）

```python
fig, axes = plt.subplots(2, 2, figsize=(7.2, 5.4))
# 各 panel 独立画，保证字号/配色/同一变量同色一致
axes[0,0].plot(...); axes[0,1].scatter(...)
axes[1,0].bar(...); axes[1,1].plot(...)
finalize_figure(fig)
add_panel_labels(fig, style='nature')   # a b c d 自动横竖对齐；IEEE 用 style='ieee'
# 再 export_figure(fig, 'figs/fig1', size_inches=(7.2, 5.4), ...)
```

### 显著性标注（配方 4 之后）

```python
from matplotlib.lines import Line2D
x1, x2 = 0, 1                                  # 组在 x 轴的位置
y, h = df['value'].max() * 1.05, df['value'].max() * 0.02
ax.plot([x1, x1, x2, x2], [y, y+h, y+h, y], lw=.8, color='black')
ax.text((x1+x2)/2, y+h, '**', ha='center', va='bottom')
# 检验方法与校正必须在图注交代（见 bio-proto-statistics）
```

## 常见坑

- **图注三件套**：误差类型（SD/SEM/CI）+ n + 检验/校正——任何误差棒/显著性图都不能缺。
- `figsize` 必须 = 最终尺寸；导出后禁止二次缩放（字号是绝对 pt）。
- 中文图：先 `bio_fig_qa`；`setup_style(lang='zh')` 必须在任何中文文本渲染前调用。
- `audit_layout` 要在导出前对 Figure 对象调用（落盘文件无法版面自检）。
- 色盲检查：`export_figure(..., grayscale_preview=True)` 出灰度版，看类别能否区分。
- plotly 交互图不在插件范围——多面板/静态图用 matplotlib 足够。
- 显著性桥的 x 坐标对应 dodge 后实际位置，改了分组要同步改。
- 每张图只讲一个核心结论；>2 个分类维度先查 bio-figure 的拆图标准。
