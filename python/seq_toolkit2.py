"""dsh-bio-genie 序列工具箱 —— 翻译/ORF/蛋白参数/SSR/引物检查（批次 A2）

  - seq_batch_translate  批量 CDS -> 蛋白（相位/六框/终止处理）
  - orf_predict          六框 ORF 预测（complete / 含 partial）
  - protein_params       蛋白参数（MW/pI/GRAVY/脂肪族指数/组成）
  - ssr_mine             微卫星 SSR 挖掘
  - primer_check         引物在序列库中的定位 / 扩增子预测
"""
import os
import re

from seq_toolkit import (_req_path, _out_path, scan_fasta_index, iter_fasta,
                         read_fasta_region, _default_out_name)


# ============================================================================
# 通用：密码表加载
# ============================================================================

def _load_codon_table(table_id):
    from Bio.Data import CodonTable
    try:
        table = CodonTable.unambiguous_dna_by_id[int(table_id)]
    except KeyError:
        raise ValueError('未知遗传密码表编号：%s（1=标准表）' % table_id)
    return table.forward_table, set(table.stop_codons)


def _translate_segment(seg, fwd_table, stop_set, to_stop=False):
    """翻译一段（3 的倍数长度）核酸；返回 (aa, internal_stops, has_stop_at_end)。"""
    aa = []
    internal = 0
    stop_at_end = False
    n = len(seg) - (len(seg) % 3)
    for i in range(0, n, 3):
        codon = seg[i:i + 3].upper()
        if codon in stop_set:
            if to_stop:
                return ''.join(aa), internal, True
            aa.append('*')
        else:
            a = fwd_table.get(codon)
            aa.append(a if a else 'X')
    if aa and aa[-1] == '*':
        stop_at_end = True
    return ''.join(aa), internal, stop_at_end


# ============================================================================
# op: seq_batch_translate
# ============================================================================

def op_seq_batch_translate(args):
    """批量翻译：frame=auto|0|1|2|all6；to_stop / trim_stop 控制终止密码子。"""
    src = _req_path(args, 'input')
    table_id = int(args.get('table') or 1)
    fwd, stops = _load_codon_table(table_id)
    to_stop = bool(args.get('to_stop', False))
    trim_stop = bool(args.get('trim_stop', False))
    if to_stop and trim_stop:
        trim_stop = False  # to_stop 已在终止处截断，trim 无意义
    frame_opt = args.get('frame', 'auto')
    if isinstance(frame_opt, str) and frame_opt.lower() == 'all6':
        mode = 'all6'
        frame = 0
    elif frame_opt in (0, 1, 2, '0', '1', '2'):
        mode = 'single'
        frame = int(frame_opt)
    else:
        mode = 'single'
        frame = 0

    index = scan_fasta_index(src)
    if not index:
        raise ValueError('输入 FASTA 中没有找到任何记录：%s' % src)

    out_file = _out_path(args, _default_out_name(src, '.pep.fasta'))
    warnings = []
    n_in = 0
    n_out = 0

    def _emit(out, name, aa):
        nonlocal n_out
        out.write('>' + name + '\n')
        for i in range(0, len(aa), 60):
            out.write(aa[i:i + 60] + '\n')
        n_out += 1

    with open(out_file, 'w', encoding='utf-8', newline='\n') as out:
        for rec, seq in iter_fasta(src, index):
            n_in += 1
            s = seq.upper().replace('U', 'T')
            if mode == 'single':
                if len(s) % 3 != 0:
                    warnings.append('%s: 长度 %d 不是 3 的倍数（尾部 %d nt 未翻译）'
                                    % (rec['id'], len(s), len(s) % 3))
                seg = s[frame:]
                aa, internal, ended = _translate_segment(seg, fwd, stops, to_stop)
                if internal > 0:
                    warnings.append('%s: 检测到 %d 个内部终止密码子（标记 *）' % (rec['id'], internal))
                if trim_stop and aa.endswith('*'):
                    aa = aa[:-1]
                _emit(out, rec['id'], aa)
            else:
                L = len(s)
                from Bio.Seq import Seq as _S
                rc = str(_S(s).reverse_complement())
                for f in range(3):
                    aa, _, _ = _translate_segment(s[f:], fwd, stops, False)
                    _emit(out, '%s|frame+%d' % (rec['id'], f + 1), aa)
                for f in range(3):
                    aa, _, _ = _translate_segment(rc[f:], fwd, stops, False)
                    _emit(out, '%s|frame-%d' % (rec['id'], f + 1), aa)

    return {
        'count_in': n_in,
        'count_out': n_out,
        'table': table_id,
        'mode': mode,
        'output_file': out_file,
        'warnings': warnings[:30],
        'warning_count': len(warnings),
    }


