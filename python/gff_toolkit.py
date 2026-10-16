"""dsh-bio-genie GFF/GTF 工具箱 —— 基因组注释处理（批次 A3）

  - gff_positions    GFF -> 基因位置/属性表
  - gff_sequences    从基因组 + GFF 提取特征序列（gene/mRNA/CDS/exon/promoter；
                     CDS 按区间并集拼接以处理 1bp 重叠；负链正确反向互补）
  - gff_ops          GFF 统计汇总 / 条件过滤 / 区域提取

坐标口径：GFF3 为 1-based 闭区间；内部统一 1-based，输出 1-based。
"""
import os
import re
from urllib.parse import unquote

from seq_toolkit import (_req_path, _out_path, scan_fasta_index, read_fasta_region,
                         _default_out_name)

# 单条染色体序列缓存上限（字节）：超出即明确报错，避免隐式大内存占用
_CHROM_CACHE_LIMIT = 300 * 1024 * 1024


# ============================================================================
# GFF 解析
# ============================================================================

def parse_gff(path):
    """流式解析 GFF3/GTF，返回记录列表。

    每条：{seqid, source, type, start, end, score, strand, phase, attrs(dict), raw}
    """
    rows = []
    bad = 0
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        for ln in fh:
            if ln.startswith('#'):
                if ln.startswith('##FASTA'):
                    break
                continue
            ln = ln.rstrip('\r\n')
            if not ln.strip():
                continue
            cells = ln.split('\t')
            if len(cells) < 9:
                bad += 1
                continue
            try:
                start = int(cells[3])
                end = int(cells[4])
            except ValueError:
                bad += 1
                continue
            attrs = {}
            for kv in cells[8].split(';'):
                kv = kv.strip()
                if not kv:
                    continue
                if '=' in kv:
                    k, v = kv.split('=', 1)
                    attrs[k.strip()] = unquote(v.strip())
                elif ' ' in kv:
                    k, v = kv.split(None, 1)
                    attrs[k.strip()] = unquote(v.strip().strip('"'))
                else:
                    attrs[kv] = ''
            rows.append({
                'seqid': cells[0], 'source': cells[1], 'type': cells[2],
                'start': start, 'end': end, 'score': cells[5],
                'strand': cells[6] if cells[6] in ('+', '-') else '.',
                'phase': cells[7], 'attrs': attrs, 'raw': ln,
            })
    if not rows:
        raise ValueError('GFF 中没有解析到任何记录（bad_lines=%d）：%s' % (bad, path))
    return rows, bad


def _pick_attr(attrs, keys):
    for k in keys:
        if k in attrs and attrs[k]:
            return attrs[k]
    return ''


# ============================================================================
# 基因组序列缓存读取
# ============================================================================

