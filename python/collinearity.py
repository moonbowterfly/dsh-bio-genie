"""dsh-bio-genie 共线性分析 —— 独立实现（批次 C 核心）

算法依据（全部为公开文献与开放许可的算法描述）：
  - DAGchainer 链化算法：Haas et al. 2004, Bioinformatics（动态规划 + 缺口罚分）
  - 共线性块统计检验：Wang et al. 2006, BMC Bioinformatics 7:447（置换检验 E-value）
  - 参数与输出格式的生态兼容规格：Wang et al. 2012, Nucleic Acids Research 40(7):e49
    （.collinearity 交换格式 → 可被生态内下游工具消费）

实现说明：本文件为独立的 Python 实现（行为规格按公开格式规范与文献编写）。
核心行为要点（与生态兼容所需的精确语义）：
  - 基因距离用「基因秩」（全基因组按 (mol, mid, name) 排序后编号），非碱基距离
  - 锚点折叠：按 x 轴（再 y 轴）扫描，同轴邻域 ≤ overlap_window 的连续段只保留一条
  - DP：path_score 初值=MATCH_SCORE；num_gaps = max(del_x, del_y)；
    del_x > MAX_GAPS break（提前中断）；del_y > MAX_GAPS continue（顺序敏感）
  - 迭代剥离：提取链后标记消费；候选链与已消费节点冲突时删除消费节点重跑 DP
  - 双方向：正向 + 反向（y → Max_Y - y + 1）各跑一次
  - 显著性：E = 2·P(N,m)·∏(l1i·l2i)/(L1·L2)^(m-1)，对数域计算（ln_fact 阶乘/Stirling 分段）
  - 输出 .collinearity：与生态 printf 级兼容
"""
import math
import os
import sys

M_LN2 = 0.69314718055994530942


def _log(x):
    """C 语言 log() 语义：x<=0 时为 -inf（不抛异常）。"""
    if x <= 0:
        return float('-inf')
    return math.log(x)


def _exp(x):
    """C 语言 exp() 语义：溢出为 inf。"""
    try:
        return math.exp(x)
    except OverflowError:
        return float('inf')


def _fact(x):
    """x! —— 循环连乘（与生态实现同序）。"""
    ans = 1.0
    while x > 1:
        ans *= x
        x -= 1
    return ans


def _ln_fact(x):
    """ln(x!)：x<12 用精确阶乘，否则 Stirling（含 Knuth 修正项）。"""
    if x < 12:
        return math.log(_fact(x))
    dx = float(x)
    invx = 1.0 / dx
    invx2 = invx * invx
    invx3 = invx2 * invx
    invx5 = invx3 * invx2
    invx7 = invx5 * invx2
    s = (dx + 0.5) * math.log(dx) - dx
    s += math.log(2 * math.pi) / 2
    s += invx / 12 - invx3 / 360
    s += invx5 / 1260 - invx7 / 1680
    return s


def _ln_perm(n, r):
    """ln P(n, r) —— r>n 或 r<=0 时返回 0（与生态实现一致的保护）。"""
    if r > n or r <= 0:
        return 0.0
    return _ln_fact(n) - _ln_fact(n - r)


# ============================================================================
# 参数
# ============================================================================

class Params:
    def __init__(self, match_score=50, match_size=5, gap_penalty=-1, e_value=1e-5,
                 max_gaps=25, overlap_window=5, in_synteny=0):
        self.match_score = int(match_score)
        self.match_size = int(match_size)
        self.gap_penalty = int(gap_penalty)
        self.e_value = float(e_value)
        self.max_gaps = int(max_gaps)
        self.overlap_window = int(overlap_window)
        self.in_synteny = int(in_synteny)  # 0=种内+种间 / 1=仅种内 / 2=仅种间
        self.cutoff_score = self.match_score * self.match_size


# ============================================================================
# 输入层
# ============================================================================

class Gene:
    __slots__ = ('name', 'mol', 'mid', 'gene_id')

    def __init__(self, name, mol, mid):
        self.name = name
        self.mol = mol
        self.mid = mid
        self.gene_id = 0


