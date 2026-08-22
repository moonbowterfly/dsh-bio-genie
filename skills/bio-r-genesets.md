---
language: r
---

# R 基因集分析（msigdbr + fgsea）

> 来源：msigdbr 官方 vignette + fgsea 官方 vignette（原创整理）。**消除 fgsea 手动下载 GMT 的痛点**——msigdbr 直接在 R 内提供 MSigDB 全部基因集，按物种/分类即时查询。

## 解决什么

旧流程：用户需从 MSigDB 官网手动下载 GMT 文件 → 读入 → fgsea。新流程：一行 `msigdbr()` 调用即获基因集，直接喂 fgsea。**零手动下载**。

## 对象模型

| 概念 | msigdbr 返回 | 说明 |
|------|-------------|------|
| 基因集 | `data.frame`（gs_name, gs_cat, gs_subcat, gene_symbol, entrez_gene, ...） | 每行 = 一个基因属于一个基因集 |
| 物种 | `species` 参数 | `"Homo sapiens"` / `"Mus musculus"` 等 |
| 分类 | `category` 参数 | `"H"` Hallmark / `"C1"`-`"C7"` / `"C8"` 等 |
| 亚分类 | `subcategory` 参数 | `"CP:KEGG"` / `"GO:BP"` 等（可选过滤） |

msigdbr 返回的是**长格式 data.frame**——同一基因在不同基因集里出现多次。fgsea 需要**命名列表**格式，用 `dplyr::group_by + summarise` 转换。

## 标准管道

### 管道 1：msigdbr → fgsea（排序 GSEA，最常用）

```r
suppressPackageStartupMessages({
  library(msigdbr)
  library(fgsea)
  library(dplyr)
})

# 1. 获取基因集（按物种 + collection）
gene_sets <- msigdbr(species = "Homo sapiens", collection = "C5", subcollection = "GO:BP")
# C5 = GO, C2 = CP (KEGG/Reactome), H = Hallmark

# 2. 转为 fgsea 格式：命名列表（gs_name → gene symbols）
pathways <- gene_sets %>%
  group_by(gs_name) %>%
  summarise(genes = list(unique(gene_symbol)), .groups = "drop") %>%
  { setNames(.$genes, .$gs_name) }

# 3. 排序列表（用户提供或从 DESeq2 结果生成）
# ranks = named numeric vector, names = gene symbols, values = rank stat (log2FC / t)
ranks <- sort(ranks, decreasing = TRUE)
ranks <- ranks[!is.na(ranks)]

# 4. 运行 fgsea
fgsea_res <- fgsea(pathways = pathways, stats = ranks,
                   minSize = 15, maxSize = 500, nPermSimple = 10000)
fgsea_res <- arrange(fgsea_res, pval)

# 5. 输出
result <- list(
  n_pathways = nrow(fgsea_res),
  top = head(select(fgsea_res, pathway, pval, padj, NES, size, leadingEdge), 10)
)
```

### 管道 2：msigdbr → enricher（基因列表 ORA，与 bio_enrichr 交叉验证）

```r
suppressPackageStartupMessages({
  library(msigdbr)
  library(fgsea)
  library(dplyr)
})

# 获取背景基因集
gene_sets <- msigdbr(species = "Homo sapiens", collection = "C5")
# 转为 enricher 格式：list of gene sets
pathways <- gene_sets %>%
  group_by(gs_name) %>%
  summarise(genes = list(unique(gene_symbol)), .groups = "drop") %>%
  { setNames(.$genes, .$gs_name) }

# 用户基因列表（显著基因 symbol 向量）
sig_genes <- c("TP53", "BRCA1", "MYC", "...")

# ORA 用 fgsea 的 enricher（超几何检验）
ora_res <- enricher(sig_genes, universe = all_genes,
                    minGSSize = 15, maxGSSize = 500,
                    pvalueCutoff = 0.05)
```

### 常用基因集分类速查

| `collection` | 含义 | 典型用途 |
|----------|------|----------|
| `H` | Hallmark（50 个精炼通路） | 快速通路概览，适合首次探索 |
| `C1` | 基因组位置（染色体区段） | 染色体偏好分析 |
| `C2` | 基因集（KEGG/Reactome/BioCarta 等） | 通路富集 |
| `C5` | GO（BP/MF/CC） | GO 富集（替代 clusterProfiler） |
| `C6` | 癌症基因特征 | 肿瘤相关分析 |
| `C7` | 免疫学签名 | 免疫微环境 |
| `C8` | 单细胞基因特征 | 细胞类型标记 |

## 结果解读纪律

- **NES**：正 = 上调富集，负 = 下调富集。|NES| 大小与显著性分开看。
- **GSEA 惯例阈值 padj < 0.25**（不同于 ORA 的 0.05）——报告时说明。
- `leadingEdge`：核心贡献基因。写解读时**必须点名这些基因**让结论可验证。
- msigdbr 返回的 `gene_symbol` 是 HGNC symbol——确保输入排序列表也用同一命名体系。

## 高频坑

- **zenodo.org 下载失败（中国网络常见）**：msigdbr 首次调用需从 zenodo.org 下载 ~42MB 基因集数据。解决方案：在终端运行 `HTTPS_PROXY=http://127.0.0.1:27890 curl -L -o "$(Rscript -e 'cat(tools::R_user_dir("msigdbr","cache"))')/msigdb.2026.1.zip https://zenodo.org/records/18968178/files/msigdb.2026.1.zip?download=1`，然后 R 里 `utils::unzip(...)` 解压即可。或在 `~/.Rprofile` 中加 `Sys.setenv(HTTPS_PROXY = "http://127.0.0.1:27890")`（端口按实际代理调整）让 R 的 curl 自动走代理。
- **物种名必须精确**：`"Homo sapiens"`（不是 `"human"`），`"Mus musculus"`（不是 `"mouse"`）。用 `msigdbr_species()` 查看所有可用物种。
- **C5 子分类**：`subcollection = "GO:BP"` 筛选 GO 生物过程，`"GO:MF"` 分子功能，`"GO:CC"` 细胞组分。不指定 subcollection 则返回全部 GO。
- **基因集太大/太小**：`minSize = 15, maxSize = 500` 是合理默认。基因集 < 15 个基因统计功效不足，> 500 个基因过于宽泛。
- **msigdbr 首次加载慢**（~10-30s，构建内部数据库）——在 skill 提示中告知用户。

## 边界

- msigdbr **不含**最新版 MSigDB 的所有数据——版本随 msigdbr 包更新（当前 v26.1.0 对应 MSigDB 2024）。
- 品种限于主要模式生物（人/鼠/斑马鱼/果蝇/拟南芥等），非模式生物需回退到手动 GMT。
- `bio_enrichr`（Python 侧）的 ORA 仍然更快且内置限流缓存——排序 GSEA 用本 skill 的 fgsea，列表 ORA 优先 `bio_enrichr`。
