"""dsh-bio-genie 可视化工具箱 —— 共线性与基因组环图（批次 C4）

  - plot_synteny   共线性可视化（双物种条带连线图 / 点阵图；读 .collinearity 格式）
  - plot_circos    基因组环图（染色体弧 + 基因密度轨道；纯 matplotlib 极坐标）

全部走 figurelib 出版级样式与导出。
"""
import os
import re

import matplotlib
matplotlib.use('Agg')  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

from seq_toolkit import _req_path  # noqa: E402
from plot_toolkit import _setup_style, _base, _export  # noqa: E402


# ============================================================================
# .collinearity 解析（消费格式）
# ============================================================================

def parse_collinearity(path):
    """解析 .collinearity：返回 (blocks, params)。

    block = {index, score, e_value, n, mol_pair, orient, anchors:[(g1,g2)]}
    """
    blocks = []
    params = {}
    cur = None
    blk_pat = re.compile(r'^##\s*Alignment\s+(\d+):\s*score=([\d.-]+)\s+e_value=([\d.eE+-]+)\s+N=(\d+)\s+(\S+)\s+(plus|minus)')
    anchor_pat = re.compile(r'^\s*(\d+)-\s*(\d+):\s*(\S+)\s+(\S+)\s+(\S+)')
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        for ln in fh:
            ln = ln.rstrip('\r\n')
            if ln.startswith('# MATCH_SCORE:'):
                params['match_score'] = ln.split(':', 1)[1].strip()
            elif ln.startswith('##'):
                m = blk_pat.match(ln)
                if m:
                    if cur:
                        blocks.append(cur)
                    cur = {'index': int(m.group(1)), 'score': float(m.group(2)),
                           'e_value': m.group(3), 'n': int(m.group(4)),
                           'mol_pair': m.group(5), 'orient': m.group(6), 'anchors': []}
            elif ln.startswith('#'):
                continue
            elif cur is not None:
                m = anchor_pat.match(ln)
                if m:
                    cur['anchors'].append((m.group(3), m.group(4)))
    if cur:
        blocks.append(cur)
    if not blocks:
        raise ValueError('没有解析到任何共线性块：%s' % path)
    return blocks, params


def _read_gff_positions(path):
    """读 4 列 GFF -> {mol: {gene: pos}} + {mol: max_pos}。

    坐标语义与共线性分析一致（取第 3 列作为基因位置）。
    """
    pos = {}
    maxpos = {}
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        for ln in fh:
            cells = ln.rstrip('\r\n').split('\t')
            if len(cells) < 3:
                continue
            try:
                p = int(cells[2])
            except ValueError:
                continue
            pos.setdefault(cells[0], {})[cells[1]] = p
            if p > maxpos.get(cells[0], 0):
                maxpos[cells[0]] = p
    return pos, maxpos


# ============================================================================
# op: plot_synteny
# ============================================================================

