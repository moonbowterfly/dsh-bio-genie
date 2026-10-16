"""dsh-bio-genie Ka/Ks 计算 —— 独立实现（批次 C3）

方法：NG86（Nei & Gojobori 1986, MBE 3:418-426）+ Jukes-Cantor 校正。
流程：蛋白比对（给定或内部比对）→ 回译到密码子级 → NG86 位点/替换计数 → JC 校正。

行为规格（与生态一致）：
  - 同义/非同义位点：按密码子对两端平均（每密码子逐位点按「3 种替换中同义比例」计）
  - 替换计数：单碱基差异直接判；多碱基差异枚举最短路径取平均（中间终止密码子路径排除）
  - 校正：dS = -3/4 ln(1 - 4/3 pS)，dN 同理；p >= 0.75（饱和）或位点数为 0 → 哨兵
  - 哨兵语义：JSON 输出 null + reason；共线性追加列模式用 -2（与生态一致）
"""
import itertools
import math

from Bio.Data import CodonTable

_TABLE = CodonTable.unambiguous_dna_by_id[1]
_FWD = dict(_TABLE.forward_table)
_STOPS = set(_TABLE.stop_codons)


def _clean_cds(seq, label='sequence'):
    """规整 CDS：大写、去空白；长度须为 3 的倍数；去尾终止密码子（若存在）。"""
    s = ''.join(str(seq).split()).upper().replace('U', 'T')
    if not s:
        raise ValueError('%s 为空' % label)
    if len(s) % 3 != 0:
        raise ValueError('%s 长度 %d 不是 3 的倍数（需完整 CDS）' % (label, len(s)))
    # 检查非法字符
    bad = set(s) - set('ACGT')
    if bad:
        raise ValueError('%s 含非 ACGT 字符：%s' % (label, ''.join(sorted(bad))[:10]))
    codons = [s[i:i + 3] for i in range(0, len(s), 3)]
    # 内部终止 → 报错（末端终止去除）
    if codons and codons[-1] in _STOPS:
        codons = codons[:-1]
    for i, c in enumerate(codons):
        if c in _STOPS:
            raise ValueError('%s 含内部终止密码子（位置 %d）：无法做 Ka/Ks' % (label, i + 1))
    return codons


def _translate_codon(codon):
    return _FWD.get(codon)


def syn_sites(codon):
    """一个密码子的同义位点数（0..3）：逐位点按 3 种替换的同义比例求和。"""
    total = 0.0
    aa = _FWD[codon]
    for pos in range(3):
        syn = 0
        for nuc in 'ACGT':
            if nuc == codon[pos]:
                continue
            alt = codon[:pos] + nuc + codon[pos + 1:]
            if alt in _STOPS:
                continue  # 替换为终止密码子 -> 非同义
            if _FWD.get(alt) == aa:
                syn += 1
        total += syn / 3.0
    return total


def count_diff(c1, c2):
    """一对密码子的同义/非同义替换数（多差异枚举最短路径平均）。

    返回 (sd, nd)；若所有中间路径均含终止密码子（或路径全非法）返回 None。
    """
    diffs = [i for i in range(3) if c1[i] != c2[i]]
    d = len(diffs)
    if d == 0:
        return 0.0, 0.0
    if d == 1:
        same = _FWD.get(c1) == _FWD.get(c2)
        return (1.0, 0.0) if same else (0.0, 1.0)
    total_s = total_n = 0.0
    paths = 0
    for order in itertools.permutations(diffs):
        cur = c1
        ok = True
        s = n = 0
        for pos in order:
            nxt = cur[:pos] + c2[pos] + cur[pos + 1:]
            if nxt in _STOPS:
                ok = False
                break
            if _FWD.get(nxt) == _FWD.get(cur):
                s += 1
            else:
                n += 1
            cur = nxt
        if ok:
            total_s += s
            total_n += n
            paths += 1
    if paths == 0:
        return None
    return total_s / paths, total_n / paths


def jc_correct(p):
    """Jukes-Cantor 校正；p >= 0.75 返回 None（饱和哨兵）。"""
    if p >= 0.75:
        return None
    return -0.75 * math.log(1 - (4.0 / 3.0) * p)


def ng86(codon_pairs):
    """NG86 计算。输入 [(codon1, codon2)]（None 表示 gap）。

    返回 dict：S, N, Sd, Nd, pS, pN, Ks(dS), Ka(dN), omega, 及各 reason 哨兵。
    """
    S = N = 0.0
    Sd = Nd = 0.0
    used = 0
    excluded = 0
    for pair in codon_pairs:
        c1, c2 = pair
        if c1 is None or c2 is None:
            excluded += 1
            continue
        used += 1
        s1, s2 = syn_sites(c1), syn_sites(c2)
        S += (s1 + s2) / 2.0
        N += 3.0 - (s1 + s2) / 2.0
        cnt = count_diff(c1, c2)
        if cnt is None:
            excluded += 1
            used -= 1
            continue
        Sd += cnt[0]
        Nd += cnt[1]

    out = {
        'codons_used': used,
        'codons_excluded': excluded,
        'S': round(S, 4), 'N': round(N, 4),
        'Sd': round(Sd, 4), 'Nd': round(Nd, 4),
    }
    if used == 0 or S <= 0 or N <= 0:
        out.update({'pS': None, 'pN': None, 'Ks': None, 'Ka': None, 'omega': None,
                    'Ks_reason': 'no_valid_sites' if used == 0 else 'no_sites',
                    'Ka_reason': 'no_valid_sites' if used == 0 else 'no_sites'})
        return out
    pS = Sd / S
    pN = Nd / N
    out['pS'] = round(pS, 6)
    out['pN'] = round(pN, 6)
    dS = jc_correct(pS)
    dN = jc_correct(pN)
    out['Ks'] = _z0(round(dS, 6)) if dS is not None else None
    out['Ka'] = _z0(round(dN, 6)) if dN is not None else None
    if dS is None:
        out['Ks_reason'] = 'saturated_pS'
    if dN is None:
        out['Ka_reason'] = 'saturated_pN'
    if dS is not None and dS == 0:
        out['Ks'] = None
        out['Ks_reason'] = 'zero'
    if dN is not None and dS is not None and dS > 0:
        out['omega'] = _z0(round(dN / dS, 4))
    else:
        out['omega'] = None
    return out