def read_gff(path):
    """读 4 列 Tab GFF：sp# / gene / start / end（仅用第 3 列作为 mid）。

    重复基因名 fail-closed（生态要求 GFF 内基因唯一）。
    """
    gene_map = {}
    dups = []
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        for ln in fh:
            ln = ln.rstrip('\r\n')
            if not ln:
                continue
            cells = ln.split('\t')
            if len(cells) < 3:
                raise ValueError('GFF 行少于 3 列（需 sp#/gene/start/end）：%s' % ln[:80])
            mol, name = cells[0], cells[1]
            try:
                mid = int(cells[2])
            except ValueError:
                raise ValueError('GFF 第 3 列（start）非整数：%s' % ln[:80])
            if name in gene_map:
                dups.append(name)
                continue
            gene_map[name] = Gene(name, mol, mid)
    if dups:
        raise ValueError('GFF 中基因重复出现（生态要求唯一）：%s%s'
                         % (', '.join(dups[:5]), ' …' if len(dups) > 5 else ''))
    if not gene_map:
        raise ValueError('GFF 中没有解析到任何基因：%s' % path)
    return gene_map


def read_blast(path, gene_map, params):
    """读 12 列 BLAST（-outfmt 6 / -m8）：取列 1、2、12（E-value）。

    行为规格：
      - 同一基因对（字典序归一）保留最小 E-value
      - 同基因名对丢弃
      - 基因须在 GFF 中；mol_pair 按 mol 字典序稳定定序（同 mol 按 mid 排序基因侧）
    """
    blast_map = {}
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        for ln in fh:
            if not ln.strip():
                continue
            cells = ln.rstrip('\r\n').split('\t')
            if len(cells) < 11:
                continue
            g1, g2 = cells[0], cells[1]
            try:
                ev = float(cells[10])  # outfmt 6 标准第 11 列 = E-value
            except ValueError:
                continue
            if g1 == g2:
                continue
            key = (g1, g2) if g1 < g2 else (g2, g1)
            cur = blast_map.get(key)
            if cur is None or ev < cur:
                blast_map[key] = ev

    match_list = []
    mol_pairs = {}
    for (g1, g2) in sorted(blast_map.keys()):
        ev = blast_map[(g1, g2)]
        gf1 = gene_map.get(g1)
        gf2 = gene_map.get(g2)
        if gf1 is None or gf2 is None:
            continue
        if not gf1.mol or not gf2.mol:
            continue
        if params.in_synteny == 1 and gf1.mol[:2] != gf2.mol[:2]:
            continue
        i = (gf1.mol > gf2.mol) - (gf1.mol < gf2.mol)
        if i < 0:
            gene1, gene2 = g1, g2
            mol_pair = gf1.mol + '&' + gf2.mol
        elif i == 0:
            if gf1.mid <= gf2.mid:
                gene1, gene2 = g1, g2
            else:
                gene1, gene2 = g2, g1
            mol_pair = gf1.mol + '&' + gf2.mol
        else:
            gene1, gene2 = g2, g1
            mol_pair = gf2.mol + '&' + gf1.mol
        if params.in_synteny != 2 or gf1.mol[:2] != gf2.mol[:2]:
            mol_pairs[mol_pair] = mol_pairs.get(mol_pair, 0) + 1
        match_list.append({'gene1': gene1, 'gene2': gene2, 'mol_pair': mol_pair,
                           'pair_id': len(match_list), 'score': ev})
    return match_list, mol_pairs


# ============================================================================
# 锚点折叠层
# ============================================================================

def _filter_matches_x(score, params):
    """按 (x,y) 排序后扫描：同一 x 且相邻 y 距 ≤ overlap_window 的连续段为 bin，
    bin 内保留一条（行为=排序后第一条——生态实现的 min 比较器在等值时取首项）。"""
    score.sort(key=lambda s: (s['x'], s['y']))
    if not score:
        return score
    out = []
    bin_first = score[0]
    prev = score[0]
    for cur in score[1:]:
        if prev['x'] != cur['x'] or (cur['y'] - prev['y']) > params.overlap_window:
            out.append(bin_first)
            bin_first = cur
        prev = cur
    out.append(bin_first)
    return out


