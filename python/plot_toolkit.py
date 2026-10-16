"""dsh-bio-genie 可视化工具箱 —— 基因组注释可视化（批次 B1）

  - plot_gene_structure  基因结构图（外显子-内含子，多基因轨道）
  - plot_gene_locations  基因位置图（染色体条带 + 基因标记 + 高亮）
  - plot_gene_density    基因密度图（滑窗密度曲线）

全部走 figurelib 出版级样式与导出（PNG/SVG/PDF，300dpi，字体嵌入）。
"""
import os
import re

import matplotlib
matplotlib.use('Agg')  # 非交互进程必须（在任何 pyplot 导入之前）
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

from gff_toolkit import parse_gff, _merge_intervals, _pick_attr  # noqa: E402
from seq_toolkit import _req_path, _out_path  # noqa: E402

_DEFAULT_FORMATS = ['png', 'svg']


def _setup_style(args):
    from figurelib.setup_style import setup_style
    lang = str(args.get('lang') or 'zh')
    return setup_style(journal=str(args.get('journal') or 'general'), lang=lang)


def _base(args, default_name):
    v = args.get('output_file')
    if v:
        base = os.path.abspath(v)
        for ext in ('.png', '.svg', '.pdf', '.jpg', '.jpeg', '.tif', '.tiff'):
            if base.lower().endswith(ext):
                base = base[: -len(ext)]
                break
        return base
    return os.path.abspath(default_name)


def _formats(args):
    fmts = args.get('formats') or _DEFAULT_FORMATS
    if isinstance(fmts, str):
        fmts = [x.strip() for x in fmts.split(',') if x.strip()]
    return [f.lower().lstrip('.') for f in fmts]


def _export(fig, base, args):
    from figurelib.export_figure import export_figure
    paths = export_figure(fig, base, formats=_formats(args), dpi=int(args.get('dpi') or 300))
    plt.close(fig)
    return paths


def _sel_ids(args):
    ids = args.get('ids') or []
    if isinstance(ids, str):
        ids = [x.strip() for x in re.split(r'[,;\s]+', ids) if x.strip()]
    return set(ids)


# ============================================================================
# op: plot_gene_structure —— 基因结构图
# ============================================================================

def _gene_models(rows, want_ids, max_genes):
    """把 GFF 行组织为基因模型列表。

    返回 [{id, seqid, strand, span(start,end), exons[(a,b)], cds[(a,b)], has_utr}]
    """
    genes = {}
    order = []
    for r in rows:
        if r['type'] != 'gene':
            continue
        gid = _pick_attr(r['attrs'], ['ID', 'gene_id', 'Name'])
        if not gid:
            gid = '@@%s_%d' % (r['seqid'], r['start'])
        if want_ids and gid not in want_ids and r['attrs'].get('Name') not in want_ids:
            continue
        if gid not in genes:
            genes[gid] = {'id': gid, 'seqid': r['seqid'], 'strand': r['strand'],
                          'span': (r['start'], r['end']), 'exons': [], 'cds': [],
                          'display': r['attrs'].get('Name') or gid}
            order.append(gid)
    if not genes:
        # 无 gene 行：用 mRNA/CDS 兜底
        for r in rows:
            if r['type'] not in ('mRNA', 'CDS'):
                continue
            gid = _pick_attr(r['attrs'], ['Parent', 'ID'])
            base = gid.split(':')[0] if gid else '@@%s_%d' % (r['seqid'], r['start'])
            if want_ids and base not in want_ids and gid not in want_ids:
                continue
            if base not in genes:
                genes[base] = {'id': base, 'seqid': r['seqid'], 'strand': r['strand'],
                               'span': (r['start'], r['end']), 'exons': [], 'cds': [],
                               'display': base}
                order.append(base)
            g = genes[base]
            g['span'] = (min(g['span'][0], r['start']), max(g['span'][1], r['end']))
            if r['type'] == 'CDS':
                g['cds'].append((r['start'], r['end']))

    # mRNA/transcript -> gene 映射（exon/CDS 的 Parent 通常指向转录本）
    t2g = {}
    for r in rows:
        if r['type'] in ('mRNA', 'transcript'):
            tid = _pick_attr(r['attrs'], ['ID'])
            owner = _pick_attr(r['attrs'], ['Parent'])
            if tid and owner:
                t2g[tid] = owner

    # 归属 exon / CDS（Parent 链：exon -> mRNA -> gene）
    for gid, g in genes.items():
        gset = set()
        cset = set()
        for r in rows:
            if r['type'] not in ('exon', 'CDS'):
                continue
            parent = _pick_attr(r['attrs'], ['Parent', 'ID'])
            owner = t2g.get(parent, parent) if parent else ''
            if owner and (owner == gid or owner.startswith(gid + '.') or owner.startswith(gid + ':')):
                if r['type'] == 'exon':
                    gset.add((r['start'], r['end']))
                else:
                    cset.add((r['start'], r['end']))
        if gset:
            g['exons'] = _merge_intervals(sorted(gset))
        if cset:
            g['cds'] = _merge_intervals(sorted(cset))
        if not g['cds']:
            for r in rows:
                if r['type'] == 'CDS' and r['seqid'] == g['seqid'] and r['start'] >= g['span'][0] and r['end'] <= g['span'][1]:
                    g['cds'].append((r['start'], r['end']))
            g['cds'] = _merge_intervals(sorted(set(g['cds'])))
        g['has_utr'] = bool(g['exons']) and bool(g['cds'])

    out = [genes[g] for g in order]
    if max_genes and len(out) > max_genes:
        out = out[:max_genes]
    return out


