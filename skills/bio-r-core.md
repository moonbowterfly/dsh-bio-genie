---
language: r
---

# R 执行器核心（bio_r）

> 与 bio_python 对称的 R 生态入口。加载任何 R 分析任务前先读本 skill。

## 环境事实（牢记）

- **固定版本对**：R 4.6.1 ↔ Bioconductor 3.23（引导器锁定，不随上游漂移）。
- 核心包已预装（私有库 `~/.dsh/dsh-bio-genie/r-lib/`，`bio_r_env` 可查版本）：DESeq2 / edgeR / limma / fgsea / msigdbr（MSigDB 基因集，免手写 GMT） / Rtsne（t-SNE 降维） / phyloseq / Biostrings / GenomicRanges / SummarizedExperiment / ggplot2 / ggtree / ComplexHeatmap / dplyr / tibble / readr / jsonlite。
- **不在环境里**（如实告知，别引导用户装）：clusterProfiler（依赖 GO.db 在 Bioc 3.23 无 Windows 二进制，上游缺口——富集用 fgsea/ORA 用 bio_enrichr）、org.Hs.eg.db（enrichGO 需要）、ape 之外的重生态包、Bioc 源码编译包（无 Rtools 工具链，二进制优先策略）。
- 首次 bio_r 调用会惰性引导 R 环境（下载 R + 核心包，约 5-20 分钟）——提前告知用户等待，**不要重复调用**。

## 执行契约（与 bio_python 完全同构）

- `code`：完整 R 源码；`print()`/`cat()` → stdout；错误 → stderr 且 `needs_repair: true`。
- `result <- <JSON 可序列化值>` → 结构化返回（**推荐用命名 list**：`result <- list(n = 10, top = head(res, 5))`；data.frame 也会被 JSON 化）。
- 工作目录 = 会话工作区；大输出写 CSV/PNG 文件并报告绝对路径。
- 每次调用是**全新 R 进程**：变量不跨调用；包加载慢（DESeq2 首次 load 约 10s），默认超时 120s，长任务显式传 `timeoutMs`。
- 失败判定：stderr 出现 `Error ...` 或 `Execution halted` → needs_repair，修复重试（最多 3 次尝试）。

## 与 bio_python 的分工（双引擎路由）

| 任务 | 引擎 |
|---|---|
| 差异表达（DESeq2/edgeR/limma） | **R** |
| GSEA 排序富集（fgsea + msigdbr 基因集） | **R** |
| 微生物组多样性（phyloseq） | **R** |
| 基因组区间运算（GenomicRanges） | **R**（小规模 Python 亦可） |
| t-SNE 降维 / 层次聚类 | **R**（Rtsne + cluster） |
| ggtree 系统发育树图 / ComplexHeatmap | **R** |
| 序列 IO/比对/BLAST/Entrez/结构/建树/出版级统计图 | **Python**（bio_python + figurelib） |
| 列表型通路富集（ORA） | **Python**（bio_enrichr，更快更省） |

原则：先看任务命中的是哪个生态的权威实现，再选引擎；两个引擎可在同一任务里协作（Python 预处理 → R 分析 → Python 出图），用工作区文件衔接。

## 自动代码修复（ACR）信号表

| stderr 信号 | 修法 |
|---|---|
| `there is no package called 'X'` | X 不在核心包 → 换核心包等效实现，或如实告知边界（bio_r_env 查清单） |
| `could not find function "X"` | 拼写/忘记 library(X)；或 X 在未加载的依赖包里 → `pkg::fun` |
| `object 'X' not found` | 变量未定义/作用域问题（for 循环内赋值要 `<-` 到外层） |
| `unused argument` | 函数签名不对 → `?fun` 查帮助（`args(fun)`） |
| `subscript out of bounds` / `subscript too large` | 索引越界（数据框行列数核实） |
| `cannot open file 'X'` | 路径问题：工作区相对路径或绝对路径 |
| `Error in contrasts`（DESeq2） | 分组列不是 factor / 水平数不足 → `as.factor()` |

## 高频陷阱

- R 4.0+ 默认 `stringsAsFactors = FALSE`——读表得到的字符列不会自动变 factor；DESeq2 的分组列要手动 `as.factor()`。
- 读用户 CSV 用 readr：`readr::read_csv("data.csv", show_col_types = FALSE)`；中文 Windows 文件编码问题用 `read_csv(file, locale = locale(encoding = "UTF-8"))`。
- 生物矩阵行名：`as.data.frame(m)` 前确认 `rownames`；DESeq2 需要整数 counts 矩阵（不要有小数）。
- 打印大对象截断：`head()` / `dplyr::slice_head(n=10)`；输出全表就写 CSV。
- 中文标签绘图（ggplot2）：Windows 下需 `showtext`（不在核心包）——**中文图优先用 Python figurelib**（CJK 已解决），R 绘图默认英文标签。
- `result` 里不要放 S4 对象（JSON 序列化会降级为 str 摘要）——转成普通 list/data.frame 再赋值。

## 推荐代码骨架

```r
suppressPackageStartupMessages({
  library(dplyr)
  library(readr)
})
df <- read_csv("input.csv", show_col_types = FALSE)
# ... 分析 ...
result <- list(n = nrow(df), preview = head(df, 5))
```