def _z0(v):
    """消除 -0.0（规范为 0.0）。"""
    if v is not None and v == 0:
        return 0.0
    return v


def align_protein_pair(aa1, aa2):
    """全局蛋白比对（BLOSUM62），返回 (行1, 行2)。"""
    from Bio.Align import PairwiseAligner, substitution_matrices
    aligner = PairwiseAligner()
    aligner.substitution_matrix = substitution_matrices.load('BLOSUM62')
    aligner.open_gap_score = -10
    aligner.extend_gap_score = -0.5
    aligner.mode = 'global'
    aln = aligner.align(aa1, aa2)[0]
    return str(aln[0]), str(aln[1])


def build_codon_alignment(codons1, codons2, aln_rows=None):
    """蛋白比对（或内部比对）-> 密码子级对齐 [(c1, c2)]。"""
    aa1 = ''.join(_FWD[c] for c in codons1)
    aa2 = ''.join(_FWD[c] for c in codons2)
    if aln_rows is None:
        aln_rows = align_protein_pair(aa1, aa2)
    r1, r2 = aln_rows
    if len(r1) != len(r2):
        raise ValueError('蛋白比对两行长度不一致')
    pairs = []
    i1 = i2 = 0
    for ch1, ch2 in zip(r1, r2):
        c1 = codons1[i1] if ch1 != '-' else None
        c2 = codons2[i2] if ch2 != '-' else None
        if ch1 != '-':
            i1 += 1
        if ch2 != '-':
            i2 += 1
        pairs.append((c1, c2))
    if i1 != len(codons1) or i2 != len(codons2):
        raise ValueError('回译失败：比对行与 CDS 长度不匹配')
    return pairs


def kaks_pair(cds1, cds2, label1='seq1', label2='seq2', protein_aln=None):
    """一对 CDS 的 Ka/Ks 全流程。"""
    c1 = _clean_cds(cds1, label1)
    c2 = _clean_cds(cds2, label2)
    pairs = build_codon_alignment(c1, c2, protein_aln)
    res = ng86(pairs)
    res['label1'] = label1
    res['label2'] = label2
    res['cds_codons_1'] = len(c1)
    res['cds_codons_2'] = len(c2)
    res['alignment_columns'] = len(pairs)
    omega = res.get('omega')
    if omega is None:
        res['interpretation'] = 'not_computable'
    elif omega < 1:
        res['interpretation'] = 'purifying_selection'
    elif omega > 1:
        res['interpretation'] = 'positive_selection'
    else:
        res['interpretation'] = 'neutral'
    return res


# ============================================================================
# op 入口
# ============================================================================

def _read_seq_arg(v, label):
    import os
    if os.path.isfile(v):
        text = open(v, 'r', encoding='utf-8', errors='replace').read()
        # 允许 FASTA：取第一条序列
        if text.lstrip().startswith('>'):
            parts = text.split('>')
            body = []
            for line in parts[1].splitlines():
                if line.startswith('>'):
                    break
                body.append(line.strip())
            return ''.join(body)
        return ''.join(text.split())
    return ''.join(str(v).split())


def op_kaks(args):
    """Ka/Ks 计算（NG86）：单对 CDS -> dN/dS + omega。"""
    s1 = args.get('sequence1')
    s2 = args.get('sequence2')
    if not s1 or not s2:
        raise ValueError('需提供 sequence1 与 sequence2（DNA 内容或文件路径）')
    cds1 = _read_seq_arg(s1, 'sequence1')
    cds2 = _read_seq_arg(s2, 'sequence2')

    protein_aln = None
    if args.get('protein_aln'):
        aln_text = args['protein_aln']
        rows = [r.strip() for r in aln_text.strip().splitlines() if r.strip()]
        rows = [r for r in rows if not r.startswith('>')]
        if len(rows) < 2:
            raise ValueError('protein_aln 需为两行文本或两行数组')
        protein_aln = (rows[0], rows[1])

    res = kaks_pair(cds1, cds2,
                    label1=str(args.get('label1') or 'seq1'),
                    label2=str(args.get('label2') or 'seq2'),
                    protein_aln=protein_aln)

    res['method'] = 'NG86 (Nei & Gojobori 1986) + Jukes-Cantor'
    res['note'] = ('成对 omega 仅反映平均选择压力；位点级正选择需位点模型（如 codeml M1a/M2a、M7/M8）。'
                   'NG86 不区分转换/颠换，可能低估 Ks——高分化序列建议交叉验证。')
    return res
