---
language: python
---

# 搜索输出统一解析（Bio.SearchIO）

`Bio.SearchIO` 用一套统一对象模型解析 BLAST、HMMER、Exonerate 等搜索结果，避免为每种工具写不同的解析代码。

## 解析

```python
from Bio import SearchIO

# 格式: blast-xml / blast-tab / hmmer3-text / hmmer3-domtab / exonerate-text / interproscan-xml
results = list(SearchIO.parse("result.blast.xml", "blast-xml"))
for q in results:
    print("query:", q.id, "hits:", len(q))
```

## 浏览命中与 HSP

```python
from Bio import SearchIO

q = SearchIO.read("result.blast.xml", "blast-xml")
for hit in q:
    print(hit.id, hit.description[:40], "bitscore=", hit.bitscore, "evalue=", hit.evalue)
    for hsp in hit:
        print("  ", hsp.query_start, hsp.query_end, "->", hsp.hit_start, hsp.hit_end)
```

## 提取命中的比对序列

```python
from Bio import SearchIO

q = SearchIO.read("result.blast.xml", "blast-xml")
hit = q[0]
hsp = hit[0]
print(hsp.query.seq)   # 查询侧（含 gap）
print(hsp.hit.seq)     # 命中侧（含 gap）
```

## 常用字段速查

- `QueryResult`: `id`, `description`, `hits`, `seq_len`
- `Hit`: `id`, `description`, `bitscore`, `evalue`, `query_id`
- `HSP`: `query_start/end`, `hit_start/end`, `query.seq`, `hit.seq`, `ident_num`, `pos_num`

## 要点

- 文件大时用 `parse`（生成器）而非 `read`。
- `hit.evalue` 是浮点；极小值会显示为 `0.0`，用科学计数法打印。
- HMMER 结果里 HSP 代表一个 domain，别和 BLAST 的 HSP 混淆。