def op_plot_synteny(args):
    """共线性可视化：双物种条带连线图（bands）或点阵图（dotplot）。"""
    col_path = _req_path(args, 'collinearity')
    gff_path = _req_path(args, 'gff')
    view = str(args.get('view') or 'bands').lower()
    if view not in ('bands', 'dotplot'):
        raise ValueError("view 仅支持 bands / dotplot")
    max_lines = int(args.get('max_lines') or 200)
    width = float(args.get('width') or 11.0)
    height = float(args.get('height') or (5.0 if view == 'bands' else 7.5))

    blocks, _params = parse_collinearity(col_path)
    _pos, maxpos = _read_gff_positions(gff_path)

    # 物种对选择：默认取块数最多的前缀对
    pref = args.get('species_pair')
    if pref:
        pa, pb = pref.split('&') if '&' in str(pref) else (pref, pref)
        pa, pb = pa.strip(), pb.strip()
    else:
        counts = {}
        for b in blocks:
            a, _, c = b['mol_pair'].partition('&')
            key = (a[:2], c[:2])
            counts[key] = counts.get(key, 0) + 1
        if not counts:
            raise ValueError('无法从 mol_pair 提取物种前缀')
        (pa, pb), _ = max(counts.items(), key=lambda kv: kv[1])

    mols_a = sorted(m for m in maxpos if m.startswith(pa))
    mols_b = sorted(m for m in maxpos if m.startswith(pb))
    if not mols_a or not mols_b:
        raise ValueError('物种前缀 %s / %s 在 GFF 中没有对应染色体' % (pa, pb))

    def layout(mols):
        """染色体横向排布：返回 {mol: (x0, x1)} 与总宽（含间隙）。"""
        gap = max(1, int(sum(maxpos.values()) * 0.004))
        out = {}
        x = 0
        for m in mols:
            L = maxpos.get(m, 1)
            out[m] = (x, x + L)
            x += L + gap
        return out, x

    la, total_a = layout(mols_a)
    lb, total_b = layout(mols_b)

    sel = [b for b in blocks if b['mol_pair'].startswith(pa) and '&' + pb in b['mol_pair']]
    if not sel:
        raise ValueError('物种对 %s&%s 没有共线性块（前缀提取自 mol_pair，可显式指定 species_pair）' % (pa, pb))
    sel = sel[:max_lines]

    _setup_style(args)
    fig, ax = plt.subplots(figsize=(width, height))

    if view == 'bands':
        bar_h = 0.12
        for m, (x0, x1) in la.items():
            ax.add_patch(Rectangle((x0, 0.80), x1 - x0, bar_h, facecolor='#B8CFE4', edgecolor='#333333', lw=0.5))
            ax.text((x0 + x1) / 2, 0.95, m, ha='center', va='bottom', fontsize=7, rotation=30)
        for m, (x0, x1) in lb.items():
            ax.add_patch(Rectangle((x0, 0.08), x1 - x0, bar_h, facecolor='#E4CFB8', edgecolor='#333333', lw=0.5))
            ax.text((x0 + x1) / 2, 0.04, m, ha='center', va='top', fontsize=7, rotation=30)
        for b in sel:
            m1 = m2 = None
            p1 = p2 = None
            for mol in mols_a:
                if b['anchors'][0][0] in _pos.get(mol, {}):
                    m1, p1 = mol, _pos[mol][b['anchors'][0][0]]
                    break
            for mol in mols_b:
                if b['anchors'][0][1] in _pos.get(mol, {}):
                    m2, p2 = mol, _pos[mol][b['anchors'][0][1]]
                    break
            if m1 is None or m2 is None:
                continue
            xA = la[m1][0] + p1
            xB = lb[m2][0] + p2
            color = '#2B5F8A' if b['orient'] == 'plus' else '#C0392B'
            ax.plot([xA, xB], [0.80, 0.20], color=color, lw=0.6, alpha=0.45)
        ax.set_xlim(-total_a * 0.01, max(total_a, total_b) * 1.01)
        ax.set_ylim(0, 1.02)
        ax.set_yticks([])
        ax.set_xticks([])
        for sp in ('top', 'right', 'left', 'bottom'):
            ax.spines[sp].set_visible(False)
        ax.set_title(str(args.get('title') or 'Synteny: %s vs %s (%d blocks)' % (pa, pb, len(sel))), fontsize=10)
    else:
        # dotplot：x = A 拼接坐标，y = B 拼接坐标；块着色
        pal = ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#CC79A7', '#56B4E9']
        n_drawn = 0
        for i, b in enumerate(sel):
            c = pal[i % len(pal)]
            xs, ys = [], []
            for (g1, g2) in b['anchors']:
                x = y = None
                for mol in mols_a:
                    if g1 in _pos.get(mol, {}):
                        x = la[mol][0] + _pos[mol][g1]
                        break
                for mol in mols_b:
                    if g2 in _pos.get(mol, {}):
                        y = lb[mol][0] + _pos[mol][g2]
                        break
                if x is not None and y is not None:
                    xs.append(x)
                    ys.append(y)
            if xs:
                ax.scatter(xs, ys, s=2.5, color=c, alpha=0.8, linewidths=0, label=b['mol_pair'])
                n_drawn += 1
        for m, (x0, x1) in la.items():
            ax.axvline(x0, color='#DDDDDD', lw=0.4, zorder=0)
        for m, (x0, x1) in lb.items():
            ax.axhline(x0, color='#DDDDDD', lw=0.4, zorder=0)
        ax.set_xlabel('%s concatenated position (bp)' % pa, fontsize=8)
        ax.set_ylabel('%s concatenated position (bp)' % pb, fontsize=8)
        ax.tick_params(labelsize=6)
        ax.set_title(str(args.get('title') or 'Synteny dotplot: %s vs %s (%d blocks)' % (pa, pb, n_drawn)), fontsize=10)
        if n_drawn <= 12:
            ax.legend(fontsize=6, loc='upper right', framealpha=0.8)

    base = _base(args, 'synteny')
    paths = _export(fig, base, args)
    return {
        'species_pair': [pa, pb],
        'view': view,
        'n_blocks_drawn': len(sel),
        'chroms': {'a': mols_a, 'b': mols_b},
        'files': paths,
        'output_file': paths[0] if paths else None,
    }