class GenomeReader:
    """基于 FASTA 索引的基因组读取器，含单条染色体内存缓存。"""

    def __init__(self, path):
        self.path = path
        self.index = scan_fasta_index(path)
        if not self.index:
            raise ValueError('基因组 FASTA 中没有记录：%s' % path)
        self._by_id = {}
        for rec in self.index:
            if rec['id'] not in self._by_id:
                self._by_id[rec['id']] = rec
        self._cache = {}

    def chrom_len(self, chrom):
        rec = self._by_id.get(chrom)
        if rec is None:
            raise ValueError('基因组中找不到序列 %s（GFF 与基因组可能不匹配）' % chrom)
        return len(self._seq(chrom))

    def _seq(self, chrom):
        if chrom in self._cache:
            return self._cache[chrom]
        rec = self._by_id.get(chrom)
        if rec is None:
            raise ValueError('基因组中找不到序列 %s' % chrom)
        size = rec['end'] - rec['start']
        if size > _CHROM_CACHE_LIMIT:
            raise ValueError('染色体 %s 超过单条缓存上限（%dMB），请切分基因组后使用'
                             % (chrom, _CHROM_CACHE_LIMIT // 1024 // 1024))
        seq = read_fasta_region(self.path, rec['start'], rec['end']).upper()
        if len(self._cache) >= 2:
            self._cache.pop(next(iter(self._cache)))
        self._cache[chrom] = seq
        return seq

    def subseq(self, chrom, start1, end1):
        """1-based 闭区间；越界钳制并如实返回实际区间。"""
        s = self._seq(chrom)
        a = max(1, int(start1))
        b = min(len(s), int(end1))
        if b < a:
            return '', a, b
        return s[a - 1:b], a, b

    def subseq_rc(self, chrom, start1, end1):
        from Bio.Seq import Seq as _S
        frag, a, b = self.subseq(chrom, start1, end1)
        return str(_S(frag).reverse_complement()), a, b


# ============================================================================
# op: gff_positions
# ============================================================================

def op_gff_positions(args):
    """GFF -> 位置表：seqid/type/start/end/strand/length + 指定属性列。"""
    gff = _req_path(args, 'gff')
    types = args.get('types') or ['gene']
    if isinstance(types, str):
        types = [types]
    attrs_out = args.get('attrs') or ['ID', 'Name']

    rows, bad = parse_gff(gff)
    sel = [r for r in rows if r['type'] in types]
    if not sel:
        seen_types = sorted(set(r['type'] for r in rows))
        raise ValueError('types=%s 无匹配记录。文件中的类型：%s' % (types, ', '.join(seen_types[:20])))

    out_file = _out_path(args, _default_out_name(gff, '.positions.tsv'))
    with open(out_file, 'w', encoding='utf-8', newline='\n') as out:
        header = ['seqid', 'type', 'start', 'end', 'strand', 'length'] + list(attrs_out)
        out.write('\t'.join(header) + '\n')
        for r in sel:
            vals = [r['seqid'], r['type'], str(r['start']), str(r['end']),
                    r['strand'], str(r['end'] - r['start'] + 1)]
            for a in attrs_out:
                vals.append(r['attrs'].get(a, ''))
            out.write('\t'.join(vals) + '\n')

    return {
        'n_records': len(sel),
        'n_total_in_file': len(rows),
        'bad_lines': bad,
        'types': types,
        'output_file': out_file,
        'preview': [dict(zip(['seqid', 'type', 'start', 'end', 'strand', 'length'],
                             [r['seqid'], r['type'], r['start'], r['end'], r['strand'],
                              r['end'] - r['start'] + 1])) for r in sel[:15]],
    }


# ============================================================================
# op: gff_sequences
# ============================================================================

def _group_features(rows, ftype, group_keys):
    """把指定类型的行按分组键归组，保持出现顺序。"""
    groups = {}
    order = []
    for r in rows:
        if r['type'] != ftype:
            continue
        gid = _pick_attr(r['attrs'], group_keys)
        if not gid:
            gid = '@@%s_%d_%d' % (r['seqid'], r['start'], r['end'])
        if gid not in groups:
            groups[gid] = []
            order.append(gid)
        groups[gid].append(r)
    return [(gid, groups[gid]) for gid in order]


def _merge_intervals(segs):
    """区间的并集合并；segs=[(start1,end1)]，返回排序去重后的并集。"""
    if not segs:
        return []
    segs = sorted(segs)
    merged = [list(segs[0])]
    for (a, b) in segs[1:]:
        if a <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


def op_gff_sequences(args):
    """从基因组 + GFF 提取特征序列。

    feature=gene|mRNA|exon|CDS|promoter。
    CDS 模式：按转录本归组，区间并集拼接（正确处理 1bp 重叠），负链反向互补。
    promoter 模式：gene 上游 TSS 方向的 promoter_len bp。
    """
    genome_path = _req_path(args, 'genome')
    gff = _req_path(args, 'gff')
    feature = str(args.get('feature') or 'CDS')
    if feature not in ('gene', 'mRNA', 'exon', 'CDS', 'promoter'):
        raise ValueError('feature 仅支持 gene / mRNA / exon / CDS / promoter')
    promoter_len = int(args.get('promoter_len') or 2000)
    limit = int(args.get('limit') or 20000)
    id_list = args.get('ids') or []
    if isinstance(id_list, str):
        id_list = [x.strip() for x in id_list.split(',') if x.strip()]
    id_set = set(id_list)

    rows, bad = parse_gff(gff)
    reader = GenomeReader(genome_path)

    results = []
    warnings = []
    checked = 0

    fwd_table = None
    stops = None
    if args.get('check_cds', True):
        try:
            from seq_toolkit2 import _load_codon_table
            fwd_table, stops = _load_codon_table(int(args.get('table') or 1))
        except Exception:
            fwd_table, stops = None, None

    def emit(fid, seq, meta):
        nonlocal checked
        results.append({'id': fid, 'length': len(seq), 'meta': meta})
        return seq

    out_seqs = []

    if feature == 'CDS':
        for gid, segs in _group_features(rows, 'CDS', ['Parent', 'ID', 'transcript_id']):
            if id_set and gid not in id_set:
                continue
            if len(results) >= limit:
                warnings.append('已达到 limit=%d 截断' % limit)
                break
            strand = segs[0]['strand']
            seqid = segs[0]['seqid']
            intervals = _merge_intervals([(s['start'], s['end']) for s in segs])
            parts = []
            ov = 0
            raw_span = sum(b - a + 1 for a, b in intervals)
            raw_orig = sum(s['end'] - s['start'] + 1 for s in segs)
            if raw_orig != raw_span:
                ov = raw_orig - raw_span
            for (a, b) in intervals:
                frag, ra, rb = reader.subseq(seqid, a, b)
                parts.append(frag)
            seq = ''.join(parts)
            if strand == '-':
                from Bio.Seq import Seq as _S
                seq = str(_S(seq).reverse_complement())
            meta = {'seqid': seqid, 'strand': strand, 'n_segments': len(segs),
                    'overlap_nt_removed': ov}
            emit(gid, seq, meta)
            out_seqs.append((gid, seq, meta))

    elif feature in ('gene', 'mRNA', 'exon'):
        ftype = feature
        if ftype in ('mRNA', 'exon'):
            groups = _group_features(rows, ftype, ['Parent', 'ID'])
            for gid, segs in groups:
                if id_set and gid not in id_set:
                    continue
                if len(results) >= limit:
                    warnings.append('已达到 limit=%d 截断' % limit)
                    break
                strand = segs[0]['strand']
                seqid = segs[0]['seqid']
                intervals = _merge_intervals([(s['start'], s['end']) for s in segs])
                parts = []
                for (a, b) in intervals:
                    frag, _, _ = reader.subseq(seqid, a, b)
                    parts.append(frag)
                seq = ''.join(parts)
                if strand == '-':
                    from Bio.Seq import Seq as _S
                    seq = str(_S(seq).reverse_complement())
                meta = {'seqid': seqid, 'strand': strand, 'n_segments': len(segs)}
                out_seqs.append((gid, seq, meta))
                emit(gid, seq, meta)
        else:
            for r in rows:
                if r['type'] != 'gene':
                    continue
                gid = _pick_attr(r['attrs'], ['ID', 'gene_id', 'Name'])
                if not gid:
                    gid = '@@%s_%d' % (r['seqid'], r['start'])
                if id_set and gid not in id_set and r['attrs'].get('Name') not in id_set:
                    continue
                if len(results) >= limit:
                    warnings.append('已达到 limit=%d 截断' % limit)
                    break
                if r['strand'] == '-':
                    seq, _, _ = reader.subseq_rc(r['seqid'], r['start'], r['end'])
                else:
                    seq, _, _ = reader.subseq(r['seqid'], r['start'], r['end'])
                meta = {'seqid': r['seqid'], 'strand': r['strand'], 'start': r['start'], 'end': r['end']}
                out_seqs.append((gid, seq, meta))
                emit(gid, seq, meta)

    else:  # promoter
        for r in rows:
            if r['type'] != 'gene':
                continue
            gid = _pick_attr(r['attrs'], ['ID', 'gene_id', 'Name'])
            if not gid:
                continue
            if id_set and gid not in id_set and r['attrs'].get('Name') not in id_set:
                continue
            if len(results) >= limit:
                warnings.append('已达到 limit=%d 截断' % limit)
                break
            if r['strand'] == '-':
                tss = r['end'] + 1
                seq, _, _ = reader.subseq_rc(r['seqid'], tss, tss + promoter_len - 1)
            else:
                tss = r['start'] - 1
                seq, _, _ = reader.subseq(r['seqid'], tss - promoter_len + 1, tss)
            meta = {'seqid': r['seqid'], 'strand': r['strand'], 'promoter_len': promoter_len}
            out_seqs.append((gid, seq, meta))
            emit(gid, seq, meta)

    if not out_seqs:
        raise ValueError('没有提取到任何序列（feature=%s, ids=%d 个过滤条件）' % (feature, len(id_set)))

    # CDS 完整性检查（拼接正确性诊断）
    if fwd_table is not None and feature == 'CDS':
        n_check = 0
        for (gid, seq, meta) in out_seqs:
            if n_check >= 2000:
                break
            n_check += 1
            if len(seq) % 3 != 0:
                if len(warnings) < 30:
                    warnings.append('%s: 拼接长度 %d 不是 3 的倍数（CDS 注释可能有误）' % (gid, len(seq)))
                continue
            internal = 0
            for i in range(0, len(seq) - 3, 3):
                if seq[i:i + 3] in stops:
                    internal += 1
            if internal > 0 and len(warnings) < 30:
                warnings.append('%s: 存在 %d 个内部终止密码子' % (gid, internal))

    out_file = _out_path(args, _default_out_name(genome_path, '.%s.fasta' % feature.lower()))
    with open(out_file, 'w', encoding='utf-8', newline='\n') as out:
        for (gid, seq, meta) in out_seqs:
            out.write('>' + gid + '\n')
            for i in range(0, len(seq), 60):
                out.write(seq[i:i + 60] + '\n')

    n_bad3 = sum(1 for (_, s, _) in out_seqs if feature == 'CDS' and len(s) % 3 != 0)
    return {
        'feature': feature,
        'count': len(out_seqs),
        'bad_lines': bad,
        'n_not_multiple_of_3': n_bad3,
        'total_bp': sum(len(s) for (_, s, _) in out_seqs),
        'output_file': out_file,
        'warnings': warnings[:30],
        'warning_count': len(warnings),
        'preview': [{'id': g, 'length': len(s), 'meta': m} for (g, s, m) in out_seqs[:15]],
    }


# ============================================================================
# op: gff_ops
# ============================================================================

def op_gff_ops(args):
    """GFF 统计 / 过滤 / 区域提取。action=stats|filter|extract_region。"""
    gff = _req_path(args, 'gff')
    action = str(args.get('action') or 'stats').lower()
    rows, bad = parse_gff(gff)

    if action == 'stats':
        by_type = {}
        by_seqid = {}
        for r in rows:
            by_type[r['type']] = by_type.get(r['type'], 0) + 1
            by_seqid[r['seqid']] = by_seqid.get(r['seqid'], 0) + 1
        gene_lens = [r['end'] - r['start'] + 1 for r in rows if r['type'] == 'gene']
        result = {
            'action': 'stats',
            'n_records': len(rows),
            'bad_lines': bad,
            'n_sequences': len(by_seqid),
            'by_type': dict(sorted(by_type.items(), key=lambda kv: -kv[1])),
            'per_seqid_top': dict(sorted(by_seqid.items(), key=lambda kv: -kv[1])[:20]),
        }
        if gene_lens:
            gene_lens.sort(reverse=True)
            total = sum(gene_lens)
            acc, n50 = 0, 0
            for L in gene_lens:
                acc += L
                if acc >= total * 0.5:
                    n50 = L
                    break
            result['gene_length_stats'] = {
                'count': len(gene_lens), 'mean': round(total / len(gene_lens), 1),
                'min': min(gene_lens), 'max': max(gene_lens), 'n50': n50,
            }
        return result

    if action in ('filter', 'extract_region'):
        types = args.get('types')
        if isinstance(types, str):
            types = [types]
        seqids = args.get('seqids')
        if isinstance(seqids, str):
            seqids = [seqids]
        region = args.get('region')
        attr_regex = args.get('attr_regex')
        attr_rx = re.compile(attr_regex) if attr_regex else None
        keep = []
        for r in rows:
            if types and r['type'] not in types:
                continue
            if seqids and r['seqid'] not in seqids:
                continue
            if region:
                m = re.match(r'^(.+?):([0-9,]+)-([0-9,]+)$', str(region))
                if not m:
                    raise ValueError('region 格式应为 seqid:start-end')
                if r['seqid'] != m.group(1):
                    continue
                a, b = int(m.group(2).replace(',', '')), int(m.group(3).replace(',', ''))
                if r['end'] < a or r['start'] > b:
                    continue
            if attr_rx:
                blob = ';'.join('%s=%s' % (k, v) for k, v in r['attrs'].items())
                if not (attr_rx.search(blob) or attr_rx.search(r['raw'])):
                    continue
            keep.append(r)
        if not keep:
            raise ValueError('过滤后 0 条记录（放宽条件重试）')
        out_file = _out_path(args, _default_out_name(gff, '.filtered.gff3'))
        with open(out_file, 'w', encoding='utf-8', newline='\n') as out:
            out.write('##gff-version 3\n')
            for r in keep:
                out.write(r['raw'] + '\n')
        return {
            'action': action,
            'n_selected': len(keep),
            'n_total': len(rows),
            'output_file': out_file,
        }

    raise ValueError('action 仅支持 stats / filter / extract_region')