# ============================================================================
# op: orf_predict
# ============================================================================

def _scan_frame_orfs(seg, frame_label, abs_offset, seq_len, fwd, stops,
                     min_aa, mode, reverse):
    """扫描单帧 ORF。返回 ORF 列表（坐标为原序列 1-based 闭区间）。"""
    aa_min_nt = min_aa * 3
    n = len(seg) - (len(seg) % 3)
    orfs = []
    i = 0
    # 逐密码子扫描，找 ATG 起始与终止
    # complete 模式：ATG ... stop；partial 模式额外收 段首..stop / ATG..段尾
    codons = [seg[j:j + 3].upper() for j in range(0, n, 3)]
    k = 0
    ncod = len(codons)
    last_start = None
    for k in range(ncod):
        cod = codons[k]
        if cod == 'ATG' and last_start is None:
            last_start = k
        is_stop = cod in stops
        if is_stop and last_start is not None:
            # 完整 ORF 坐标含终止密码子（ATG..stop 末位）
            ln_nt = (k + 1 - last_start) * 3
            if ln_nt >= aa_min_nt:
                orfs.append((last_start, k + 1, 'complete'))
            last_start = None
    # partial：段尾未终止的 ATG 段
    if mode == 'complete_partial' and last_start is not None:
        ln_nt = (ncod - last_start) * 3
        if ln_nt >= aa_min_nt:
            orfs.append((last_start, ncod, 'partial_end'))
    # partial：段首（无 ATG）到首个 stop（含 stop）
    if mode == 'complete_partial' and ncod > 0:
        k = 0
        while k < ncod and codons[k] != 'ATG':
            if codons[k] in stops:
                ln_nt = (k + 1) * 3
                if ln_nt >= aa_min_nt and k > 0:
                    orfs.append((0, k + 1, 'partial_start'))
                break
            k += 1

    out = []
    for (a, b, kind) in orfs:
        s0 = abs_offset + a * 3           # 0-based on original
        e0 = abs_offset + b * 3
        if reverse:
            real_start = seq_len - e0 + 1   # 1-based
            real_end = seq_len - s0
            label = '-' + frame_label
        else:
            real_start = s0 + 1
            real_end = e0
            label = '+' + frame_label
        out.append({
            'start': real_start, 'end': real_end, 'strand_frame': label,
            'length_nt': e0 - s0, 'length_aa': (e0 - s0) // 3, 'kind': kind,
        })
    return out


def op_orf_predict(args):
    """ORF 预测：plus/both 链；complete 或 complete+partial；批量。"""
    src = _req_path(args, 'input')
    min_aa = int(args.get('min_aa') or 30)
    strands = str(args.get('strands') or 'both').lower()
    if strands not in ('plus', 'both'):
        raise ValueError("strands 仅支持 plus / both")
    mode = str(args.get('mode') or 'complete').lower()
    if mode not in ('complete', 'complete_partial'):
        raise ValueError("mode 仅支持 complete / complete_partial")
    max_orfs = int(args.get('max_orfs_per_seq') or 200)
    table_id = int(args.get('table') or 1)
    fwd, stops = _load_codon_table(table_id)

    index = scan_fasta_index(src)
    if not index:
        raise ValueError('输入 FASTA 中没有找到任何记录：%s' % src)

    all_orfs = []
    truncated = 0
    for rec, seq in iter_fasta(src, index):
        s = seq.upper().replace('U', 'T')
        L = len(s)
        hits = []
        for f in range(3):
            hits.extend(_scan_frame_orfs(s[f:], str(f + 1), 0, L, fwd, stops,
                                         min_aa, mode, False))
        if strands == 'both':
            from Bio.Seq import Seq as _S
            rc = str(_S(s).reverse_complement())
            orfs_rc = []
            for f in range(3):
                orfs_rc.extend(_scan_frame_orfs(rc[f:], str(f + 1), 0, L, fwd, stops,
                                                min_aa, mode, True))
            hits.extend(orfs_rc)
        hits.sort(key=lambda h: h['length_nt'], reverse=True)
        if len(hits) > max_orfs:
            truncated += len(hits) - max_orfs
            hits = hits[:max_orfs]
        for h in hits:
            h['id'] = rec['id']
        all_orfs.extend(hits)

    if not all_orfs:
        raise ValueError('没有发现满足条件（>=%daa）的 ORF。可调小 min_aa 或改用 complete_partial 模式。' % min_aa)

    out_file = _out_path(args, _default_out_name(src, '.orfs.tsv'))
    with open(out_file, 'w', encoding='utf-8', newline='\n') as out:
        out.write('id\tstart\tend\tstrand_frame\tlength_nt\tlength_aa\tkind\n')
        for h in all_orfs:
            out.write('%s\t%d\t%d\t%s\t%d\t%d\t%s\n'
                      % (h['id'], h['start'], h['end'], h['strand_frame'],
                         h['length_nt'], h['length_aa'], h['kind']))

    return {
        'n_sequences': len(index),
        'n_orfs': len(all_orfs),
        'truncated': truncated,
        'min_aa': min_aa,
        'strands': strands,
        'mode': mode,
        'output_file': out_file,
        'top_orfs': all_orfs[:30],
    }


