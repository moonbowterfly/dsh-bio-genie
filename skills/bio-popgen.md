# 群体遗传学（Bio.PopGen）

处理群体遗传数据：GenePop 格式解析、Fst、连锁不平衡。

## 解析 GenePop 文件

```python
from Bio.PopGen import GenePop

# 读取 GenePop 文件（需 .gen 格式，含 loci 与群体样本）
with open("data.gen") as f:
    rec = GenePop.read(f)

print("loci:", rec.loci_list)
print("populations:", rec.pop_list)
print("population names:", rec.pop_names)
```

## Fst 估算

```python
from Bio.PopGen import GenePop
from Bio.PopGen.GenePop import Controller

# 通过 GenePop 外部程序计算 Fst（需要本地 genepop 二进制）
# 若无 genepop，改用如下纯 Python 的简单统计：
from Bio.PopGen import GenePop

with open("data.gen") as f:
    rec = GenePop.read(f)

# 打印每群体的等位基因数（简单指标）
for i, pop in enumerate(rec.populations):
    print(rec.pop_names[i], "individuals:", len(pop))
```

## 连锁不平衡（需外部程序或自行实现）

Biopython 的 `Bio.PopGen.GenePop.Controller` 调用本地 GenePop 计算 LD/Fst；纯 Python 侧只负责文件解析与结果读取。没有本地二进制时，可实现两两 LD 的简单统计：

```python
# 简易两两位点 LD 估算（示例，数据为 0/1 基因型矩阵）
from itertools import combinations
import statistics

def ld(gt1, gt2):
    # gt1/gt2 为长度相同的等位基因计数列表（0/1/2）
    pa = sum(gt1) / (2 * len(gt1))
    pb = sum(gt2) / (2 * len(gt2))
    pab = sum(a * b for a, b in zip(gt1, gt2)) / (4 * len(gt1))
    return pab - pa * pb   # D

gts = [[1,0,1,1,0],[0,1,1,0,1],[1,1,0,1,1]]  # 3 loci x 5 individuals
for i, j in combinations(range(len(gts)), 2):
    print(i, j, round(ld(gts[i], gts[j]), 4))
```

## 要点

- 标准 Fst/AMOVA 依赖外部 GenePop 程序；Biopython 提供封装与结果解析。
- 无外部程序时，先用 Python 自行实现基础统计（等位基因频率、期望杂合度、Fst 的简单形式）。
- GenePop 文件格式严格（标题行、`Pop` 分隔、逗号分隔基因型），先检查文件再解析。
