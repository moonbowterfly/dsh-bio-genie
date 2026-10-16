"""dsh-bio-genie 可视化工具箱 —— 矩阵/集合/富集/域（批次 B2）

  - plot_heatmap      聚类热图（行/列聚类 + 标准化 + 注释）
  - plot_venn         集合 Venn 图（2-3 组；>3 建议 UpSet）
  - plot_upset        UpSet 图（任意集合数，交集大小排序）
  - plot_enrichment   富集结果条形图（-log10 p，自动列识别）
  - plot_domains      蛋白结构域示意图（多蛋白轨道）
"""
import os
import re

import matplotlib
matplotlib.use('Agg')  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Circle, Rectangle  # noqa: E402

from seq_toolkit import _req_path  # noqa: E402
from plot_toolkit import _setup_style, _base, _export  # noqa: E402

_RAINBOW = {'jet', 'rainbow', 'hsv', 'gist_rainbow', 'nipy_spectral'}


def _read_groups(args):
    """集合输入：groups（数组的数组）或 group_files（文件列表）。"""
    groups = args.get('groups')
    labels = args.get('labels') or []
    if isinstance(labels, str):
        labels = [x.strip() for x in labels.split(',') if x.strip()]
    files = args.get('group_files') or []
    if isinstance(files, str):
        files = [x.strip() for x in files.split(',') if x.strip()]
    if groups:
        sets = []
        for g in groups:
            if isinstance(g, str):
                # 逗号/空白分隔的字符串集合
                sets.append({x for x in re.split(r'[,;\s]+', g) if x})
            else:
                sets.append({str(x).strip() for x in g if str(x).strip()})
    elif files:
        sets = []
        for f in files:
            if not os.path.isfile(f):
                raise ValueError('group_files 不存在：%s' % f)
            with open(f, 'r', encoding='utf-8', errors='replace') as fh:
                vals = set()
                for ln in fh:
                    s = ln.strip()
                    if not s or s.startswith('#'):
                        continue
                    vals.add(s.split('\t')[0].split(',')[0].strip())
            sets.append(vals)
        if not labels:
            labels = [os.path.basename(f) for f in files]
    else:
        raise ValueError('必须提供 groups（数组的数组）或 group_files（文件列表）')
    if len(sets) < 2:
        raise ValueError('至少需要 2 个集合')
    if not labels:
        labels = ['Set %d' % (i + 1) for i in range(len(sets))]
    if len(labels) < len(sets):
        labels = list(labels) + ['Set %d' % (i + 1) for i in range(len(labels), len(sets))]
    return sets, labels


# ============================================================================
# op: plot_heatmap
# ============================================================================

