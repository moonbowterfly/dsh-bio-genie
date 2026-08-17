---
language: python
---

# bio_python 编程指南

> bio_python 是兜底执行器：语义化工具覆盖不到的一切都在这里写代码完成。本指南让你写对、写快、少自愈。

## 1. 执行契约（务必背下来）

- **code**：完整 Python 源码。程序以**会话工作区**为工作目录（workdir 参数可覆盖）。
- `print()` → 返回的 `stdout`；异常 traceback → `stderr`，且 `needs_repair: true`。
- `result = <JSON 可序列化值>` → 直接作为结构化返回值给你（小结果用它；dict/list/数字/字符串都行）。
- **大输出写文件**（.fa/.tsv/.png/.csv），报告绝对路径——stdout 超过 1MB 会被截断。
- 超时默认 60s；大任务显式传 `timeoutMs`（如 180000）。
- 每次调用是**全新进程**：不能跨调用共享变量，也不能把 matplotlib Figure 对象传给别的工具（fig 工具都是文件级接口）。
- 隔离模式 `-I`：插件自己的 python 目录（含 `figurelib` 包）已在 sys.path，可直接 import；工作区目录**不在** sys.path（读文件用 open/相对路径没问题）。

## 2. 可用库（全部已预装，无需安装）

| 库 | 用途 |
|---|---|
| `Bio.*` | Biopython 全模块（Seq/SeqIO/Align/Blast/Entrez/Phylo/PDB/motifs/Restriction/PopGen/Graphics/SearchIO…） |
| `numpy` / `pandas` | 数值/表格（pandas 3.x：read_csv/groupby/corr 均可用） |
| `scipy` | 统计检验、数值算法（ttest_ind/mannwhitneyu/pearsonr/…） |
| `matplotlib` | 底层绘图（Agg 后端自动可用，无需 display） |
| `seaborn` | 高层统计图（barplot/boxplot/violinplot/heatmap/pairplot） |
| `PIL`（Pillow） | 图像读写（灰度预览、DPI 读取） |
| `reportlab` + `rlPyCairo` | GenomeDiagram 渲染 PNG 的后端 |
| `figurelib.*` | **出版级绘图库**（吸收 scipilot）：`setup_style` / `profile_data` / `export_figure` / `check_figure` / `layout_tools` / `visual_qa` |

不在环境里、也不要引导用户安装：torch/scanpy/rdkit/ete3/gseapy/plotly 等重依赖——见 troubleshooting 的边界表。

## 3. 代码模板速查

```python
# 读文件（绝对路径）
from Bio import SeqIO
records = list(SeqIO.parse(r'D:/data/genes.fasta', 'fasta'))   # parse 是生成器，先 list()

# 写文件
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord
from Bio import SeqIO
SeqIO.write([SeqRecord(Seq('ACGT'), id='x1', description='demo')], r'D:/data/out.fasta', 'fasta')

# 双序列比对
from Bio.Align import PairwiseAligner
aln = PairwiseAligner().align('ACGTACGT', 'ACGTTCGT')[0]
print(aln)

# 批量统计 + 结构化返回
stats = [{'id': r.id, 'gc': round(sum(1 for c in r.seq.upper() if c in 'GC') / len(r.seq) * 100, 2)}
         for r in records if len(r.seq) > 0]
result = {'n': len(stats), 'stats': stats[:20]}

# NCBI（bio_python 里直接调时必须自己守规矩）
from Bio import Entrez
Entrez.email = 'shuaihao264@gmail.com'     # 必设！
Entrez.tool = 'dsh-bio-genie'
import time
handle = Entrez.esearch(db='nucleotide', term='NM_007294', retmax=1)
time.sleep(0.4)                            # 3 req/s 限流：请求间留间隔
```

## 4. 自动代码修复（ACR）

失败返回 `needs_repair: true` 时，读 stderr 修复重试，**不要第一次失败就放弃**（最多修 2 次、共 3 次尝试）：

| stderr 信号 | 修法 |
|---|---|
| `ModuleNotFoundError: No module named 'xxx'` | 拼写错误就改；若是真缺包先 `bio_env`（reinstall=true） |
| `ImportError: cannot import name 'X'` | 现代 Biopython 无 alphabet：直接用 `Seq.translate()`；别用 `from Bio.Alphabet import ...` |
| `HTTPError: 429` / `ConnectionError` | 代码里 `time.sleep(0.4)` 后重试；NCBI 3 req/s |
| `FileNotFoundError` | 路径问题：相对路径基于工作区；不确定就用绝对路径 |
| `KeyError` / `AttributeError` / `IndexError` | 读 stderr 行号检查数据结构（如 esummary 的包装层） |
| `TranslationError`（模糊密码子） | 翻译前把 X/gap 替换为 N |

3 次尝试后仍失败：停止，如实向用户报告错误与已尝试的修复，**绝不编造结果**。

## 5. 会话记忆（越用越聪明）

- 写非平凡代码前：`bio_memory action=patterns query=...` 查有无同类成功模板。
- 失败时：`bio_memory action=lessons` 查错误签名，命中直接套 fix_hint。
- 你的成功代码与失败→修复配对会被自动沉淀，下次同类任务直接受益。

## 6. 网络与限流（代码内自查）

- 语义化工具的限流插件已内置；**bio_python 代码里的网络请求自己守规矩**。
- NCBI：`Entrez.email` 必设；3 req/s（sleep ≥0.34s）；批量任务用 `bio-proto-entrez-batch` 模板。
- Ensembl REST：需要 User-Agent 头；直连优先、失败回退代理（见 ref_genome op 的写法）。
- 代理环境部分域名（rest.ensembl.org）对代理失效——直连 `urllib.request.ProxyHandler({})` 优先。
- 大数据下载（基因组 FASTA）如实告知用户体积，走 `bio_ref_genome` 的 download_urls。

## 7. 高频陷阱

- `SeqIO.parse()` 是生成器，复用前 `list()`。
- 现代 Biopython `Seq` 无 alphabet；`GC()` 已改名 `gc_fraction()`（返回 0-1 小数）。
- `SeqIO.write` 需要 SeqRecord 列表，不能直接传 Seq。
- 中文 Windows 下文件可能 GBK 编码——读写用 `encoding='utf-8', errors='replace'` 或先按字节读再降级解码（bio_seq_io_read 已内置容错）。
- matplotlib 保存中文图：先 `from figurelib.setup_style import setup_style; setup_style(lang='zh')`（找不到 CJK 字体会抛清晰错误，先 `bio_fig_qa` 探测）。
- 统计结论必须带检验（scipy）+ 校正（见 bio-proto-statistics）；误差棒图注写 SD/SEM/CI+n。
