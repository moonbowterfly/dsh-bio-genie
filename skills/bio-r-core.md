---
language: r
---

# R 执行器核心（bio_r）

> 与 bio_python 对称的 R 生态入口。加载任何 R 分析任务前先读本 skill。

## 环境事实（牢记）

- **固定版本对**：R 4.6.1 ↔ Bioconductor 3.23（引导器锁定，不随上游漂移）。
- 核心包已预装（私有库 `~/.dsh/dsh-bio-genie/r-lib/`，`bio_r_env` 可查版本）：DESeq2 / edgeR / limma / fgsea / msigdbr（MSigDB 基因集） / Rtsne / phyloseq / Biostrings / GenomicRanges / SummarizedExperiment / ggplot2 / ggtree / ComplexHeatmap / dplyr / tibble / readr / jsonlite。
- **不在环境里**（如实告知，别引导用户装）：clusterProfiler（依赖 GO.db 在 Bioc 3.23 无 Windows 二进制）、org.Hs.eg.db、ape 之外的重生态包、Bioc 源码编译包。
- 首次 bio_r 调用会惰性引导 R 环境（约 5-20 分钟）——提前告知用户等待。

## 执行契约

- `code`：完整 R 源码；`print()`/`cat()` → stdout；错误 → stderr 且 `needs_repair: true`。
- `result <- <JSON 可序列化值>` → 结构化返回（**推荐用命名 list**：`result <- list(n = 10, top = head(res, 5))`；data.frame 也会被 JSON 化）。
- 工作目录 = 会话工作区；大输出写 CSV/PNG 文件并报告绝对路径。
- 每次调用是**全新 R 进程**：变量不跨调用；包加载慢（DESeq2 首次 ~10s），默认超时 120s，长任务传 `timeoutMs`。
- 失败判定：stderr 出现 `Error ...` 或 `Execution halted` → needs_repair，修复重试（最多 3 次）。

## 与 bio_python 的分工

| 任务 | 引擎 |
|---|---|
| 差异表达（DESeq2/edgeR/limma） | **R** |
| GSEA 排序富集（fgsea + msigdbr） | **R** |
| 微生物组多样性（phyloseq） | **R** |
| 基因组区间运算（GenomicRanges） | **R** |
| t-SNE 降维 / 层次聚类 | **R** |
| ggtree / ComplexHeatmap | **R** |
| 序列 IO/比对/BLAST/Entrez/结构/建树/统计图 | **Python** |
| 列表型通路富集（ORA） | **Python**（bio_enrichr） |

两个引擎可在同一任务里协作（Python 预处理 → R 分析 → Python 出图），用工作区文件衔接。

## 代码模板库

### 读写 CSV
```r
suppressPackageStartupMessages({ library(readr); library(dplyr) })
df <- read_csv("input.csv", show_col_types = FALSE)
# ... 分析 ...
write_csv(result_df, "output.csv")
```

### data.frame 操作
```r
# 筛选 + 排序
filtered <- df %>% filter(padj < 0.05) %>% arrange(log2FoldChange)
# 分组汇总
summary <- df %>% group_by(condition) %>% summarise(mean_val = mean(value), n = n())
# 长宽转换
long_df <- pivot_longer(df, cols = starts_with("sample"), names_to = "sample", values_to = "count")
```

### 结构化返回
```r
# 简单统计
result <- list(n = nrow(df), mean = mean(df$value), sd = sd(df$value))
# 带表格
result <- list(
  summary = list(n = nrow(df), n_sig = sum(df$padj < 0.05)),
  top_genes = head(df %>% arrange(padj), 10),
  output_file = "results.csv"
)
```

## 自动代码修复（ACR）信号表

| stderr 信号 | 修法 |
|---|---|
| `there is no package called 'X'` | X 不在核心包 → 换等效实现或如实告知 |
| `could not find function "X"` | 拼写/忘记 library(X)；或 `pkg::fun` |
| `object 'X' not found` | 变量未定义/作用域问题 |
| `unused argument` | 函数签名不对 → `?fun` 查帮助 |
| `subscript out of bounds` | 索引越界 |
| `cannot open file 'X'` | 路径问题 |
| `Error in contrasts`（DESeq2） | 分组列不是 factor → `as.factor()` |
| `NaNs produced` | 数学运算异常（log 负数、除零）→ 检查数据 |
| `replacement has length zero` | 替换值为空 → 检查筛选条件 |

## 高频陷阱

- R 4.0+ 默认 `stringsAsFactors = FALSE`——字符列不会自动变 factor。
- `as.matrix()` 对含字符列的 data.frame 会全部转字符！先 `column_to_rownames`。
- `result` 里不要放 S4 对象（JSON 序列化会降级）——转成 list/data.frame。
- 中文标签绘图：**优先用 Python figurelib**（CJK 已解决），R 绘图默认英文标签。
- 打印大对象截断：用 `head()` / `slice_head(n=10)`；输出全表写 CSV。
- S4 对象（DESeqDataSet 等）不要放进 `result`——JSON 无法序列化。