def op_plot_heatmap(args):
    """聚类热图：矩阵文件 -> 出版级热图（可选行/列聚类与标准化）。"""
    path = _req_path(args, 'matrix')
    import numpy as np
    import pandas as pd

    try:
        df = pd.read_csv(path, sep=None, engine='python', index_col=0)
    except Exception as e:
        raise ValueError('矩阵读取失败（尝试 TSV/CSV 自动分隔符）：%s' % e)
    m = df.apply(pd.to_numeric, errors='coerce')
    if m.dropna(how='all').empty:
        raise ValueError('矩阵中没有任何数值数据（检查文件格式：首行列名、首列行名）')

    scale = str(args.get('scale') or 'none').lower()
    if scale == 'row':
        m = m.sub(m.mean(axis=1), axis=0).div(m.std(axis=1).replace(0, np.nan), axis=0)
    elif scale == 'col':
        m = m.sub(m.mean(axis=0), axis=1).div(m.std(axis=0).replace(0, np.nan), axis=1)
    elif scale != 'none':
        raise ValueError("scale 仅支持 none / row / col")

    cmap = str(args.get('cmap') or 'RdBu_r')
    if cmap.lower() in _RAINBOW:
        raise ValueError('不推荐 rainbow/jet 色系（可读性与色盲友好差）；建议 RdBu_r / viridis / coolwarm')
    cluster_rows = bool(args.get('cluster_rows', True))
    cluster_cols = bool(args.get('cluster_cols', True))
    max_dim = int(args.get('max_cluster_dim') or 800)
    nr, nc = m.shape
    if (cluster_rows and nr > max_dim) or (cluster_cols and nc > max_dim):
        raise ValueError('矩阵规模 %dx%d 超过聚类上限 %d（可关闭聚类或降采样）' % (nr, nc, max_dim))

    vals = m.values
    finite = vals[np.isfinite(vals)]
    if finite.size == 0:
        raise ValueError('矩阵中没有有效数值')
    vmax = float(np.percentile(finite, 98))
    vmin = float(np.percentile(finite, 2))
    if scale != 'none':
        lim = max(abs(vmin), abs(vmax))
        vmin, vmax = -lim, lim

    row_order = list(range(nr))
    col_order = list(range(nc))
    row_tree = col_tree = None
    if cluster_rows or cluster_cols:
        from scipy.cluster.hierarchy import linkage, dendrogram
        from scipy.spatial.distance import pdist
        arr = np.nan_to_num(vals, nan=float(np.nanmean(finite)))
        if cluster_rows and nr > 2:
            row_tree = linkage(pdist(arr, metric='euclidean'), method='average')
        if cluster_cols and nc > 2:
            col_tree = linkage(pdist(arr.T, metric='euclidean'), method='average')

    _setup_style(args)
    show_rlab = nr <= int(args.get('max_row_labels') or 60)
    show_clab = nc <= int(args.get('max_col_labels') or 80)
    w = float(args.get('width') or (6.5 + (2.2 if show_rlab else 0)))
    h = float(args.get('height') or (5.0 + (1.2 if show_clab else 0)))

    fig = plt.figure(figsize=(w, h))
    gs = fig.add_gridspec(2, 3, width_ratios=[0.18 if cluster_rows else 0.001, 1, 0.06],
                          height_ratios=[0.18 if cluster_cols else 0.001, 1],
                          wspace=0.03, hspace=0.03)

    ax_h = fig.add_subplot(gs[1, 1])
    if row_tree is not None:
        ax_r = fig.add_subplot(gs[1, 0])
        dendro = dendrogram(row_tree, orientation='left', no_labels=True,
                            color_threshold=0, above_threshold_color='#555555',
                            ax=ax_r)
        row_order = dendro['leaves']
        ax_r.invert_yaxis()
        ax_r.axis('off')
    if col_tree is not None:
        ax_c = fig.add_subplot(gs[0, 1])
        dendro = dendrogram(col_tree, orientation='top', no_labels=True,
                            color_threshold=0, above_threshold_color='#555555',
                            ax=ax_c)
        col_order = dendro['leaves']
        ax_c.axis('off')

    m2 = m.iloc[row_order, col_order]
    im = ax_h.imshow(m2.values, aspect='auto', cmap=cmap, vmin=vmin, vmax=vmax,
                     interpolation='nearest')
    ax_h.set_xticks(range(nc))
    ax_h.set_yticks(range(nr))
    if show_clab:
        ax_h.set_xticklabels([str(c) for c in m2.columns], rotation=90, fontsize=6)
    else:
        ax_h.set_xticklabels([])
    if show_rlab:
        ax_h.set_yticklabels([str(r) for r in m2.index], fontsize=6)
    else:
        ax_h.set_yticklabels([])
    ax_h.tick_params(length=1.5)

    ax_cb = fig.add_subplot(gs[1, 2])
    fig.colorbar(im, cax=ax_cb, label='z-score' if scale != 'none' else 'value')
    ax_cb.tick_params(labelsize=7)
    fig.suptitle(str(args.get('title') or 'Heatmap'), fontsize=10)

    base = _base(args, 'heatmap')
    paths = _export(fig, base, args)
    return {
        'shape': [nr, nc],
        'scale': scale,
        'clustered': {'rows': row_tree is not None, 'cols': col_tree is not None},
        'value_range': [round(vmin, 4), round(vmax, 4)],
        'files': paths,
        'output_file': paths[0] if paths else None,
    }


