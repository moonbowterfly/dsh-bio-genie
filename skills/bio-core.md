# dsh-bio 核心工作流（许愿式生信分析）

dsh-bio 把「生物信息学分析」变成「许愿式编程」：你描述想要的结果，我把这个愿望翻译成一段 Biopython Python 程序，通过 `bio_python` 工具执行，再根据输出迭代，直到得到正确结果。

## bio_python 工具契约

- `code`：完整 Python 源码。程序在**工作区目录**下运行，相对路径读写工作区内的文件。
- `print()` 的内容进入返回结果的 `stdout`；异常进入 `stderr`。
- 给顶层变量 `result` 赋值可返回结构化数据（JSON 可序列化即可），工具会原样交回。
- 大结果（多序列、表格、图）请写文件（`.fa` / `.tsv` / `.png`）并报告路径，不要往 stdout 倾倒大量文本。

## 标准流程

1. 用文件工具确认输入文件：文件名、格式（后缀）、大概大小（`head` 查看前几行）。
2. 写一段自包含程序完成一步分析，`bio_python` 运行。
3. 读结果、修错误、迭代。
4. 把最终产物写进工作区，汇报结论和确切文件路径。

## Biopython 基础对象

```python
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord
from Bio import SeqIO

s = Seq("ATGAAACGCATTAGCA")
r = SeqRecord(s, id="my_seq", name="demo", description="a demo sequence")
print(len(r), r.seq, r.id)
```

- `Seq`：不可变序列对象，支持切片、`+`、`.complement()`、`.reverse_complement()`、`.transcribe()`、`.translate()`。
- `SeqRecord`：`id` / `name` / `description` / `seq` / `features` / `annotations` / `letter_annotations`。
- `SeqFeature`：`type` / `location` / `qualifiers`，GenBank/EMBL 注释都挂在 `record.features` 上。

## 常见坑

- `Bio.SeqIO.parse()` 是生成器：多次复用请先 `list(...)`。
- 现代 Biopython 的 `Seq` 不再带 alphabet；直接用 `.translate()` / `.transcribe()`。
- NCBI/在线服务需要网络与邮箱（见 `bio-entrez`、`bio-blast`）。
- 遇到 `ImportError` 先跑 `bio_env` 看环境状态，必要时 `reinstall`。

先按需加载领域技能（`bio-io`、`bio-seq`、`bio-align` …）再写非平凡代码。
