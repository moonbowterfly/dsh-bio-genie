---
language: python
---

# 序列比对（Bio.Align / Bio.AlignIO）

## 双序列比对（PairwiseAligner）

现代 Biopython 用 `Bio.Align.PairwiseAligner`（替代已弃用的 `Bio.pairwise2`）。

```python
from Bio import Align
from Bio.Seq import Seq

aligner = Align.PairwiseAligner()
aligner.mode = "global"            # "global" | "local" | "semiglobal" | "global_cxx" 等
aligner.match_score = 2
aligner.mismatch_score = -1
aligner.open_gap_score = -5
aligner.extend_gap_score = -1

alignments = aligner.align(Seq("ACTG"), Seq("AGTG"))
best = alignments[0]               # 分数最高的排在最前
print("score:", best.score)
print(best)                        # 打印比对文本
print(best.target, best.query)     # 比对的序列
print(best.aligned)                # 对齐坐标
```

## 打分矩阵

```python
from Bio.Align import substitution_matrices

m = substitution_matrices.load("BLOSUM62")   # 蛋白
# m = substitution_matrices.load("NUC.4.4")  # DNA
aligner = Align.PairwiseAligner()
aligner.substitution_matrix = m
aligner.mode = "local"
```

## 多序列比对（AlignIO）

```python
from Bio import AlignIO

aln = AlignIO.read("aligned.fa", "fasta")     # 或 clustal / stockholm / phylip / emboss
print(len(aln), aln.get_alignment_length())
for record in aln:
    print(record.id)
print(aln[0].seq)                 # 第一条对齐后序列（含 gap）

# 格式转换
AlignIO.convert("in.clustal", "clustal", "out.fa", "fasta")

# 转成 Align 对象做进一步分析
from Bio import Align
align = Align.read("aligned.fa", "fasta")
print(align.column_annotations)   # 列注释（可选）
```

## 一致性序列 / 保守列

```python
from Bio import AlignIO
from Bio.Align import AlignInfo

aln = AlignIO.read("aln.fa", "fasta")
summary = AlignInfo.SummaryInfo(aln)
print(summary.dumb_consensus())          # 简单多数一致序列
print(summary.gap_consensus())           # 含 gap 的一致序列
print(summary.pos_specific_score_matrix())  # 位置特异性打分矩阵
```

## 要点

- `PairwiseAligner` 支持多序列比对：直接 `aligner.align(seq1, seq2, seq3, ...)`。
- 大文件比对结果很占内存，必要时逐条处理。
- SAM/BAM 请用 `Bio.Align.read("file.sam", "sam")`（新版 API），不是 `AlignIO`。