# ============================================================================
# op: plot_venn （2-3 组）
# ============================================================================

def _venn_counts(sets, labels):
    if len(sets) == 2:
        a, b = sets
        return {
            'regions': {'A': len(a - b), 'B': len(b - a), 'AB': len(a & b)},
            'positions': {'A': (-0.62, 0.32), 'B': (0.62, 0.32), 'AB': (0.0, 0.02)},
            'name_pos': [(-0.4, 0.72), (0.4, 0.72)],
        }
    a, b, c = sets
    ab, ac, bc, abc = a & b, a & c, b & c, a & b & c
    return {
        'regions': {
            'A': len(a - b - c), 'B': len(b - a - c), 'C': len(c - a - b),
            'AB': len(ab - c), 'AC': len(ac - b), 'BC': len(bc - a), 'ABC': len(abc),
        },
        'positions': {
            'A': (-0.24, 0.42), 'B': (-0.46, -0.30), 'C': (0.46, -0.30),
            'AB': (-0.36, 0.03), 'AC': (0.36, 0.03), 'BC': (0.0, -0.38), 'ABC': (0.0, -0.06),
        },
        'name_pos': [(0.0, 0.86), (-0.72, -0.62), (0.72, -0.62)],
    }


def op_plot_venn(args):
    """Venn 图（2-3 组；>3 组时建议改 UpSet）。"""
    sets, labels = _read_groups(args)
    n = len(sets)
    if n > 3:
        raise ValueError('Venn 超过 3 组后区域重叠不可读（学界共识）；%d 组建议用 bio_plot_upset（UpSet 图）。' % n)

    _setup_style(args)
    colors = ['#7BAFD4', '#F0C27B', '#9DC98C']
    alphas = [0.55, 0.5, 0.5]
    fig, ax = plt.subplots(figsize=(float(args.get('width') or 6.0), float(args.get('height') or 5.2)))

    info = _venn_counts(sets, labels)
    if n == 2:
        circles = [((-0.4, 0), 0.6), ((0.4, 0), 0.6)]
    else:
        circles = [((0.0, 0.33), 0.45), ((-0.33, -0.25), 0.45), ((0.33, -0.25), 0.45)]
    for (cx, cy), r in circles:
        ax.add_patch(Circle((cx, cy), r, facecolor='none', edgecolor='#333333', lw=1.0, zorder=3))
    for i, ((cx, cy), r) in enumerate(circles):
        ax.add_patch(Circle((cx, cy), r * 0.985, facecolor=colors[i % len(colors)],
                            alpha=alphas[i % len(alphas)], edgecolor='none', zorder=1))

    for key, pos in info['positions'].items():
        ax.text(pos[0], pos[1], str(info['regions'][key]), ha='center', va='center',
                fontsize=10, zorder=5)
    for i, pos in enumerate(info['name_pos'][:n]):
        ax.text(pos[0], pos[1], '%s\n(n=%d)' % (labels[i], len(sets[i])), ha='center', va='center',
                fontsize=10, fontweight='bold')

    ax.set_xlim(-1.15, 1.15)
    ax.set_ylim(-1.05, 1.1)
    ax.set_aspect('equal')
    ax.axis('off')
    fig.suptitle(str(args.get('title') or 'Venn'), fontsize=11)

    base = _base(args, 'venn')
    paths = _export(fig, base, args)
    return {
        'n_sets': n,
        'set_sizes': {labels[i]: len(sets[i]) for i in range(n)},
        'regions': info['regions'],
        'files': paths,
        'output_file': paths[0] if paths else None,
    }


# ============================================================================
# op: plot_upset
# ============================================================================

