---
language: python
---

# NCBI E-utilities（Bio.Entrez）

通过 NCBI 检索/下载序列、taxonomy、文献。**必须设置 `email`，且需网络。**

## 前置

```python
from Bio import Entrez
Entrez.email = "researcher@example.com"   # NCBI 强制要求
Entrez.tool = "dsh-bio"                    # 可选，标识你的应用
```

## 检索与下载序列

```python
from Bio import Entrez, SeqIO

# esearch: 搜索 accession 或关键词
handle = Entrez.esearch(db="nucleotide", term="MKLVWDTVLKGKKI[Protein Name]", retmax=5)
record = Entrez.read(handle)
handle.close()
ids = record["IdList"]
print("count:", record["Count"], "ids:", ids)

# efetch: 按 id 下载 FASTA / GenBank
handle = Entrez.efetch(db="nucleotide", id=ids, rettype="fasta", retmode="text")
seqs = list(SeqIO.parse(handle, "fasta"))
handle.close()
for s in seqs:
    print(s.id, len(s.seq))

# 下载 GenBank 注释
handle = Entrez.efetch(db="nucleotide", id=ids, rettype="gb", retmode="text")
records = list(SeqIO.parse(handle, "genbank"))
handle.close()
```

## esummary / elink

```python
from Bio import Entrez

handle = Entrez.esummary(db="nucleotide", id="NC_005816")
summary = Entrez.read(handle)
handle.close()
print(summary[0]["Title"])

# elink: 从一个 db 链接到另一个（如蛋白 -> 基因）
handle = Entrez.elink(dbfrom="protein", db="gene", id="NP_123456")
links = Entrez.read(handle)
handle.close()
```

## Taxonomy

```python
from Bio import Entrez

handle = Entrez.efetch(db="taxonomy", id="9606", rettype="xml", retmode="text")
tax = Entrez.read(handle)
handle.close()
print(tax[0]["ScientificName"], tax[0]["Rank"])
```

## 要点

- `Entrez.read()` 解析 XML，`Entrez.parse()` 用于流式多记录。
- 每个请求之间加 `time.sleep(0.34)`（NCBI 限制 3 req/s，不设 email 则 3 req/s 也会更快封）。
- 出错会抛 `HTTPError`（如 `400 Bad Request`），捕获并重试。
- 批量下载用 `id=ids`（逗号分隔）一次取回，比循环单条高效。