def _filter_matches_y(score, params):
    """按 (y,x) 排序后同上（对调轴）。"""
    score.sort(key=lambda s: (s['y'], s['x']))
    if not score:
        return score
    out = []
    bin_first = score[0]
    prev = score[0]
    for cur in score[1:]:
        if prev['y'] != cur['y'] or (cur['x'] - prev['x']) > params.overlap_window:
            out.append(bin_first)
            bin_first = cur
        prev = cur
    out.append(bin_first)
    return out


# ============================================================================
# DP 链化层
# ============================================================================

def _check_overlap(xx, yy):
    return min(xx) <= max(yy) and min(yy) <= max(xx)


def _is_significant(sf, score, params):
    s1_a, s1_b = sf['s1_mid'], sf['t1_mid']
    s2_a, s2_b = sf['s2_mid_disp'], sf['t2_mid_disp']
    m = len(sf['pids'])
    N = 0
    for s in score:
        if s1_a <= s['x_mid'] <= s1_b and s2_a <= s['y_mid'] <= s2_b:
            N += 1
    summation = 0.0
    l1_pos1, l2_pos1 = sf['pids_pos'][0]
    for (l1_pos2, l2_pos2) in sf['pids_pos'][1:]:
        summation += _log(abs(l1_pos2 - l1_pos1)) + _log(abs(l2_pos2 - l2_pos1))
        l1_pos1, l2_pos1 = l1_pos2, l2_pos2
    L1 = s1_b - s1_a
    L2 = s2_b - s2_a
    sf['e_value'] = _exp(M_LN2 + _ln_perm(N, m) + summation
                         - (m - 1) * (_log(L1) + _log(L2)))
    return sf['e_value'] < params.e_value


def _print_chains(score, mol_pair, params, match_list):
    """DAGchainer DP + 迭代剥离（按公开算法描述实现）。返回被提取的 seg 列表。

    注意：score 为当前 mol_pair 的锚点数组（会被原地消费）。
    """
    is_self = mol_pair.split('&')[0] == mol_pair.split('&')[1]
    segs = []
    xx, yy = [], []
    while True:
        done = True
        score.sort(key=lambda s: (s['x'], s['y']))
        n = len(score)
        path_score = [s['score'] for s in score]   # 初值 = MATCH_SCORE
        from_ = [-1] * n
        for j in range(1, n):
            xj, yj, sj = score[j]['x'], score[j]['y'], score[j]['score']
            for i in range(j - 1, -1, -1):
                del_x = xj - score[i]['x'] - 1
                del_y = yj - score[i]['y'] - 1
                if del_x >= 0 and del_y >= 0:
                    if del_x > params.max_gaps:
                        break
                    if del_y > params.max_gaps:
                        continue
                    num_gaps = max(del_x, del_y)
                    cand = path_score[i] + sj
                    if num_gaps > 0:
                        cand += num_gaps * params.gap_penalty
                    if cand > path_score[j]:
                        path_score[j] = cand
                        from_[j] = i

        high = []
        for i in range(n):
            if path_score[i] >= params.cutoff_score:
                high.append({'score': path_score[i], 'sub': i,
                             'rc': score[i]['x'] + score[i]['y']})
        high.sort(key=lambda p: (-p['score'], -p['rc']))

        m_high = len(high)
        consumed_any = False
        for h in high:
            if from_[h['sub']] != -2:
                ans = []
                j = h['sub']
                while from_[j] >= 0:
                    ans.append(j)
                    j = from_[j]
                ans.append(j)
                if from_[j] == -2:
                    done = False
                    break
                ans.reverse()
                s_len = len(ans)
                if is_self:
                    for a in ans:
                        from_[a] = -2
                        xx.append(score[a]['x'])
                        yy.append(score[a]['y'])
                sf = None
                if not (is_self and _check_overlap(xx, yy)):
                    sf = {'score': float(path_score[h['sub']]), 'pids': [], 'pids_pos': []}
                    for a in ans:
                        from_[a] = -2
                        pid = score[a]['pairID']
                        sf['pids'].append(pid)
                        rec = match_list[pid]
                        sf['pids_pos'].append((rec['g1_mid'], rec['g2_mid']))
                    first = match_list[sf['pids'][0]]
                    last = match_list[sf['pids'][-1]]
                    sf['mol_pair'] = mol_pair
                    sf['s1_mid'], sf['t1_mid'] = first['g1_mid'], last['g1_mid']
                    s2_mid, t2_mid = first['g2_mid'], last['g2_mid']
                    same_strand = s2_mid < t2_mid
                    if not same_strand:
                        s2_mid, t2_mid = t2_mid, s2_mid
                    sf['sameStrand'] = same_strand
                    sf['s2_mid_disp'], sf['t2_mid_disp'] = s2_mid, t2_mid
                    if _is_significant(sf, score, params):
                        segs.append(sf)
                    consumed_any = True
                xx.clear()
                yy.clear()
        if not done:
            # 物理删除已消费节点，重跑 DP
            score[:] = [s for idx, s in enumerate(score) if from_[idx] != -2]
            if not score:
                break
        if done:
            break
    return segs


