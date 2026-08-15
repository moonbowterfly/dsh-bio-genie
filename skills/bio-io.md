# 序列文件读写（Bio.SeqIO）

`Bio.SeqIO` 是读写序列文件（FASTA/FASTQ/GenBank/EMBL/Swiss-Prot 等）的统一入口。

## 常用格式

| 格式 | 说明 |
|------|------|
| `fasta` | 纯序列 + 标题 |
| `fastq` | 带测序质量 |
| `genbank` / `gb` | 富注释（feature 表） |
| `embl` | EMBL 注释格式 |
| `swiss` | Swiss-Prot / UniProtKB 文本 |
| `fastq-sanger` / `fastq-illumina` / `fastq-solexa` | 不同质量编码 |

## 读取

```python
from Bio import SeqIO

# 逐个读（省内存，适合大文件）
for record in SeqIO.parse("input.fa", "fasta"):
    print(record.id, len(record.seq))

# 读单条记录
rec = SeqIO.read("single.gb", "genbank")

# 全部读入内存
records = list(SeqIO.parse("input.fa", "fasta"))
```

## 过滤与转换

```python
from Bio import SeqIO

# 按长度/关键词过滤后另存
long_records = [r for r in SeqIO.parse("in.fa", "fasta") if len(r.seq) > 1000]
SeqIO.write(long_records, "long.fa", "fasta")

# 格式转换：FASTA -> GenBank 需要先构造记录
with open("out.gb", "w") as out:
    for r in SeqIO.parse("in.fa", "fasta"):
        SeqIO.write(r, out, "genbank")   # 会因缺少注释而失败，见下
```

## 批量格式转换（保留能保留的）

```python
from Bio import SeqIO

# GenBank -> FASTA（提取序列）
SeqIO.convert("in.gb", "genbank", "out.fa", "fasta")

# FASTA -> FASTQ（造一个占位质量）
SeqIO.convert("in.fa", "fasta", "out.fq", "fastq")
```

## 统计 / 摘要

```python
from Bio import SeqIO

n = 0
total = 0
for r in SeqIO.parse("in.fa", "fasta"):
    n += 1
    total += len(r.seq)
print(f"{n} sequences, {total} bp total")
```

## 要点

- `parse` 生成器读完即耗；`SeqIO.index("in.fa", "fasta")` 可随机访问大文件（内存映射）。
- 写文件时务必先 `open(..., "w")`，`SeqIO.write` 接受句柄或路径。
- 中文/特殊字符 id 在部分格式会触发告警，可 `r.id = r.id.split()[0]` 清理。
