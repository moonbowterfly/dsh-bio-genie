---
language: python
---

# dsh-bio 核心工作流（许愿式生信分析）

dsh-bio 把「生物信息学分析」变成「许愿式编程」：你描述想要的结果，我把这个愿望翻译成一段 Biopython Python 程序，通过 `bio_python` 工具执行，再根据输出迭代，直到得到正确结果。

## bio_python 工具契约

- `code`：完整 Python 源码。程序在**会话工作区**下运行，相对路径读写会话工作区内的文件；会话工作区未指定时使用保底工作区 `~/deepseek-harness/bio-genie-workspace`（自动创建）。可用 `workdir` 参数显式指定其他目录（绝对路径，或相对默认工作区的相对路径）。
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

## 失败与自愈（与主 skill ACR 三层职责对齐）

`bio_python` 失败时返回 `needs_repair: true` + 完整 stderr。**严格遵守三层职责边界**（详见主 skill `dsh-bio-genie` 的 ACR 章节）：

- **L1 插件自愈**：当前**不实现任何自动重试**——所有失败透传到 stderr。若后续插件加了白名单自愈，stderr 必追加 `[bio-genie self-healed: <动作>]` 提示。
- **L2 记忆复用**：失败后**先 `bio_memory action=lessons` 查同类修复经验**，命中 fix_hint 即套用再调（最多试 1 次）。
- **L3 agent 自愈**：L1/L2 未覆盖时，**读 stderr → 改 code → 再调**，最多 2 次修复（共 3 次尝试）。
- **终止**：3 次仍失败 → 如实报告（错误原文 + 已尝试的修复），绝不编造结果。

**ImportError 的特殊处理**：先跑 `bio_env` 看环境状态——若提示环境就绪却仍缺包，**这是插件 bug 不是任务 bug**，停止自愈并报告插件 bug（不要自行 pip install，违反「零安装」原则；除非插件代码本身定义了白名单自动补装）。

## 常见坑

- `Bio.SeqIO.parse()` 是生成器：多次复用请先 `list(...)`。
- 现代 Biopython 的 `Seq` 不再带 alphabet；直接用 `.translate()` / `.transcribe()`。
- NCBI/在线服务需要网络与邮箱（见 `bio-entrez`、`bio-blast`）。
- 遇到 `ImportError` 先跑 `bio_env` 看环境状态，必要时 `reinstall`。
- ⚠️ **不要用 dsh 的 bash/pwsh 直接调 venv python**：宿主进程的 `PYTHONPATH` 会污染导入路径（可能加载到错误平台的 numpy 等）。所有代码都走 `bio_python` 工具（它已用 `-I` 隔离环境）；确需安装 Python 包时，用 `bio_env` 的状态/安装能力，或在 `bio_python` 内 `import subprocess` 且显式清空 `PYTHONPATH`。
- ⚠️ **绘图库已随环境预装**（matplotlib/reportlab，见 `python/requirements.txt`）；若旧环境缺失，`bio_env` reinstall 即可，不要手工 ensurepip 装 pip（uv 环境默认无 pip，2026-08-17 实测踩坑）。

先按需加载领域技能（`bio-io`、`bio-seq`、`bio-align` …）再写非平凡代码。
