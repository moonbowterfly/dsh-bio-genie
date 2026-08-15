# 限制性内切酶分析（Bio.Restriction）

酶切位点查找与模拟消化。

## 酶列表与单酶分析

```python
from Bio.Restriction import EcoRI, BamHI, HindIII, CommOnly

print(EcoRI.site)        # 识别序列
print(EcoRI.elucidate()) # 切割模式
print(len(CommOnly))     # 常用酶数量
```

## 模拟消化

```python
from Bio.Restriction import EcoRI, BamHI, HindIII, Analysis, RestrictionBatch
from Bio.Seq import Seq

seq = Seq("GAATTC" + "GGATCC" + "AAGCTT" * 3 + "GAATTC")

batch = RestrictionBatch([EcoRI, BamHI, HindIII])
analysis = Analysis(batch, seq)
print(analysis.full())                  # 完整报告
print(analysis.with_sites())            # 有切点的酶
print(analysis.print_that(EcoRI))       # 单酶细节
```

## 计算酶切片段大小

```python
from Bio.Restriction import EcoRI, BamHI
from Bio.Seq import Seq

seq = Seq("GAATTC" + "GGATCC" + "ATGC" * 40 + "GAATTC")

# 找出切点位置
cuts = sorted([p for p in EcoRI.search(seq)] + [p for p in BamHI.search(seq)])
print("cut sites:", cuts)

# 片段大小
prev = 0
for c in cuts:
    print(c - prev)
    prev = c
print(len(seq) - prev)
```

## 批量分析所有商用酶

```python
from Bio.Restriction import Analysis, AllEnzymes, CommOnly
from Bio.Seq import Seq

seq = Seq("GAATTC" + "GGATCC" + "ATGC" * 100)
a = Analysis(CommOnly, seq)              # 只查常用酶，比 AllEnzymes 快
print("enzymes with sites:", len(a.with_sites()))
for e in a.with_sites():
    print(e, len(e.search(seq)))
```

## 要点

- `search(seq)` 返回位点列表（生成器）。
- `AllEnzymes` 含上千种酶、分析慢；先用 `CommOnly`。
- 酶是类对象，可用 `RestrictionBatch` 聚合、`Analysis` 统一报告。
