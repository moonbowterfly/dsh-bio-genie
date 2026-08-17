---
language: python
---

# 序列模体（Bio.motifs）

位置权重矩阵（PWM/PSSM）、motif 创建与扫描。

## 从比对实例创建 motif

```python
from Bio import motifs
from Bio.Seq import Seq

instances = [Seq("TACAA"), Seq("TACGC"), Seq("TACAC"), Seq("TACCC")]
m = motifs.create(instances)
print(m.consensus)
print(m.counts)          # 位置计数矩阵
print(m.pwm)             # 位置权重矩阵（含伪计数）
print(m.pssm)            # 位置特异性打分矩阵
```

## 在序列上扫描

```python
from Bio import motifs
from Bio.Seq import Seq

instances = [Seq("TACAA"), Seq("TACGC"), Seq("TACAC"), Seq("TACCC")]
m = motifs.create(instances)

seq = Seq("GTACACACGTACAA")
for pos, score in m.pssm.search(seq):
    print("match at", pos, "score", round(score, 2))
```

## 读取 MEME / JASPAR

```python
from Bio import motifs

# MEME 文本
with open("meme.txt") as f:
    for motif in motifs.parse(f, "meme"):
        print(motif.name, motif.consensus)

# JASPAR（需 .jaspar 或 matrix 文件）
with open("motif.jaspar") as f:
    for motif in motifs.parse(f, "jaspar"):
        print(motif.matrix_id, motif.consensus)
```

## 反向互补 motif

```python
from Bio import motifs
from Bio.Seq import Seq

m = motifs.create([Seq("TACAA"), Seq("TACGC")])
rc = m.reverse_complement()
print(rc.consensus)
```

## 要点

- `motifs.create(instances)` 自动加伪计数；用 `motifs.create(instances, pseudocounts=0)` 关闭。
- PWM/PSSM 打分矩阵可直接输出为 TSV 供下游使用。
- 多 motif 文件的遍历用 `motifs.parse(handle, format)` 生成器。
