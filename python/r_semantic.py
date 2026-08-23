"""R 语义化工具 — 封装常用 R 操作为结构化接口

避免每次调用都 spawn R 进程（慢），而是：
- 参数化输入（JSON args）
- 自动执行 R 代码
- 结构化输出（JSON result）
"""
import os
import json
import subprocess
import tempfile


def _run_r(code, timeout=60):
    """运行 R 代码并返回结果（通过临时文件，避免 stdin/stdout 问题）"""
    rscript = os.path.join(os.path.expanduser('~'), '.dsh', 'dsh-bio-genie', 'r', 'bin', 'x64', 'Rscript.exe')
    rlib = os.path.join(os.path.join(os.path.expanduser('~'), '.dsh', 'dsh-bio-genie', 'r-lib'))
    
    # 写入临时 R 脚本
    with tempfile.NamedTemporaryFile(mode='w', suffix='.R', delete=False, encoding='utf-8') as f:
        f.write(code)
        tmp_path = f.name
    
    # 输出文件
    out_path = tmp_path + '.out'
    
    try:
        env = os.environ.copy()
        env['R_LIBS'] = rlib
        # 使用 --vanilla + 输出重定向
        cmd = f'"{rscript}" --vanilla "{tmp_path}" > "{out_path}" 2>&1'
        result = subprocess.run(
            cmd, shell=True, timeout=timeout, env=env,
            encoding='utf-8', errors='replace'
        )
        
        # 读取输出
        stdout = ''
        try:
            with open(out_path, 'r', encoding='utf-8', errors='replace') as f:
                stdout = f.read()
        except:
            pass
        
        return {
            'ok': result.returncode == 0,
            'stdout': stdout,
            'stderr': '',
        }
    finally:
        try:
            os.unlink(tmp_path)
            os.unlink(out_path)
        except:
            pass


def op_r_deseq2(args):
    """差异表达分析（DESeq2）
    
    输入：
    - counts_file: counts 矩阵 CSV 路径（行=基因，列=样本）
    - meta_file: 样本信息 CSV 路径（sample, condition 列）
    - contrast: 对比组（如 "trt_vs_ctrl"）
    
    输出：差异表达结果表 + 统计摘要
    """
    counts_file = args.get('counts_file')
    meta_file = args.get('meta_file')
    contrast = args.get('contrast', 'trt_vs_ctrl')
    
    if not counts_file or not meta_file:
        return {'error': 'counts_file and meta_file required'}
    
    code = f'''
suppressPackageStartupMessages({{
  library(DESeq2)
  library(readr)
  library(dplyr)
}})

# 读取数据
counts <- read_csv("{counts_file}", show_col_types = FALSE) %>%
  tibble::column_to_rownames("gene") %>% as.matrix()
meta <- read_csv("{meta_file}", show_col_types = FALSE)

# 对齐列序
counts <- counts[, meta$sample]
meta$condition <- factor(meta$condition)

# DESeq2 分析
dds <- DESeqDataSetFromMatrix(countData = counts, colData = meta, design = ~ condition)
dds <- DESeq(dds)
res <- results(dds)
res_df <- as.data.frame(res) %>% tibble::rownames_to_column("gene") %>% arrange(padj)

# 统计摘要
sig <- filter(res_df, padj < 0.05 & abs(log2FoldChange) > 1)
result <- list(
  n_genes = nrow(res_df),
  n_up = sum(sig$log2FoldChange > 0, na.rm = TRUE),
  n_down = sum(sig$log2FoldChange < 0, na.rm = TRUE),
  top_genes = head(select(res_df, gene, baseMean, log2FoldChange, padj), 10),
  summary = list(
    mean_baseMean = round(mean(res_df$baseMean, na.rm = TRUE), 2),
    median_padj = round(median(res_df$padj, na.rm = TRUE), 4)
  )
)
cat(jsonlite::toJSON(result, auto_unbox = TRUE), "\\n")
'''
    
    r = _run_r(code)
    if not r['ok']:
        return {'error': f'R execution failed: {r["stderr"][:200]}'}
    
    # 解析 JSON 输出
    for line in r['stdout'].strip().split('\n'):
        try:
            return json.loads(line)
        except:
            continue
    
    return {'error': 'Failed to parse R output', 'stdout': r['stdout'][:500]}


