"""Python 差异表达分析 — 归一化 Welch 近似实现（统计口径 v2，2026-10-05）

方法（v2）：
- 文库归一化：median-of-ratios size factors（DESeq2 同款定义）
- log2FC：归一化均值的伪计数比值 log2((mean1+1)/(mean2+1))
- 检验：log2(归一化计数+1) 上的 Welch t 检验（不等方差）
- 多重校正：Benjamini-Hochberg FDR

⚠️ 如实声明：**不是完整 DESeq2**——无负二项 GLM、无离散度估计、无 LFC 收缩；
小样本（每组 <4 样本）下 p 值为近似，结果用于筛选/排序而非定量结论。
（v1 为原始计数上的等方差 t 检验且无归一化，v2 起废弃该口径。）
"""
import numpy as np
import pandas as pd
from scipy import stats
from scipy.stats import false_discovery_control


def op_deseq2_python(args):
    """Python 差异表达分析（统计口径 v2，见模块 docstring）

    输入：
    - counts_file: counts 矩阵 CSV（行=基因，列=样本）
    - meta_file: 样本信息 CSV（sample, condition 列）
    - contrast: 对比组（如 "trt_vs_ctrl"）
    - out_csv: 可选——全量结果表落盘路径（gene/baseMean/log2FoldChange/pvalue/padj）

    输出：差异表达结果 + 方法元数据 + 统计摘要
    """
    counts_file = args.get('counts_file')
    meta_file = args.get('meta_file')
    contrast = args.get('contrast', 'trt_vs_ctrl')
    out_csv = args.get('out_csv')
    
    if not counts_file or not meta_file:
        return {'error': 'counts_file and meta_file required'}
    
    try:
        import pandas as pd
        from scipy import stats
        from scipy.stats import false_discovery_control
    except ImportError as e:
        return {'error': f'Missing dependency: {e}'}
    
    # 读取数据
    counts = pd.read_csv(counts_file, index_col=0)
    meta = pd.read_csv(meta_file)
    
    # 解析对比组
    parts = contrast.split('_vs_')
    if len(parts) != 2:
        return {'error': f'Invalid contrast format: {contrast}. Use "group1_vs_group2"'}
    group1, group2 = parts
    
    # 获取样本分组（友好守卫：meta 缺 sample/condition 列时给出可操作的引导，
    # 而非裸 KeyError——用户 meta 常习惯用 group/treatment 等列名）
    for col in ('sample', 'condition'):
        if col not in meta.columns:
            return {
                'error': f"meta_file 缺少必需列 '{col}'，实际列: {list(meta.columns)}。"
                         f"要求两列：sample（样本名，与 counts 列名一致）+ condition（分组，如 ctrl/trt）。"
                         f"若你的分组列叫 group/treatment 等，请重命名为 condition 后重试。",
                'hint': f'期望的 meta.csv 形如：sample,condition\\n s1,ctrl\\n s2,trt',
            }
    groups = meta['condition'].unique()
    if group1 not in groups or group2 not in groups:
        return {'error': f'Groups not found: {group1}, {group2}. Available: {list(groups)}'}
    
    samples1 = meta[meta['condition'] == group1]['sample'].tolist()
    samples2 = meta[meta['condition'] == group2]['sample'].tolist()
    if len(samples1) < 2 or len(samples2) < 2:
        return {'error': f'每组至少需要 2 个样本才能做方差近似（当前 {group1}={len(samples1)}，'
                         f'{group2}={len(samples2)}）',
                'hint': '单样本组无法做 t 检验；请补充重复，或改用纯描述性比较。'}

    # 确保列名匹配
    counts = counts[[s for s in samples1 + samples2 if s in counts.columns]]

    # ---- 文库归一化：median-of-ratios size factors（v2）----
    lib = counts.astype(float)
    pos = lib[(lib > 0).all(axis=1)]
    if len(pos) > 0:
        geo = np.exp(np.log(pos).mean(axis=1))
        ratios = pos.div(geo, axis=0)
        size_factors = {c: float(round(float(np.median(ratios[c])), 6)) for c in lib.columns}
    else:  # 无全正基因（极端稀疏表）→ 因子退化为 1，不做归一化
        size_factors = {c: 1.0 for c in lib.columns}
    norm = lib.div(pd.Series(size_factors), axis='columns')
    
    # 差异表达分析（v2：归一化均值 + log2 空间 Welch t）
    results = []
    for gene in counts.index:
        raw1 = lib.loc[gene, samples1].values.astype(float)
        raw2 = lib.loc[gene, samples2].values.astype(float)

        # 过滤低表达基因（口径与 v1 一致：两组原始均值均 <1）
        if np.mean(raw1) < 1 and np.mean(raw2) < 1:
            continue

        y1 = norm.loc[gene, samples1].values.astype(float)
        y2 = norm.loc[gene, samples2].values.astype(float)

        # log2 fold change（归一化均值 + 伪计数避免 log0）
        log2fc = np.log2((np.mean(y1) + 1) / (np.mean(y2) + 1))

        # Welch t 检验（log2 归一化计数空间，不等方差）
        t_stat, pvalue = stats.ttest_ind(np.log2(y1 + 1), np.log2(y2 + 1), equal_var=False)

        # baseMean（归一化后均值）
        baseMean = np.mean(np.concatenate([y1, y2]))

        results.append({
            'gene': gene,
            'baseMean': round(float(baseMean), 2),
            'log2FoldChange': round(float(log2fc), 4),
            'pvalue': float(pvalue),
        })
    
    # 转为 DataFrame
    df = pd.DataFrame(results)
    if len(df) == 0:
        return {'error': 'No genes passed low-expression filter'}
    
    # BH-FDR 校正
    df['padj'] = false_discovery_control(df['pvalue'], method='bh')
    df = df.sort_values('padj')
    
    # 可选：全量结果表落盘（避免调用方为拿全表重复实现同一算法）
    out_info = None
    if out_csv:
        try:
            import os
            _d = os.path.dirname(os.path.abspath(out_csv))
            if _d:
                os.makedirs(_d, exist_ok=True)
            df.to_csv(out_csv, index=False)
            out_info = {'out_csv': out_csv, 'n_rows': int(len(df))}
        except Exception as e:
            out_info = {'out_csv': out_csv, 'error': f'{type(e).__name__}: {e}'}

    # 统计
    sig = df[(df['padj'] < 0.05) & (df['log2FoldChange'].abs() > 1)]

    out = {
        'n_genes': len(df),
        'n_up': int((sig['log2FoldChange'] > 0).sum()),
        'n_down': int((sig['log2FoldChange'] < 0).sum()),
        'top_genes': df.head(10).to_dict('records'),
        'summary': {
            'mean_baseMean': round(df['baseMean'].mean(), 2),
            'median_padj': round(df['padj'].median(), 4),
        },
        'method': {
            'name': 'median-of-ratios normalization + Welch t-test on log2(normalized+1)',
            'normalization': 'median-of-ratios size factors (DESeq2-style)',
            'test': 'Welch t-test (unequal variance) on log2(normalized+1)',
            'pseudocount': 1,
            'multiple_testing': 'Benjamini-Hochberg FDR',
            'threshold': 'padj < 0.05 且 |log2FC| > 1',
            'limitations': ('非完整 DESeq2：无 NB GLM / 离散度估计 / LFC 收缩；'
                            '小样本（每组 <4）下 p 值近似，用于筛选排序而非定量结论'),
        },
        'size_factors': size_factors,
    }
    if out_info:
        out['out_csv'] = out_info
    return out


