---
name: bio-proto-statistics
domain: statistics
inputs: [两组/多组数值数据, 或设计问题描述]
outputs: [检验选择建议 + 统计结果(p 值/效应量/功效)]
requires_network: false
language: python
---

# 统计分析协议

**适用场景**：组间比较、相关性检验、多重校正、样本量/功效评估、实验结果显著性标注的数据基础。吸收自 K-Dense `statistical-analysis` / `statistical-power` / `experimental-design` 三 skill 的知识层。执行依赖 scipy（已入核心依赖）。

## 检验选择决策树

```
问题类型？
├─ 两组连续数据比均值
│   ├─ 配对（同一样本前后测）   → scipy.stats.ttest_rel
│   ├─ 独立且正态、方差齐       → scipy.stats.ttest_ind（Welch 默认更稳）
│   └─ 非正态 / 小样本 / 有离群 → scipy.stats.mannwhitneyu（秩和）
├─ 多组（≥3）连续数据
│   ├─ 正态、方差齐             → scipy.stats.f_oneway（单因素 ANOVA）
│   ├─ 非正态                   → scipy.stats.kruskal
│   └─ 两因素/交互             → statsmodels anova（插件未内置 statsmodels，用 bio_python 提示或简化为单因素+配对设计）
├─ 分类变量关联（列联表）       → scipy.stats.chi2_contingency / fisher_exact
├─ 两连续变量相关性
│   ├─ 线性（正态）             → scipy.stats.pearsonr
│   └─ 单调（非正态）           → scipy.stats.spearmanr
└─ 生存数据（时间-事件）        → scipy 无内置，lifelines 不在插件范围——如实告知用户
```

**假设检验前必做**：正态性（`scipy.stats.shapiro`，n<5000）与方差齐性（`scipy.stats.levene`）。n 很小（<10/组）时正态检验没意义——直接上非参数检验。

## 代码模板（bio_python）

```python
from scipy import stats
import numpy as np

# 两组独立 t 检验（Welch，不假设方差齐）
t, p = stats.ttest_ind(ctrl, treat, equal_var=False)
# 非参数替代
u, p = stats.mannwhitneyu(ctrl, treat, alternative='two-sided')
# 配对
t, p = stats.ttest_rel(before, after)
# 多组
f, p = stats.f_oneway(g1, g2, g3)
# 相关性
r, p = stats.pearsonr(x, y)
# 列联表
chi2, p, dof, expected = stats.chi2_contingency(table)
```

## 多重比较校正（必须做！）

比较次数 > 1 就必须校正，否则假阳性率膨胀：

```python
from statsmodels.stats.multitest import multipletests  # 未内置
# 插件环境无 statsmodels —— 用纯 scipy 实现常用校正：
def bonferroni(ps):
    """Bonferroni：p * m，截断到 1。保守。"""
    import numpy as np
    return np.minimum(np.array(ps) * len(ps), 1.0)

def bh_fdr(ps):
    """Benjamini-Hochberg FDR：q 值（推荐默认）。"""
    import numpy as np
    ps = np.asarray(ps, dtype=float); m = len(ps)
    order = np.argsort(ps); q = np.empty(m); prev = 1.0
    for rank, i in enumerate(order[::-1]):          # 从最大 p 往回
        q[i] = min(prev, ps[i] * m / (m - rank))
        prev = q[i]
    return q
```

- 全组探索性比较（如转录组 2 万基因）→ **BH-FDR**；只比较 3-5 个预设计检验 → Bonferroni 可接受。
- 报告：校正方法 + 校正后 p 值（q 值）；图注写清（如 `** q < 0.01, BH-FDR`）。

## 效应量与功效（p 值之外必须报告）

- **效应量**：两组连续 → Cohen's d；ANOVA → η²；相关性 → r 本身。p 值只回答"是否有差异"，效应量回答"差异多大"。
- **功效**：样本量不足时"p>0.05"不能解读为"无差异"（可能是没检验出来）。

```python
def cohens_d(a, b):
    """Cohen's d（合并标准差）。0.2 小 / 0.5 中 / 0.8 大。"""
    import numpy as np
    na, nb = len(a), len(b)
    sp = np.sqrt(((na-1)*np.var(a, ddof=1) + (nb-1)*np.var(b, ddof=1)) / (na+nb-2))
    return (np.mean(a) - np.mean(b)) / sp

def power_t_test(n_per_group, effect_size, alpha=0.05):
    """两独立样本 t 检验功效（近似，用标准正态）。"""
    from scipy import stats
    ncp = effect_size * np.sqrt(n_per_group / 2)
    crit = stats.norm.ppf(1 - alpha / 2)
    return stats.norm.cdf(ncp - crit) + stats.norm.cdf(-ncp - crit)
```

- 功效 < 80% 的实验设计应提示增加样本量（n 估算：`(2*(z_α/2+z_β)²)/d²`，α=0.05、β=0.2 时 n/组 ≈ 16/d²）。
- 事后功效（post-hoc power）统计界有争议——优先报告置信区间而非事后功效。

## 实验设计要点（实验前就该想）

1. **对照**：阴性/阳性/空白对照至少一个；"没对照"的结果原则上不可下结论。
2. **随机化 + 盲法**：分组随机、测量盲法，防选择偏倚。
3. **重复 vs 伪重复**：生物学重复（不同动物/细胞株/病人）才是统计单元；同一孔测 3 次是技术重复，不能当 n=3。
4. **混杂变量**：批次/性别/年龄/板位——设计时分块（blocking），分析时入模型或分层。
5. **预注册**：主要终点、检验方法、校正方案在收数据前定死，防止 p-hacking。

## 报告规范（APA 风格示例）

> "处理组（M = 3.42, SD = 0.61, n = 12）显著高于对照组（M = 2.87, SD = 0.58, n = 12），Welch's t(21.4) = 2.28, p = .034, Cohen's d = 0.92（95% CI [0.08, 1.76]）。多组比较 p 值经 BH-FDR 校正。"

要点：均值+SD+n、检验名+统计量+自由度、p 值（校正注明）、效应量+置信区间。

## 常见坑

- n<10/组还跑 Shapiro 检验 → 没意义，直接非参数。
- 3 组两两 t 检验做 3 次不校正 → 假阳性率 14%+；用 ANOVA + 事后检验（Tukey，scipy 无内置——简化：ANOVA 显著后报告组间效应量+置信区间，或提示用 statsmodels）。
- 把 SEM 当 SD 画在图里（SEM = SD/√n，视觉上"更紧"误导读者）→ 图注必须写清。
- p=0.049 和 p=0.051 没有实质区别——不要按阈值二分讲故事。
- 相关 ≠ 因果；横断面数据只能报告关联。
- 多重比较只校正"做了的比较"，选择性报告（只展示显著者）本身就是 p-hacking。