def op_plot_gene_structure(args):
    """基因结构图：每基因一轨道，外显子盒 + 内含子线 + 链方向。"""
    gff = _req_path(args, 'gff')
    max_genes = int(args.get('max_genes') or 20)
    width = float(args.get('width') or 10.0)
    want = _sel_ids(args)

    rows, bad = parse_gff(gff)
    models = _gene_models(rows, want, max_genes)
    if not models:
        raise ValueError('没有找到可绘制的基因（检查 ids 过滤或 GFF 是否含 gene 行）')

    _setup_style(args)
    n = len(models)
    fig_h = max(1.2, 0.62 * n + 1.0)
    fig, axes = plt.subplots(n, 1, figsize=(width, fig_h), squeeze=False)
    axes = [a[0] for a in axes]

    exon_c, cds_c, line_c = '#7BAFD4', '#2B5F8A', '#444444'
    for i, g in enumerate(models):
        ax = axes[i]
        s0, s1 = g['span']
        pad = max(30, (s1 - s0) * 0.02)
        ax.hlines(0.5, s0, s1, color=line_c, lw=1.2, zorder=1)
        blocks = g['exons'] if g['exons'] else (g['cds'] if g['cds'] else [(s0, s1)])
        for (a, b) in blocks:
            ax.add_patch(Rectangle((a, 0.28), max(b - a + 1, (s1 - s0) * 0.002), 0.44,
                                   facecolor=exon_c if g['exons'] else cds_c,
                                   edgecolor='black', lw=0.5, zorder=2))
        # 链方向小箭头
        mark = '→' if g['strand'] != '-' else '←'
        ax.text(s1 + pad * 0.15, 0.5, mark, va='center', ha='left', fontsize=9)
        ax.text(s1 + pad * 0.78, 0.5, '%s (%s, %dbp)' % (g['display'], g['strand'], s1 - s0 + 1),
                va='center', ha='left', fontsize=7.5, color='#333333')
        ax.set_xlim(s0 - pad * 0.2, s1 + pad * (2.6 if len(g['display']) < 26 else 3.4))
        ax.set_ylim(0, 1)
        ax.set_yticks([])
        for sp in ('top', 'right', 'left'):
            ax.spines[sp].set_visible(False)
        ax.tick_params(axis='x', labelsize=6, length=2)

    axes[-1].set_xlabel('Genomic position (bp)', fontsize=8)
    fig.suptitle(str(args.get('title') or 'Gene structure'), fontsize=10)
    base = _base(args, 'gene_structure')
    paths = _export(fig, base, args)
    return {
        'n_genes': n,
        'genes': [{'id': g['id'], 'exons': len(g['exons']), 'length_bp': g['span'][1] - g['span'][0] + 1} for g in models[:30]],
        'bad_lines': bad,
        'files': paths,
        'output_file': paths[0] if paths else None,
    }


# ============================================================================
# op: plot_gene_locations —— 基因位置图
# ============================================================================