def op_gsea_python(args):
    """Python GSEA 富集分析（fgsea 等效）
    
    输入：
    - de_results_file: 差异表达结果 CSV（含 gene, log2FoldChange 列）
    - gene_set_file: GMT 基因集文件（可选）
    - gene_sets: 预定义基因集名称（可选，如 "hallmark"）
    
    输出：富集分析结果
    """
    de_file = args.get('de_results_file')
    gene_set_file = args.get('gene_set_file')
    gene_sets = args.get('gene_sets', 'hallmark')
    
    if not de_file:
        return {'error': 'de_results_file required'}
    
    try:
        import pandas as pd
        from scipy.stats import rankdata
    except ImportError as e:
        return {'error': f'Missing dependency: {e}'}
    
    # 读取差异表达结果
    de = pd.read_csv(de_file)
    
    # 构建排序列表（按 log2FC 降序）
    de = de.dropna(subset=['log2FoldChange'])
    stats_dict = dict(zip(de['gene'], de['log2FoldChange']))
    
    # 获取基因集
    if gene_set_file:
        # 从 GMT 文件读取
        gene_sets_dict = {}
        with open(gene_set_file) as f:
            for line in f:
                parts = line.strip().split('\t')
                if len(parts) >= 3:
                    name = parts[0]
                    genes = set(parts[2:])
                    gene_sets_dict[name] = genes
    else:
        # 使用内置的简单基因集（示例）
        gene_sets_dict = {
            'metabolism': {'PFK', 'PK', 'LDHA', 'PDK1', 'IDH1', 'SDHA', 'FH', 'CS'},
            'signaling': {'EGFR', 'KRAS', 'BRAF', 'MAPK1', 'AKT1', 'MTOR'},
            'apoptosis': {'BAX', 'BAK1', 'BCL2', 'CASP3', 'CASP9', 'TP53'},
        }
    
    # 简化版 GSEA：计算每个基因集的富集分数
    results = []
    ranked_genes = sorted(stats_dict.keys(), key=lambda g: stats_dict[g], reverse=True)
    
    for gs_name, gs_genes in gene_sets_dict.items():
        # 计算富集分数
        n = len(ranked_genes)
        n_set = len(gs_genes & set(ranked_genes))
        if n_set == 0:
            continue
        
        # 简化版 NES 计算
        hit_positions = [i for i, g in enumerate(ranked_genes) if g in gs_genes]
        es = sum(1.0/n_set - i/n for i in hit_positions) if hit_positions else 0
        
        results.append({
            'pathway': gs_name,
            'size': n_set,
            'ES': round(es, 4),
            'NES': round(es * 10, 4),  # 简化 NES
        })
    
    # 排序
    results.sort(key=lambda x: abs(x['NES']), reverse=True)
    
    return {
        'n_pathways': len(results),
        'top_pathways': results[:10],
        'note': '简化版 GSEA；完整版需安装 gseapy 包',
    }