# ============================================================================
# op: protein_params
# ============================================================================

def _aliphatic_index(percent):
    """Ikai 1980 脂肪族指数：100*(A% + 2.9*V% + 3.9*(I%+L%))（百分数为 0-100）。"""
    a = percent.get('A', 0.0)
    v = percent.get('V', 0.0)
    i = percent.get('I', 0.0)
    l = percent.get('L', 0.0)
    return round(a + 2.9 * v + 3.9 * (i + l), 2)


def _one_protein(seq, label):
    from Bio.SeqUtils.ProtParam import ProteinAnalysis
    s = re.sub(r'[^A-Za-z*]', '', seq).upper().rstrip('*')
    if not s:
        raise ValueError('序列 %s 有效氨基酸为空' % label)
    pa = ProteinAnalysis(s)
    if hasattr(pa, 'amino_acids_percent'):
        raw_pct = pa.amino_acids_percent
    else:
        raw_pct = pa.get_amino_acids_percent()
    percent = {k: round(v, 2) for k, v in raw_pct.items()}
    counts = {aa: s.count(aa) for aa in sorted(set(s))}
    try:
        gravy = round(pa.gravy(), 3)
    except AttributeError:
        gravy = None
    try:
        aromaticity = round(pa.aromaticity(), 4)
    except AttributeError:
        aromaticity = None
    # 消光系数（Gasteiger 1995 假设所有 Cys 为氧化态）：Trp*5500 + Tyr*1490 + cystine*125
    trp, tyr, cys = s.count('W'), s.count('Y'), s.count('C')
    ext_red = trp * 5500 + tyr * 1490
    ext_ox = ext_red + (cys // 2) * 125
    return {
        'id': label,
        'length': len(s),
        'molecular_weight_kda': round(pa.molecular_weight() / 1000.0, 3),
        'isoelectric_point': round(pa.isoelectric_point(), 3),
        'gravy': gravy,
        'aromaticity': aromaticity,
        'aliphatic_index': _aliphatic_index(raw_pct),
        'extinction_coeff_280_reduced': ext_red,
        'extinction_coeff_280_cystine': ext_ox,
        'aa_composition_percent': percent,
        'x_or_stop_count': s.count('X') + s.count('*'),
    }


def op_protein_params(args):
    """蛋白参数：单序列（sequence）或批量（input FASTA）。"""
    single = args.get('sequence')
    results = []
    if single and isinstance(single, str):
        results.append(_one_protein(single, str(args.get('label') or 'input')))
    else:
        src = _req_path(args, 'input')
        index = scan_fasta_index(src)
        if not index:
            raise ValueError('输入 FASTA 中没有找到任何记录：%s' % src)
        limit = int(args.get('limit') or 500)
        for i, (rec, seq) in enumerate(iter_fasta(src, index)):
            if i >= limit:
                break
            results.append(_one_protein(seq, rec['id']))

    out = {'count': len(results), 'results': results[:100]}
    if len(results) > 100:
        table = _out_path(args, 'protein_params.tsv')
        with open(table, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write('id\tlength\tmw_kda\tpi\tgravy\taliphatic_index\taromaticity\n')
            for r in results:
                fh.write('%s\t%d\t%s\t%s\t%s\t%s\t%s\n' % (
                    r['id'], r['length'], r['molecular_weight_kda'], r['isoelectric_point'],
                    r['gravy'], r['aliphatic_index'], r['aromaticity']))
        out['table_file'] = table
    return out


# ============================================================================
# op: ssr_mine
# ============================================================================

_DEFAULT_MIN_REPEATS = {1: 10, 2: 6, 3: 5, 4: 5, 5: 4, 6: 4}


def _find_ssr_in_seq(s, max_motif, min_repeats):
    """返回 (start0, motif_len, repeats) 列表；同一区间保留最短周期。"""
    n = len(s)
    hits = []
    for k in range(1, max_motif + 1):
        min_rep = min_repeats.get(k, 4)
        i = 0
        span = k * min_rep
        while i + span <= n:
            unit = s[i:i + k]
            if 'N' in unit:
                i += 1
                continue
            j = i + k
            rep = 1
            while j + k <= n and s[j:j + k] == unit:
                rep += 1
                j += k
            if rep >= min_rep:
                hits.append((i, j, k, unit, rep))
                i = j
            else:
                i += 1
    # 去重叠：区间相同的保留 k 最小（本质周期）
    hits.sort(key=lambda h: (h[0], h[2]))
    chosen = []
    occupied = []
    for (a, b, k, unit, rep) in hits:
        dup = False
        for (pa, pb) in occupied:
            if a < pb and b > pa:  # 区间重叠
                dup = True
                break
        if dup:
            continue
        occupied.append((a, b))
        chosen.append((a, b, k, unit, rep))
    return chosen


def op_ssr_mine(args):
    """SSR/微卫星挖掘：1-6 核苷酸重复单元，阈值可配，批量。"""
    src = _req_path(args, 'input')
    max_motif = int(args.get('max_motif_len') or 6)
    if max_motif < 1 or max_motif > 10:
        raise ValueError('max_motif_len 需在 1-10 之间')
    user_min = args.get('min_repeats') or {}
    min_repeats = dict(_DEFAULT_MIN_REPEATS)
    if isinstance(user_min, str):
        parsed = {}
        for part in re.split(r'[,;]', user_min):
            part = part.strip()
            if not part:
                continue
            if ':' not in part:
                raise ValueError('min_repeats 字符串格式应为 单元长度:次数，如 1:10,2:6,3:5')
            kk, vv = part.split(':', 1)
            parsed[kk.strip()] = vv.strip()
        user_min = parsed
    for k, v in (user_min.items() if isinstance(user_min, dict) else []):
        try:
            kk = int(k)
        except (TypeError, ValueError):
            raise ValueError('min_repeats 的键需为重复单元长度（数字字符串）')
        if 1 <= kk <= 10:
            min_repeats[kk] = int(v)

    index = scan_fasta_index(src)
    if not index:
        raise ValueError('输入 FASTA 中没有找到任何记录：%s' % src)

    rows = []
    total_ssr = 0
    n_seq_with_ssr = 0
    for rec, seq in iter_fasta(src, index):
        s = seq.upper()
        hits = _find_ssr_in_seq(s, max_motif, min_repeats)
        if hits:
            n_seq_with_ssr += 1
        for (a, b, k, unit, rep) in hits:
            total_ssr += 1
            rows.append({
                'id': rec['id'],
                'type': 'p%d' % k,
                'motif': unit,
                'position': a + 1,
                'repeats': rep,
                'length': b - a,
            })

    if not rows:
        raise ValueError('没有发现满足阈值条件的 SSR（可调低 min_repeats 阈值）')

    out_file = _out_path(args, _default_out_name(src, '.ssr.tsv'))
    with open(out_file, 'w', encoding='utf-8', newline='\n') as out:
        out.write('id\tssr_type\tmotif\tposition\trepeats\tlength\n')
        for r in rows:
            out.write('%s\t%s\t%s\t%d\t%d\t%d\n' % (r['id'], r['type'], r['motif'],
                                                    r['position'], r['repeats'], r['length']))

    by_type = {}
    for r in rows:
        by_type[r['type']] = by_type.get(r['type'], 0) + 1

    return {
        'n_sequences': len(index),
        'n_sequences_with_ssr': n_seq_with_ssr,
        'total_ssr': total_ssr,
        'by_type': by_type,
        'min_repeats': {str(k): v for k, v in sorted(min_repeats.items())},
        'output_file': out_file,
        'preview': rows[:40],
    }


# ============================================================================
# op: primer_check
# ============================================================================

def _find_one(seq, pat, mm_max, seed_at_3p):
    """在 seq（大写）中查找 pat 的所有位置。
    seed_at_3p=True 用 pat 尾部做种子（pat 本身）；False 用头部（pat 是 rc，其 5' 端对应
    原引物 3' 端）。返回 [(pos0, mismatches)]。
    """
    L = len(pat)
    if L < 4:
        raise ValueError('引物过短（<4nt）：%s' % pat)
    seed_len = min(8, L)
    if seed_at_3p:
        seed = pat[-seed_len:]
    else:
        seed = pat[:seed_len]
    hits = []
    start = 0
    while True:
        idx = seq.find(seed, start)
        if idx < 0:
            break
        if seed_at_3p:
            p0 = idx + seed_len - L
        else:
            p0 = idx
        if p0 >= 0 and p0 + L <= len(seq):
            mism = 0
            for j in range(L):
                if seq[p0 + j] != pat[j]:
                    mism += 1
                    if mism > mm_max:
                        break
            if mism <= mm_max:
                hits.append((p0, mism))
        start = idx + 1
    return hits


def op_primer_check(args):
    """引物检查：在目标序列库中定位引物 / 预测扩增子。"""
    from Bio.Seq import Seq as _S

    primers = args.get('primers') or []
    pairs = args.get('pairs') or []
    if not primers and not pairs:
        raise ValueError('primers 或 pairs 至少提供一组')

    targets = []  # [(id, seq_upper)]
    if args.get('input'):
        src = _req_path(args, 'input')
        for rec, seq in iter_fasta(src):
            targets.append((rec['id'], seq.upper()))
    seqs = args.get('sequences') or []
    if isinstance(seqs, str):
        seqs = [seqs]
    for i, s in enumerate(seqs):
        targets.append(('seq_%d' % (i + 1), str(s).upper()))
    if not targets:
        raise ValueError('必须提供 input（FASTA 文件）或 sequences（序列数组）')

    mm_max = int(args.get('max_mismatch') or 0)
    if mm_max < 0 or mm_max > 5:
        raise ValueError('max_mismatch 需在 0-5 之间')
    min_amp = int(args.get('min_amplicon') or 60)
    max_amp = int(args.get('max_amplicon') or 2000)

    def check_one(name, pat, seed_at_3p, pat_rc=None):
        results = []
        for tid, tseq in targets:
            hits = _find_one(tseq, pat, mm_max, seed_at_3p)
            for (p0, mism) in hits[:20]:
                results.append({
                    'target': tid, 'position': p0 + 1, 'end': p0 + len(pat),
                    'mismatches': mism,
                })
        return {'name': name, 'n_hits': len(results), 'hits': results[:20]}

    primer_reports = []
    for p in primers:
        if not isinstance(p, dict) or not p.get('sequence'):
            raise ValueError('primers 每项需为 {name, sequence}')
        nm = str(p.get('name') or p.get('sequence')[:12])
        pat = str(p['sequence']).upper().replace('U', 'T')
        primer_reports.append(check_one(nm, pat, True))

    pair_reports = []
    for p in pairs:
        if not isinstance(p, dict) or not p.get('forward') or not p.get('reverse'):
            raise ValueError('pairs 每项需为 {name, forward, reverse}')
        nm = str(p.get('name') or 'pair')
        fwd = str(p['forward']).upper().replace('U', 'T')
        rev = str(p['reverse']).upper().replace('U', 'T')
        rev_rc = str(_S(rev).reverse_complement())
        amps = []
        for tid, tseq in targets:
            fh = _find_one(tseq, fwd, mm_max, True)          # fwd 3' 种子（尾部）
            rh = _find_one(tseq, rev_rc, mm_max, False)      # rc(rev) 5' 种子（头部）
            for (fp, fm) in fh:
                f_end = fp + len(fwd)
                for (rp, rm) in rh:
                    if rp >= f_end:
                        size = rp + len(rev) - fp
                        if min_amp <= size <= max_amp:
                            amps.append({
                                'target': tid, 'forward_at': fp + 1, 'reverse_at': rp + 1,
                                'size': size, 'fwd_mismatches': fm, 'rev_mismatches': rm,
                            })
        amps.sort(key=lambda a: a['size'])
        pair_reports.append({'name': nm, 'n_amplicons': len(amps), 'amplicons': amps[:20]})

    return {
        'n_targets': len(targets),
        'max_mismatch': mm_max,
        'primers': primer_reports,
        'pairs': pair_reports,
        'note': 'position/end 为 1-based 坐标；amplicon 仅在 forward 位于 reverse 上游时统计。',
    }
