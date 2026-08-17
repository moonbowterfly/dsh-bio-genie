---
language: python
---

# 序列操作（Bio.Seq / Bio.SeqUtils）

序列级变换与物化性质计算。

## 基础变换

```python
from Bio.Seq import Seq

s = Seq("ATGAAACGCATTAGCACCACCATTACCACCACCATTACCACCACCATTACCACCACCATTACCAC")
print(s.complement())
print(s.reverse_complement())
print(s.transcribe())        # DNA -> RNA (T -> U)
print(s.back_transcribe())   # RNA -> DNA
print(s.translate())         # 翻译成蛋白 (默认 standard table 1)
print(s.translate(table=11, to_stop=True))   # 指定遗传密码表/终止于第一个 stop
```

## 计数与查找

```python
s = Seq("ATGATGAAATTTCCC")
print(s.count("ATG"))
print(s.find("AAA"))          # 首次出现位置（-1 表示不存在）
print(s.count("G") / len(s))  # 手工 GC 含量
```

## 物化性质（Bio.SeqUtils）

```python
from Bio.SeqUtils import GC, gc_fraction, molecular_weight, melting_temp, GC_skew

s = Seq("ATGAAACGCATTAGCACCACCATTACCACCACCATTACCACCACCATTACCACCACCATTACCAC")
print("GC%:", gc_fraction(s))                    # 0.0 ~ 1.0
print("GC% (legacy):", GC(s))
print("MW:", molecular_weight(s))                # 分子量 (Da)
print("Tm:", melting_temp(s))                    # 熔解温度（默认 Wallace 法）
print("GC skew:", GC_skew(s, window=10))         # (G-C)/(G+C) 滑窗列表
```

## 三联密码 / 氨基酸互转

```python
from Bio.SeqUtils import seq1, seq3

print(seq3("MAKIV"))     # 三字母缩写 -> "MetAlaLysIleVal"
print(seq1("MetAlaLys")) # -> "MAK"
```

## 六框翻译

```python
from Bio.SeqUtils import six_frame_translations
from Bio.Seq import Seq

s = Seq("ATGAAACGCATTAGCACCACCATTACCACCACCATTACCACCACCATTACCACCACCATTACCAC")
for frame, pep in six_frame_translations(s).items():
    print(frame, pep)
```

## 要点

- `translate()` 返回 `Seq`，可再 `len()` / 继续切片。
- `molecular_weight(seq, seq_type="protein")` 对蛋白序列请加 `seq_type`。
- GC 含量不同工具口径不同：`gc_fraction` 返回小数，`GC` 返回百分比数字。