def op_plot_upset(args):
    """UpSet 图：任意集合数，按交集大小排序展示 top 交集。"""
    sets, labels = _read_groups(args)
    n = len(sets)
    if n > 12:
        raise ValueError('集合数 %d 过多（>12）；UpSet 点阵行数将不可读' % n)
    top_n = int(args.get('top_n') or 20)
    min_size = int(args.get('min_size') or 1)

    # 元素 -> 成员签名
    membership = {}
    for i, s in enumerate(sets):
        for x in s:
            membership.setdefault(x, []).append(i)
    combos = {}
    for x, mem in membership.items():
        if len(mem) < 2 and not args.get('include_singletons'):
            continue
        key = tuple(mem)
        combos[key] = combos.get(key, 0) + 1
    items = sorted([(cnt, key) for key, cnt in combos.items() if cnt >= min_size],
                   reverse=True)[:top_n]
    if not items:
        raise ValueError('没有满足条件的交集（min_size=%d；可设 include_singletons）' % min_size)
    items = items[::-1]  # 画图从左到右由大到小 -> 反转让 index 0 最小

    _setup_style(args)
    k = len(items)
    w = float(args.get('width') or max(6.0, 0.42 * k + 3.2))
    h = float(args.get('height') or (2.6 + 0.32 * n))
    fig = plt.figure(figsize=(w, h))
    gs = fig.add_gridspec(2, 1, height_ratios=[3, 1.15], hspace=0.06)

    ax_bar = fig.add_subplot(gs[0])
    ax_mat = fig.add_subplot(gs[1])

    xs = list(range(k))
    sizes = [cnt for (cnt, _) in items]
    ax_bar.bar(xs, sizes, color='#2B5F8A', width=0.62)
    for x, s in zip(xs, sizes):
        ax_bar.text(x, s, str(s), ha='center', va='bottom', fontsize=7)
    ax_bar.set_xlim(-0.7, k - 0.3)
    ax_bar.set_ylabel('Intersection size', fontsize=8)
    ax_bar.set_xticks([])
    for sp in ('top', 'right'):
        ax_bar.spines[sp].set_visible(False)

    # 点阵
    for row_i in range(n):
        ax_mat.plot([-0.7, k - 0.3], [row_i, row_i], color='#DDDDDD', lw=0.6, zorder=0)
    for x, (cnt, key) in zip(xs, items):
        members = set(key)
        ys = sorted(members)
        for row_i in range(n):
            if row_i in members:
                ax_mat.plot([x], [row_i], 'o', color='#2B5F8A', markersize=6, zorder=2)
            else:
                ax_mat.plot([x], [row_i], 'o', color='#DDDDDD', markersize=6, zorder=1)
        if len(ys) >= 2:
            ax_mat.plot([x, x], [min(ys), max(ys)], color='#2B5F8A', lw=1.6, zorder=1.5)
    ax_mat.set_yticks(range(n))
    ax_mat.set_yticklabels(['%s (%d)' % (labels[i], len(sets[i])) for i in range(n)], fontsize=7.5)
    ax_mat.set_xticks([])
    ax_mat.set_xlim(-0.7, k - 0.3)
    ax_mat.set_ylim(-0.6, n - 0.4)
    ax_mat.invert_yaxis()
    for sp in ('top', 'right', 'bottom'):
        ax_mat.spines[sp].set_visible(False)

    fig.suptitle(str(args.get('title') or 'UpSet'), fontsize=11, y=0.98)
    base = _base(args, 'upset')
    paths = _export(fig, base, args)
    return {
        'n_sets': n,
        'top_intersections': [{'sets': [labels[i] for i in key], 'size': cnt} for (cnt, key) in items[::-1]],
        'files': paths,
        'output_file': paths[0] if paths else None,
    }


# ============================================================================
# op: plot_enrichment
# ============================================================================

def _pick_col(cols, candidates):
    for c in cols:
        lc = str(c).lower()
        if any(k in lc for k in candidates):
            return c
    return None


