---
language: r
---

# R 核心数据结构（Biostrings / GenomicRanges / SummarizedExperiment）

> 来源：Bioconductor 3.23 官方包文档与 vignette（原创整理）。Bioconductor 的核心设计是**统一 S4 数据结构**——先懂对象模型，再记函数（Bioconductor 官方学习报告的核心建议）。

## 1. Biostrings：序列对象（对应 Python 的 Bio.Seq）

```r
library(Biostrings)

# 读 FASTA 全部序列
seqs <- readDNAStringSet("genes.fasta")      # DNAStringSet 对象
seqs[1]                                       # 单条 DNAString
width(seqs)                                   # 全部长度向量
letterFrequency(seqs[[1]], letters = "GC")    # GC 计数
reverseComplement(seqs[[1]])                  # 反向互补
translate(DNAString("ATGAAATAA"))             # 翻译（AAString）

# 常用函数：subseq(截取) / matchPattern(找motif) / vcountPattern / reverse / complement
```

- DNAString / RNAString / AAString = 单序列；XStringSet = 序列集（批量操作向量化，快）。
- 含 IUPAC 模糊碱基天然支持；X/gap 不会崩。
- 大 FASTA 用 `readDNAStringSet(..., format="fasta")` 一次性读入内存——超大文件先 `fasta.index` 按需取。

## 2. GenomicRanges：基因组区间（对应 BED/GFF 操作）

```r
library(GenomicRanges)

# 构造 GRanges（1-based 闭区间，同 GFF！与 BED 的 0-based 半开不同——见 bio-proto-coords）
gr <- GRanges(seqnames = "chr1",
              ranges = IRanges(start = c(100, 300), end = c(200, 400)),
              strand = c("+", "-"),
              gene = c("A", "B"))            # mcols 放注释列

findOverlaps(gr, gr2)                        # 区间重叠（Hits 对象 → queryHits/subjectHits）
reduce(gr)                                   # 合并重叠区间
coverage(gr)                                 # 覆盖度（Rle）
resize(gr, width = 100, fix = "start")       # 区间扩展
seqinfo(gr) <- Seqinfo(seqnames = "chr1", seqlengths = 2.5e8)  # 装配染色体长度（防越界）

# 转 data.frame：as.data.frame(gr)
```

- 坐标纪律：GRanges 是 **1-based 闭区间**；BED 文件读入（rtracklayer 不在核心包）时先用 bio-proto-coords 的换算规则。
- 区间运算全程向量化——几千个区间毫秒级。

## 3. SummarizedExperiment：组学数据容器（DESeq2 的基础）

```r
library(SummarizedExperiment)

# 结构：assay(表达矩阵) + colData(样本注释) + rowData(特征注释)
se <- SummarizedExperiment(
  assays = list(counts = counts_matrix),     # 整数矩阵：基因 × 样本
  colData = data.frame(condition = c("ctrl","ctrl","trt","trt")),
  rowData = data.frame(gene_id = rownames(counts_matrix))
)
assay(se)                                    # 取矩阵
colData(se)$condition                        # 取样本注释
se[, se$condition == "trt"]                  # 按样本子集
```

- 理解这个容器 = 理解 DESeq2/edgeR 的输入输出：**DESeqDataSet 是 SummarizedExperiment 的子类**（对象模型：counts → DESeqDataSet → DESeq() → results()，而非孤立函数）。
- 基因 ID 统一放 rownames（矩阵）与 rowData；样本注释放 colData，分组列必须 factor。

## 与 Python 侧对应关系

| 概念 | R/Bioc | Python |
|---|---|---|
| 序列对象 | DNAString / XStringSet | Bio.Seq.Seq / SeqIO |
| 区间对象 | GRanges（1-based 闭） | 手工/GenomeDiagram |
| 组学容器 | SummarizedExperiment | pandas 矩阵 + 注释表 |
| 差异表达 | DESeq2/edgeR/limma | 无（pydeseq2 未内置） |
