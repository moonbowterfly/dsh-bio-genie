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

- `PairwiseAligner` **只支持双序列**（签名 `align(seqA, seqB, strand='+')`；Biopython 1.88 实测：传入第 3 条序列会被当作 `strand` 参数，报 `ValueError: strand must be '+' or '-'`）。多序列需求三条路：① 有 clustalw/muscle → 用 `bio_msa`（缺二进制时返回 `program_missing` + 安装提示，不是静默失败）；② 只是要建树 → **跳过 MSA**：逐对全局比对得距离矩阵直接建树（距离法只需要两两距离）；③ 要真 MSA 文件 → 自写渐进式合并（以最完整序列为锚逐条比对、按坐标合并），并标注为近似比对。
- 大文件比对结果很占内存，必要时逐条处理。
- SAM/BAM 请用 `Bio.Align.read("file.sam", "sam")`（新版 API），不是 `AlignIO`。

## 验收标准

- [ ] 路线选择正确：双序列用 `PairwiseAligner`；多序列先试 `bio_msa`（clustalw/muscle），二进制缺失时按 `program_missing` 提示走降级路线并**明示降级**——绝不静默伪称做过 MSA
- [ ] 手工/近似比对（逐对合并、星形锚定等）**显著标注为近似**，并报告列数、gap 列数与可变位点数
- [ ] 参数（mode / match / mismatch / gap 罚分，或矩阵名）随结果报告，结果可复现
- [ ] 比对产物落盘为**等同长**的对齐文件（FASTA/Clustal），完整路径写进报告，供下游建树/共识直接消费
- [ ] 序列长度差 >20% 时先做质量处理（剪裁/剔除）并说明理由，不用未处理数据直接出结论