# ============================================================================
# 主流程
# ============================================================================

def run_collinearity(gff_path, blast_path, params):
    gene_map = read_gff(gff_path)
    match_list, mol_pairs = read_blast(blast_path, gene_map, params)

    # 全基因组基因秩：按 (mol, mid, name) 排序后编号
    order = sorted(gene_map.values(), key=lambda g: (g.mol, g.mid, g.name))
    for i, g in enumerate(order):
        g.gene_id = i

    # 补 match_list 的记录字段（mid/gene_id）
    for rec in match_list:
        g1 = gene_map[rec['gene1']]
        g2 = gene_map[rec['gene2']]
        rec['g1_mid'], rec['g2_mid'] = g1.mid, g2.mid

    seg_list = []
    for mol_pair in sorted(mol_pairs.keys()):
        if mol_pairs[mol_pair] < params.match_size:
            continue
        score = []
        for rec in match_list:
            if rec['mol_pair'] != mol_pair:
                continue
            g1 = gene_map[rec['gene1']]
            g2 = gene_map[rec['gene2']]
            score.append({'pairID': rec['pair_id'], 'x': g1.gene_id, 'y': g2.gene_id,
                          'x_mid': g1.mid, 'y_mid': g2.mid, 'score': float(params.match_score)})
        score = _filter_matches_x(score, params)
        score = _filter_matches_y(score, params)
        if not score:
            continue
        max_y = score[-1]['y']  # filter_y 后按 (y,x) 排序 → 最后一项 y 最大
        seg_list.extend(_print_chains(score, mol_pair, params, match_list))
        for s in score:
            s['y'] = max_y - s['y'] + 1
        seg_list.extend(_print_chains(score, mol_pair, params, match_list))

    return {'gene_map': gene_map, 'match_list': match_list,
            'seg_list': seg_list, 'mol_pairs': mol_pairs, 'params': params}


# ============================================================================
# 输出层（printf 级兼容）
# ============================================================================