def op_plot_enrichment(args):
    """富集条形图：自动列识别（term / p / count），-log10(p) 横向条形。"""
    path = _req_path(args, 'table')
    import numpy as np
    import pandas as pd
    try:
        df = pd.read_csv(path, sep=None, engine='python')
    except Exception as e:
        raise ValueError('富集表读取失败：%s' % e)
    if df.empty:
        raise ValueError('富集表为空')

    term_col = args.get('term_col') or _pick_col(df.columns, ['term', 'name', 'description', 'pathway'])
    p_col = args.get('p_col') or _pick_col(df.columns, ['adj', 'fdr', 'q_value', 'qvalue', 'p_value', 'pvalue', 'p-val', 'pval'])
    count_col = args.get('count_col') or _pick_col(df.columns, ['count', 'overlap', 'gene_num', 'n_genes'])
    if p_col is None and 'p' in [str(c).lower() for c in df.columns]:
        p_col = [c for c in df.columns if str(c).lower() == 'p'][0]
    if term_col is None or p_col is None:
        raise ValueError('无法识别列：term_col=%s p_col=%s（可用列：%s）'
                         % (term_col, p_col, ', '.join(map(str, df.columns))))

    d = df[[term_col, p_col] + ([count_col] if count_col else [])].copy()
    d[p_col] = pd.to_numeric(d[p_col], errors='coerce')
    d = d.dropna(subset=[p_col])
    if d.empty:
        raise ValueError('p 列没有有效数值')
    top_n = int(args.get('top_n') or 20)
    d = d.sort_values(p_col).head(top_n)
    d['neglogp'] = -np.log10(d[p_col].clip(lower=1e-300))

    _setup_style(args)
    terms = [str(t)[:48] for t in d[term_col]][::-1]
    vals = list(d['neglogp'])[::-1]
    counts = list(d[count_col])[::-1] if count_col else None
    w = float(args.get('width') or 7.2)
    h = float(args.get('height') or max(2.8, 0.34 * len(terms) + 1.4))
    fig, ax = plt.subplots(figsize=(w, h))
    y = range(len(terms))
    ax.barh(list(y), vals, color='#5B8DB8', height=0.62)
    if counts is not None:
        for yi, (v, c) in enumerate(zip(vals, counts)):
            try:
                cc = int(float(c))
            except (TypeError, ValueError):
                cc = None
            if cc is not None:
                ax.text(v + max(vals) * 0.01, yi, 'n=%d' % cc, va='center', fontsize=6.5, color='#333333')
    ax.set_yticks(list(y))
    ax.set_yticklabels(terms, fontsize=7.5)
    ax.set_xlabel(r'$-\log_{10}(p)$', fontsize=9)
    ax.set_title(str(args.get('title') or 'Enrichment (top %d)' % len(terms)), fontsize=10)
    for sp in ('top', 'right'):
        ax.spines[sp].set_visible(False)
    base = _base(args, 'enrichment')
    paths = _export(fig, base, args)
    return {
        'n_terms': len(terms),
        'columns': {'term': str(term_col), 'p': str(p_col), 'count': str(count_col) if count_col else None},
        'top_preview': [{'term': str(t), 'p': float(p)} for t, p in
                        zip(d[term_col].head(10), d[p_col].head(10))],
        'files': paths,
        'output_file': paths[0] if paths else None,
    }


# ============================================================================
# op: plot_domains
# ============================================================================

