---
language: r
---

# R 富集与 GSEA（fgsea + msigdbr）

> fgsea 排序富集 + msigdbr 基因集（免手写 GMT），是 R 侧 GSEA 的权威实现。

## 核心优势

- **msigdbr**：按物种/分类即时查询 MSigDB 基因集，免手动下载 GMT 文件。
- **fgsea**：快速 GSEA 实现（prerank 方法），支持任意排序列表。
- 与 Python `bio_enrichr`（ORA）互补：GSEA 用排序列表，ORA 用基因列表。

## 完整管道：RNA-seq → GSEA

```r
suppressPackageStartupMessages({
  library(fgsea); library(msigdbr); library(dplyr); library(readr)
})

# 1. 读取 DESeq2 结果（来自 bio_r 的 de_results.csv）
de <- read_csv("de_results.csv", show_col_types = FALSE)

# 2. 构建排序列表（log2FC，命名为基因 symbol）
stats <- de %>%
  filter(!is.na(padj), !is.na(log2FoldChange)) %>%
  arrange(desc(log2FoldChange)) %>%
  { setNames(.$log2FoldChange, .$gene) }

# 3. 查询 MSigDB 基因集（人类 Hallmark 通路）
genesets <- msigdbr(species = "Homo sapiens", category = "H") %>%
  dplyr::select(gs_name, ensembl_gene) %>%
  as.data.frame()

# 4. 运行 fgsea
gsea_res <- fgsea(
  pathways = split(genesets$ensembl_gene, genesets$gs_name),
  stats = stats,
  minSize = 15,
  maxSize = 500,
  nPermSimple = 1000
)

# 5. 整理结果
gsea_res <- gsea_res %>%
  arrange(pval) %>%
  dplyr::select(pathway, padj, ES, NES, size) %>%
  mutate(direction = ifelse(NES > 0, "Up", "Down"))

readr::write_csv(gsea_res, "gsea_results.csv")

result <- list(
  n_pathways = nrow(gsea_res),
  n_sig = sum(gsea_res$padj < 0.25, na.rm = TRUE),
  top = head(gsea_res, 10),
  out_file = "gsea_results.csv")
```

## msigdbr 基因集分类速查

| category | 含义 | 示例 |
|---|---|---|
| H | Hallmark（精炼通路） | HALLMARK_OXIDATIVE_PHOSPHORYLATION |
| C1 | 位置（染色体区域） | CP:chr1q21 |
| C2 | 患者/实验保守基因集 | CGP:chemical_and_genetic_perturbations |
| C3 | 调控靶标（miRNA/TF） | MIR:hsa-miR-21-5p |
| C4 | 癌症相关 | CGN:cellular_modules |
| C5 | GO（BP/MF/CC） | GOBP_RESPONSE_TO_STRESS |
| C6 | 癌症特征 | C6:ONCOGENE_SIGNATURE |
| C7 | 免疫签名 | C7:IMMUNESIGDB |
| C8 | 细胞类型特征 | C8:CELL_TYPE_SIGNATURES |

## 按物种查询

```r
# 人类
msigdbr(species = "Homo sapiens", category = "H")
# 小鼠
msigdbr(species = "Mus musculus", category = "H")
# 斑马鱼
msigdbr(species = "Danio rerio", category = "H")
# 查看支持的物种
msigdbr_species()
```

## 按子分类查询

```r
# GO Biological Process
msigdbr(species = "Homo sapiens", category = "C5", subcategory = "GO:BP")
# KEGG 通路
msigdbr(species = "Homo sapiens", category = "C2", subcategory = "CP:KEGG")
# Reactome 通路
msigdbr(species = "Homo sapiens", category = "C2", subcategory = "CP:REACTOME")
```

## GSEA 可视化（barplot）

```r
library(ggplot2)
top_n <- head(gsea_res, 20)
ggplot(top_n, aes(reorder(pathway, NES), NES, fill = direction)) +
  geom_col() +
  coord_flip() +
  scale_fill_manual(values = c("Up" = "#e74c3c", "Down" = "#3498db")) +
  labs(x = NULL, y = "Normalized Enrichment Score", title = "GSEA Top Pathways") +
  theme_minimal()
ggsave("gsea_barplot.pdf", width = 8, height = 6)
```

## 与 bio_enrichr 的分工

| | fgsea (R) | bio_enrichr (Python) |
|---|---|---|
| 输入 | 排序列表（log2FC） | 基因列表（symbol） |
| 方法 | GSEA（排序富集） | ORA（过表示分析） |
| 基因集 | msigdbr（即时查询） | Enrichr API（网络） |
| 适用场景 | 全基因组排序分析 | 候选基因集富集 |
| 离线可用 | ✅ | ❌（需网络） |

## 高频坑

- `stats` 必须是**命名向量**（names = 基因 ID，values = 排序值）；缺失/重复名会报错。
- fgsea 的 `padj` 用 BH 校正；阈值建议 **padj < 0.25**（宽松阈值，GSEA 的常规做法）。
- msigdbr 返回的是 `ensembl_gene`，如果用户的基因列表是 symbol，需要先转换（`msigdbr` 也返回 `gs_name` 可直接用）。
- 基因集太小（<15）或太大（>500）会被 fgsea 自动过滤。
- 首次调用 msigdbr 可能需要下载数据（~42MB），需代理环境。