def write_collinearity(result, path):
    gene_map = result['gene_map']
    match_list = result['match_list']
    seg_list = result['seg_list']
    params = result['params']

    lines = []
    lines.append('############### Parameters ###############')
    lines.append('# MATCH_SCORE: %d' % params.match_score)
    lines.append('# MATCH_SIZE: %d' % params.match_size)
    lines.append('# GAP_PENALTY: %d' % params.gap_penalty)
    lines.append('# OVERLAP_WINDOW: %d' % params.overlap_window)
    lines.append('# E_VALUE: %s' % _c_format_lg(params.e_value))
    lines.append('# MAX GAPS: %d' % params.max_gaps)

    colgenes = set()
    for sf in seg_list:
        for pid in sf['pids']:
            colgenes.add(match_list[pid]['gene1'])
            colgenes.add(match_list[pid]['gene2'])
    pct = 100.0 * len(colgenes) / len(gene_map)
    lines.append('############### Statistics ###############')
    lines.append('# Number of collinear genes: %d, Percentage: %.2f' % (len(colgenes), pct))
    lines.append('# Number of all genes: %d' % len(gene_map))
    lines.append('##########################################')

    for i, sf in enumerate(seg_list):
        lines.append('## Alignment %d: score=%.1f e_value=%.2g N=%d %s %s'
                     % (i, sf['score'], sf['e_value'], len(sf['pids']),
                        sf['mol_pair'], 'plus' if sf['sameStrand'] else 'minus'))
        for j, pid in enumerate(sf['pids']):
            rec = match_list[pid]
            lines.append('%3d-%3d:\t%s\t%s\t%s'
                         % (i, j, rec['gene1'], rec['gene2'],
                            _c_format_g(rec['score'], 7, 1)))

    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('\n'.join(lines) + '\n')
    return path


def _c_format_lg(v):
    """C printf %lg（默认精度 6 位有效）的近似：0.00001 → 1e-05。"""
    if v == 0:
        return '0'
    s = '%.6g' % v
    return s


def _c_format_g(v, width, prec):
    """C printf %*.*g。"""
    if v == 0:
        s = '0'
    else:
        s = '%.*g' % (prec, v)
    return s.rjust(width)


# ============================================================================
# op 入口
# ============================================================================

def op_collinearity(args):
    """共线性分析：GFF + BLAST -> .collinearity（兼容交换格式）。"""
    prefix = args.get('prefix')
    gff = args.get('gff') or (prefix + '.gff' if prefix else None)
    blast = args.get('blast') or (prefix + '.blast' if prefix else None)
    if not gff or not blast:
        raise ValueError('需提供 prefix（读 <prefix>.gff / <prefix>.blast）或显式 gff+blast')
    for p in (gff, blast):
        if not os.path.isfile(p):
            raise ValueError('文件不存在：%s' % p)

    params = Params(
        match_score=args.get('match_score', 50),
        match_size=args.get('match_size', 5),
        gap_penalty=args.get('gap_penalty', -1),
        e_value=args.get('e_value', 1e-5),
        max_gaps=args.get('max_gaps', 25),
        overlap_window=args.get('overlap_window', 5),
        in_synteny=args.get('in_synteny', 0),
    )
    out = args.get('output_file') or ((prefix or os.path.splitext(gff)[0]) + '.collinearity')

    result = run_collinearity(gff, blast, params)
    write_collinearity(result, out)

    segs = result['seg_list']
    colgenes = set()
    for sf in segs:
        for pid in sf['pids']:
            colgenes.add(result['match_list'][pid]['gene1'])
            colgenes.add(result['match_list'][pid]['gene2'])
    return {
        'n_genes': len(result['gene_map']),
        'n_anchors': len(result['match_list']),
        'n_mol_pairs': len(result['mol_pairs']),
        'n_blocks': len(segs),
        'n_collinear_genes': len(colgenes),
        'percentage': round(100.0 * len(colgenes) / len(result['gene_map']), 2),
        'params': {'match_score': params.match_score, 'match_size': params.match_size,
                   'gap_penalty': params.gap_penalty, 'e_value': params.e_value,
                   'max_gaps': params.max_gaps, 'overlap_window': params.overlap_window,
                   'in_synteny': params.in_synteny},
        'top_blocks': [{'rank': i, 'mol_pair': sf['mol_pair'],
                        'score': sf['score'], 'n': len(sf['pids']),
                        'orientation': 'plus' if sf['sameStrand'] else 'minus'}
                       for i, sf in enumerate(segs[:20])],
        'output_file': os.path.abspath(out),
    }