def op_r_gsea(args):
    """GSEA 富集分析（fgsea + msigdbr）
    
    输入：
    - de_results_file: 差异表达结果 CSV（含 gene, log2FoldChange 列）
    - species: 物种（human/mouse）
    - category: 基因集分类（H/C5 等）
    
    输出：富集分析结果
    """
    de_file = args.get('de_results_file')
    species = args.get('species', 'human')
    category = args.get('category', 'H')
    
    if not de_file:
        return {'error': 'de_results_file required'}
    
    code = f'''
suppressPackageStartupMessages({{
  library(fgsea)
  library(msigdbr)
  library(dplyr)
  library(readr)
}})

# 读取差异表达结果
de <- read_csv("{de_file}", show_col_types = FALSE)

# 构建排序列表
stats <- de %>%
  filter(!is.na(padj), !is.na(log2FoldChange)) %>%
  arrange(desc(log2FoldChange)) %>%
  {{ setNames(.$log2FoldChange, .$gene) }}

# 获取基因集
genesets <- msigdbr(species = "{species}", category = "{category}") %>%
  dplyr::select(gs_name, ensembl_gene) %>%
  as.data.frame()

# 运行 fgsea
gsea_res <- fgsea(
  pathways = split(genesets$ensembl_gene, genesets$gs_name),
  stats = stats,
  minSize = 15, maxSize = 500, nPermSimple = 1000
) %>% arrange(pval) %>%
  dplyr::select(pathway, padj, ES, NES, size) %>%
  mutate(direction = ifelse(NES > 0, "Up", "Down"))

result <- list(
  n_pathways = nrow(gsea_res),
  n_sig = sum(gsea_res$padj < 0.25, na.rm = TRUE),
  top_pathways = head(gsea_res, 10)
)
cat(jsonlite::toJSON(result, auto_unbox = TRUE), "\\n")
'''
    
    r = _run_r(code)
    if not r['ok']:
        return {'error': f'R execution failed: {r["stderr"][:200]}'}
    
    for line in r['stdout'].strip().split('\n'):
        try:
            return json.loads(line)
        except:
            continue
    
    return {'error': 'Failed to parse R output', 'stdout': r['stdout'][:500]}


def op_r火山图(args):
    """火山图（ggplot2）
    
    输入：
    - de_results_file: 差异表达结果 CSV
    - output_file: 输出文件路径
    
    输出：火山图文件路径
    """
    de_file = args.get('de_results_file')
    output_file = args.get('output_file', 'volcano.pdf')
    
    if not de_file:
        return {'error': 'de_results_file required'}
    
    code = f'''
suppressPackageStartupMessages(library(ggplot2))
de <- read.csv("{de_file}")
de$significance <- ifelse(de$padj < 0.05 & de$log2FoldChange > 1, "Up",
                  ifelse(de$padj < 0.05 & de$log2FoldChange < -1, "Down", "NS"))
p <- ggplot(de, aes(log2FoldChange, -log10(padj), color = significance)) +
  geom_point(alpha = 0.6, size = 1.5) +
  scale_color_manual(values = c("Up" = "#e74c3c", "Down" = "#3498db", "NS" = "grey60")) +
  geom_vline(xintercept = c(-1, 1), linetype = "dashed", alpha = 0.5) +
  geom_hline(yintercept = -log10(0.05), linetype = "dashed", alpha = 0.5) +
  labs(x = "log2 Fold Change", y = "-log10 adjusted p-value", title = "Volcano Plot") +
  theme_minimal()
ggsave("{output_file}", p, width = 7, height = 5)
cat(jsonlite::toJSON(list(output_file = "{output_file}", n_up = sum(de$significance == "Up"), n_down = sum(de$significance == "Down")), auto_unbox = TRUE), "\\n")
'''
    
    r = _run_r(code)
    if not r['ok']:
        return {'error': f'R execution failed: {r["stderr"][:200]}'}
    
    for line in r['stdout'].strip().split('\n'):
        try:
            return json.loads(line)
        except:
            continue
    
    return {'error': 'Failed to parse R output', 'stdout': r['stdout'][:500]}


def op_r_dimred(args):
    """t-SNE 降维
    
    输入：
    - data_file: 数值矩阵 CSV（行=样本，列=特征）
    - n_components: 降维维度（默认 2）
    - perplexity: 困惑度（默认 30）
    
    输出：降维坐标
    """
    data_file = args.get('data_file')
    n_components = args.get('n_components', 2)
    perplexity = args.get('perplexity', 30)
    
    if not data_file:
        return {'error': 'data_file required'}
    
    code = f'''
suppressPackageStartupMessages({{
  library(Rtsne)
  library(readr)
}})

data <- read_csv("{data_file}", show_col_types = FALSE)
# 只取数值列
data_num <- data[, sapply(data, is.numeric)]
data_num[is.na(data_num)] <- 0

# 运行 t-SNE
tsne <- Rtsne(as.matrix(data_num), dims = {n_components}, perplexity = min({perplexity}, nrow(data_num) - 1))
coords <- as.data.frame(tsne$Y)
names(coords) <- paste0("dim", 1:{n_components})

result <- list(
  n_samples = nrow(coords),
  n_components = {n_components},
  coordinates = coords
)
cat(jsonlite::toJSON(result, auto_unbox = TRUE), "\\n")
'''
    
    r = _run_r(code)
    if not r['ok']:
        return {'error': f'R execution failed: {r["stderr"][:200]}'}
    
    for line in r['stdout'].strip().split('\n'):
        try:
            return json.loads(line)
        except:
            continue
    
    return {'error': 'Failed to parse R output', 'stdout': r['stdout'][:500]}