def op_plot_gene_locations(args):
    """基因位置图：染色体条带 + 基因标记；highlight 基因用红点加标签。"""
    gff = _req_path(args, 'gff')
    chroms = args.get('chroms') or []
    if isinstance(chroms, str):
        chroms = [x.strip() for x in chroms.split(',') if x.strip()]
    highlight = _sel_ids(args)
    width = float(args.get('width') or 11.0)
    max_label = int(args.get('max_labels') or 30)

    rows, bad = parse_gff(gff)
    gene_rows = [r for r in rows if r['type'] == 'gene']
    if not gene_rows:
        gene_rows = [r for r in rows if r['type'] == 'mRNA']
    genes = []
    chrom_max = {}
    for r in gene_rows:
        if chroms and r['seqid'] not in chroms:
            continue
        mid = (r['start'] + r['end']) / 2.0
        gid = _pick_attr(r['attrs'], ['ID', 'Name', 'Parent', 'gene_id']) or ''
        genes.append((r['seqid'], mid, gid))
        chrom_max[r['seqid']] = max(chrom_max.get(r['seqid'], 0), r['end'])
    if not genes:
        raise ValueError('没有可绘制的基因（检查 chroms 过滤）')
    order = [c for c in (chroms or sorted(chrom_max))]
    order = [c for c in order if c in chrom_max]

    _setup_style(args)
    n = len(order)
    fig_h = max(1.4, 0.42 * n + 1.1)
    fig, axes = plt.subplots(n, 1, figsize=(width, fig_h), squeeze=False)
    axes = [a[0] for a in axes]
    labeled = 0
    for i, c in enumerate(order):
        ax = axes[i]
        L = chrom_max[c]
        ax.add_patch(Rectangle((0, 0.42), L, 0.16, facecolor='#D9D9D9', edgecolor='#999999', lw=0.4))
        sub = [(p, gid) for (cc, p, gid) in genes if cc == c]
        xs = [p for (p, _) in sub]
        ax.plot(xs, [0.5] * len(xs), '|', color='#2B5F8A', markersize=6, markeredgewidth=0.7)
        for (p, gid) in sub:
            if gid in highlight:
                ax.plot([p], [0.5], 'o', color='#C0392B', markersize=3.4, zorder=5)
                if labeled < max_label:
                    ax.text(p, 0.78, gid, fontsize=6.5, ha='center', va='bottom', color='#C0392B', rotation=45)
                    labeled += 1
        ax.set_xlim(-L * 0.01, L * 1.03)
        ax.set_ylim(0.2, 1.05)
        ax.set_yticks([])
        ax.text(-L * 0.012, 0.5, c, fontsize=8, ha='right', va='center')
        for sp in ('top', 'right', 'left'):
            ax.spines[sp].set_visible(False)
        ax.tick_params(axis='x', labelsize=6, length=2)
        ax.set_xlabel('Position (bp)', fontsize=7)

    fig.suptitle(str(args.get('title') or 'Gene locations'), fontsize=10)
    base = _base(args, 'gene_locations')
    paths = _export(fig, base, args)
    return {
        'n_chroms': n,
        'n_genes': len(genes),
        'n_highlighted': sum(1 for (_, _, gid) in genes if gid in highlight),
        'files': paths,
        'output_file': paths[0] if paths else None,
    }


# ============================================================================
# op: plot_gene_density —— 基因密度图
# ============================================================================

def op_plot_gene_density(args):
    """基因密度：按窗口统计每染色体基因数（counts 或 per-Mb），曲线/阶梯图。"""
    gff = _req_path(args, 'gff')
    window = int(args.get('window') or 100000)
    if window < 1:
        raise ValueError('window 必须为正整数（bp）')
    chroms = args.get('chroms') or []
    if isinstance(chroms, str):
        chroms = [x.strip() for x in chroms.split(',') if x.strip()]
    per_mb = bool(args.get('per_mb', False))
    width = float(args.get('width') or 11.0)

    rows, bad = parse_gff(gff)
    spans = {}
    starts = {}
    for r in rows:
        if r['type'] != 'gene':
            continue
        if chroms and r['seqid'] not in chroms:
            continue
        spans[r['seqid']] = max(spans.get(r['seqid'], 0), r['end'])
        starts.setdefault(r['seqid'], []).append(r['start'])
    if not starts:
        raise ValueError('没有基因记录（检查 chroms 过滤）')
    order = [c for c in (chroms or sorted(starts))]
    order = [c for c in order if c in starts]

    _setup_style(args)
    n = len(order)
    fig, axes = plt.subplots(n, 1, figsize=(width, max(1.4, 0.5 * n + 1.1)), squeeze=False)
    axes = [a[0] for a in axes]
    out_stats = []
    for i, c in enumerate(order):
        ax = axes[i]
        L = spans[c]
        nb = max(1, (L + window - 1) // window)
        counts = [0] * nb
        for s in starts[c]:
            counts[min(nb - 1, (s - 1) // window)] += 1
        xs = [(j + 0.5) * window / 1e6 for j in range(nb)]
        ys = [cnt * (1e6 / window) if per_mb else cnt for cnt in counts]
        ax.fill_between(xs, 0, ys, step='mid', color='#7BAFD4', alpha=0.85, lw=0)
        ax.set_xlim(0, L / 1e6)
        ax.set_ylabel('genes/Mb' if per_mb else 'genes', fontsize=7)
        ax.text(-L / 1e6 * 0.012, max(ys) * 0.5 if max(ys) else 0.5, c, fontsize=8, ha='right', va='center')
        ax.tick_params(labelsize=6)
        for sp in ('top', 'right'):
            ax.spines[sp].set_visible(False)
        out_stats.append({'chrom': c, 'bins': nb, 'genes': len(starts[c])})
    axes[-1].set_xlabel('Position (Mb)', fontsize=8)
    fig.suptitle(str(args.get('title') or 'Gene density (window=%dkb)' % (window // 1000)), fontsize=10)
    base = _base(args, 'gene_density')
    paths = _export(fig, base, args)
    return {
        'window': window,
        'per_mb': per_mb,
        'chroms': out_stats,
        'files': paths,
        'output_file': paths[0] if paths else None,
    }
