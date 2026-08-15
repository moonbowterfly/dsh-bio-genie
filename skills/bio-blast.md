# BLAST 搜索（Bio.Blast）

NCBI BLAST 在线服务与结果解析。**注意：需要网络访问，且受速率限制。**

## 在线 BLAST（NCBIWWW.qblast）

```python
from Bio.Blast import NCBIWWW
from Bio.Seq import Seq

query = Seq("MKLVWDTVLKGKKI")
handle = NCBIWWW.qblast(
    "blastp",         # 程序: blastn/blastp/blastx/tblastn/tblastx
    "nr",             # 数据库: nr/nt/swissprot/refseq_protein...
    query,            # 查询序列（Seq 对象或 FASTA 字符串）
    hitlist_size=10,  # 返回前 N 条
    expect=10.0,      # E 值阈值
)
with open("blast.xml", "w") as f:
    f.write(handle.read())
handle.close()
```

## 解析 BLAST XML 结果（NCBIXML）

```python
from Bio.Blast import NCBIXML

with open("blast.xml") as f:
    record = NCBIXML.read(f)      # 单个查询；多个查询用 NCBIXML.parse

print("query:", record.query)
for align in record.alignments:
    for hsp in align.hsps:
        print(align.hit_id, align.hit_def[:40],
              "evalue=", hsp.expect, "score=", hsp.score,
              "ident=", hsp.identities, "len=", hsp.align_length)
```

## 提取比对命中序列区间

```python
from Bio.Blast import NCBIXML

with open("blast.xml") as f:
    record = NCBIXML.read(f)
for align in record.alignments:
    hsp = align.hsps[0]
    print("query span:", hsp.query_start, hsp.query_end)
    print("hit span:", hsp.sbjct_start, hsp.sbjct_end)
```

## 要点

- 结果 XML 会很大；先写盘再解析，别塞进 stdout。
- `qblast` 偶发超时/限流，可加 `time.sleep()` 重试。
- 比 `hsp.expect`（E 值）与 `hsp.identities / hsp.align_length`（一致率）。
- 本地 BLAST 需 `blast+` 二进制，Biopython 仅提供 `Bio.Blast.Applications` 封装，不内置引擎。