# ============================================================================
# op: plot_circos
# ============================================================================

def op_plot_circos(args):
    """基因组环图：染色体弧 + 基因密度轨道（极坐标）。"""
    gff_path = _req_path(args, 'gff')
    window = int(args.get('window') or 500000)
    width = float(args.get('width') or 8.0)
    title = str(args.get('title') or 'Genome overview (circos)')

    pos, maxpos = _read_gff_positions(gff_path)
    gene_pos = {mol: sorted(d.values()) for mol, d in pos.items()}
    mols = sorted(maxpos)
    if not mols:
        raise ValueError('GFF 中没有可用染色体')

    total = sum(maxpos[m] for m in mols)
    gap_frac = 0.02 / max(1, len(mols))

    _setup_style(args)
    fig = plt.figure(figsize=(width, width))
    ax = fig.add_subplot(111, projection='polar')
    ax.set_theta_offset(3.14159265 / 2)
    ax.set_theta_direction(-1)
    ax.set_yticklabels([])
    ax.set_xticklabels([])
    ax.grid(False)

    start = 0.0
    pal = plt.get_cmap('tab20')
    for i, m in enumerate(mols):
        span = 2 * 3.14159265 * (maxpos[m] / total) - gap_frac * 2 * 3.14159265
        end = start + max(0.001, span)
        # 染色体弧（外圈）
        theta = [start + (end - start) * t / 60 for t in range(61)]
        ax.plot(theta, [1.0] * 61, color='#333333', lw=1.2)
        ax.fill_between(theta, 0.985, 1.0, color=pal(i % 20), alpha=0.55)
        mid = (start + end) / 2
        ax.text(mid, 1.08, m, ha='center', va='center', fontsize=6.5, rotation=0)
        # 密度轨道（内圈，基因数/窗口）
        genes = gene_pos.get(m, [])
        if genes:
            nb = max(1, (maxpos[m] + window - 1) // window)
            counts = [0] * nb
            for p in genes:
                counts[min(nb - 1, (p - 1) // window)] += 1
            vmax = max(counts) or 1
            for j, c in enumerate(counts):
                t0 = start + (end - start) * j / nb
                t1 = start + (end - start) * (j + 1) / nb
                h = 0.10 + 0.42 * (c / vmax)
                ax.bar((t0 + t1) / 2, h, width=max(0.002, (t1 - t0) * 0.9),
                       bottom=0.42, color='#2B5F8A', alpha=0.85, linewidth=0)
        start = end + gap_frac * 2 * 3.14159265

    ax.set_ylim(0, 1.15)
    fig.suptitle(title, fontsize=11)
    base = _base(args, 'circos')
    paths = _export(fig, base, args)
    return {
        'n_chroms': len(mols),
        'total_bp': total,
        'window': window,
        'chroms': [{'mol': m, 'length': maxpos[m], 'genes': len(gene_pos.get(m, []))} for m in mols[:30]],
        'files': paths,
        'output_file': paths[0] if paths else None,
    }
