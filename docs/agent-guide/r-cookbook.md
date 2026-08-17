---
language: r
---

# R 编程指南（bio_r）

> bio_r 是 R/Bioconductor 生态的执行器，与 bio_python 完全对称。本指南让你把 R 代码写对、写快、少自愈。领域配方在 `bio-r-*` skill，本指南是通用规范。

## 1. 执行契约（与 bio_python 同构）

- **code**：完整 R 源码；工作目录 = 会话工作区（workdir 可覆盖）。
- `print()`/`cat()` → stdout；错误 → stderr 且 `needs_repair: true`（判定信号：`Error` / `Execution halted`）。
- `result <- <JSON 可序列化值>` → 结构化返回（推荐**命名 list**；data.frame 会转 JSON；S4 对象会降级为 str 摘要——不要放 S4 进 result）。
- 每次调用是**全新 R 进程**：变量不跨调用；DESeq2 等包加载 ~10s，默认超时 120s，重分析传大 `timeoutMs`。
- 大输出写 CSV/PNG 到工作区并报告绝对路径，别 print 全表。

## 2. 环境与包清单

- **R 4.6.0 + Bioconductor 3.23**（版本对锁定，引导器固定）。
- 核心包（`bio_r_env` 可查版本）：DESeq2、edgeR、limma、fgsea、phyloseq、Biostrings、GenomicRanges、SummarizedExperiment、ggplot2、ggtree、ComplexHeatmap、dplyr、tibble、readr、jsonlite。
- **不在核心集**（如实告知，不引导用户手动装）：clusterProfiler（其依赖 GO.db 在 Bioc 3.23 无 Windows 二进制，上游缺口——R 侧富集用 fgsea，ORA 用 Python bio_enrichr）、org.Hs.eg.db / org.Mm.eg.db、showtext（中文 ggplot）、biomformat、rtracklayer、源码编译包（无 Rtools）。
- 首次 bio_r 调用惰性引导（下载 R + 核心包 5-20 分钟）——提前告知用户，不要重复调用。

## 3. 代码模板速查

```r
# 骨架
suppressPackageStartupMessages({
  library(dplyr); library(readr)
})

# 读表（中文 Windows 编码问题用 locale 指定 UTF-8）
df <- read_csv("input.csv", show_col_types = FALSE)
df2 <- read_csv("gbk.csv", show_col_types = FALSE, locale = locale(encoding = "GBK"))

# 写表
write_csv(df, "output.csv")

# 序列（Biostrings）
library(Biostrings)
seqs <- readDNAStringSet("genes.fasta")
width(seqs); letterFrequency(seqs[[1]], letters = "GC")
reverseComplement(seqs[[1]])

# 区间（GenomicRanges，1-based 闭区间！）
library(GenomicRanges)
gr <- GRanges("chr1", IRanges(start = c(100, 300), end = c(200, 400)))
findOverlaps(gr, gr2); reduce(gr)

# 统计（base R 足够）
t.test(x, y); wilcox.test(x, y); cor.test(x, y, method = "spearman")

# 结构化返回
result <- list(n = nrow(df), p_value = t$p.value, top = head(df, 5))
```

## 4. 自动代码修复（ACR）信号表

| stderr 信号 | 修法 |
|---|---|
| `there is no package called 'X'` | 不在核心集 → 换等效实现或如实告知边界 |
| `could not find function "X"` | 缺 `library(X)`；或函数在依赖包里 → `pkg::fun` |
| `object 'X' not found` | 变量未定义/作用域（循环内赋值、拼写） |
| `unused argument` / `non-numeric argument` | 参数类型错 → `args(fun)`、`str(x)` 检查结构 |
| `subscript out of bounds` | 索引越界（矩阵/数据框维度核实） |
| `Error in contrasts`（DESeq2） | 分组列不是 factor → `as.factor()` |
| `cannot open file` | 路径：相对路径基于工作区，不确定用绝对路径 |
| `failed to load c++ shared library` | 包安装损坏 → `bio_r_env reinstall=true` |

3 次尝试后仍失败：停止并如实报告，绝不编造结果。

## 5. 与 Python 引擎协作

- 分工（主 skill 有完整路由表）：差异表达/GSEA/微生物组/GenomicRanges → R；序列/比对/结构/建树/出版级绘图/ORA → Python。
- 协作模式：**工作区文件衔接**——Python 预处理写 CSV → bio_r 读 CSV 分析 → 结果写 CSV/树文件 → Python figurelib 出中文出版图。
- 富集：基因列表 → Python `bio_enrichr`（内置库更快）；排序数据 → R fgsea（本引擎价值点）。

## 6. 高频陷阱

- `stringsAsFactors` 默认 FALSE（R 4.0+）——DESeq2 分组列手动 `as.factor()`。
- DESeq2 counts 必须**整数矩阵**；分组列样本名与矩阵列名一致。
- phyloseq：`otu_table(..., taxa_are_rows = TRUE)` 必须声明，维度反了下游全错。
- GenomicRanges 是 1-based 闭区间；BED 是 0-based 半开——跨格式先查 bio-proto-coords。
- 中文图：R 核心集无 showtext → **中文标签交给 Python figurelib**；R 图默认英文。
- result 别放 S4 对象（DESeqDataSet/GRanges 等）——转 list/data.frame。
- 包加载慢导致超时：先传大 timeoutMs（如 300000），再怀疑代码。