def op_plot_domains(args):
    """蛋白结构域示意图：每蛋白一轨道，域盒按名称着色。"""
    path = _req_path(args, 'table')
    import pandas as pd
    try:
        df = pd.read_csv(path, sep=None, engine='python')
    except Exception as e:
        raise ValueError('结构域表读取失败：%s' % e)
    if df.empty:
        raise ValueError('结构域表为空')

    cols = list(df.columns)
    c_prot = args.get('protein_col') or _pick_col(cols, ['protein', 'prot', 'id', 'name', 'gene'])
    c_start = args.get('start_col') or _pick_col(cols, ['start', 'begin', 'from'])
    c_end = args.get('end_col') or _pick_col(cols, ['end', 'stop', 'to'])
    c_dom = args.get('domain_col') or _pick_col(cols, ['domain', 'pfam', 'family', 'name'])
    c_len = args.get('length_col') or _pick_col(cols, ['protlen', 'length', 'protein_length'])
    if c_prot is None or c_start is None or c_end is None:
        raise ValueError('无法识别列（protein/start/end）：%s' % ', '.join(map(str, cols)))

    import numpy as np
    prots = {}
    order = []
    for _, row in df.iterrows():
        pid = str(row[c_prot])
        try:
            a, b = int(float(row[c_start])), int(float(row[c_end]))
        except (TypeError, ValueError):
            continue
        if b < a:
            a, b = b, a
        if pid not in prots:
            prots[pid] = {'domains': [], 'len': None}
            order.append(pid)
        dname = str(row[c_dom]) if c_dom else 'domain'
        prots[pid]['domains'].append((a, b, dname))
        if c_len:
            try:
                prots[pid]['len'] = max(prots[pid]['len'] or 0, int(float(row[c_len])))
            except (TypeError, ValueError):
                pass
    if not order:
        raise ValueError('没有解析到任何结构域记录')
    max_prot = int(args.get('max_proteins') or 25)
    sort_by = str(args.get('sort') or 'none').lower()
    if sort_by == 'length':
        order.sort(key=lambda p: prots[p]['len'] or max(b for (_, b, _) in prots[p]['domains']),
                   reverse=True)
    elif sort_by == 'name':
        order.sort()
    order = order[:max_prot]

    # 域名字 -> 颜色（Okabe-Ito 循环）
    pal = ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9', '#F0E442', '#666666']
    names = []
    for pid in order:
        for (_, _, n) in prots[pid]['domains']:
            if n not in names:
                names.append(n)
    color = {n: pal[i % len(pal)] for i, n in enumerate(names)}

    _setup_style(args)
    n = len(order)
    w = float(args.get('width') or 9.5)
    h = float(args.get('height') or max(1.6, 0.5 * n + 1.2))
    fig, axes = plt.subplots(n, 1, figsize=(w, h), squeeze=False)
    axes = [a[0] for a in axes]
    for i, pid in enumerate(order):
        ax = axes[i]
        p = prots[pid]
        L = p['len'] or max(b for (_, b, _) in p['domains'])
        ax.hlines(0.5, 0, L, color='#444444', lw=1.4)
        level = {}
        for (a, b, dn) in sorted(p['domains']):
            lv = level.get(dn, 0)
            y = 0.5 + (0.22 if lv % 2 else -0.22)
            ax.add_patch(Rectangle((a, y - 0.09), max(b - a, L * 0.004), 0.18,
                                   facecolor=color[dn], edgecolor='black', lw=0.4, alpha=0.95))
            if (b - a) > L * 0.03:
                ax.text((a + b) / 2, y + (0.13 if lv % 2 else -0.16), dn,
                        fontsize=6, ha='center', va='center')
            level[dn] = lv + 1
        ax.set_xlim(-L * 0.02, L * 1.02)
        ax.set_ylim(0, 1)
        ax.set_yticks([])
        ax.text(-L * 0.015, 0.5, '%s (%daa)' % (pid, L), fontsize=7.5, ha='right', va='center')
        for sp in ('top', 'right', 'left'):
            ax.spines[sp].set_visible(False)
        ax.tick_params(axis='x', labelsize=6, length=2)
    axes[-1].set_xlabel('Protein position (aa)', fontsize=8)
    fig.suptitle(str(args.get('title') or 'Protein domains'), fontsize=10)
    base = _base(args, 'domains')
    paths = _export(fig, base, args)
    return {
        'n_proteins': n,
        'n_domain_types': len(names),
        'domain_types': names[:30],
        'proteins': order[:50],
        'files': paths,
        'output_file': paths[0] if paths else None,
    }
