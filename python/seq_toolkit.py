"""dsh-bio-genie 序列工具箱 —— FASTA 批量处理（批次 A1）

本模块实现 FASTA 流域的批量操作 op：
  - fasta_extract  按 ID/区域/条件批量提取（流式索引，大文件友好）
  - fasta_stats    批量统计（N50/N90/长度分布/GC/滑窗）
  - fasta_table    FASTA <-> 表格 双向转换
  - fasta_ids      ID 简化 / 重命名映射 / 前缀后缀

设计约束：
  - 只依赖 stdlib + Biopython（不引入新包）
  - 大文件走字节级流式索引（先扫一遍建 offset，再按需 seek 读取）
  - fail-closed：条件缺失/零命中给明确错误；部分缺失显式列出
  - 输出大内容一律落文件，JSON 只带摘要 + 预览
"""
import os
import re
import sys

_LINE_BR = b'\n'


# ============================================================================
# 基础工具：路径、ID 规整
# ============================================================================

def _req_path(args, key):
    """取必填文件路径参数；相对路径基于工作区（进程 CWD）。"""
    v = args.get(key)
    if not v or not isinstance(v, str):
        raise ValueError('参数 %s 必填：提供 FASTA 文件路径' % key)
    if not os.path.isfile(v):
        raise ValueError('文件不存在：%s' % v)
    return v


def _out_path(args, default_name):
    """输出路径：显式参数优先，否则用工作区默认名。"""
    v = args.get('output_file')
    if v:
        return os.path.abspath(v)
    return os.path.abspath(default_name)


def _norm_id_list(args):
    """合并 ids 数组与 id_file，返回去重有序 ID 列表。"""
    out = []
    seen = set()
    ids = args.get('ids') or []
    if isinstance(ids, str):
        ids = [x.strip() for x in re.split(r'[,;\s]+', ids) if x.strip()]
    for x in ids:
        s = str(x).strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    id_file = args.get('id_file')
    if id_file:
        if not os.path.isfile(id_file):
            raise ValueError('id_file 不存在：%s' % id_file)
        with open(id_file, 'r', encoding='utf-8', errors='replace') as fh:
            for line in fh:
                s = line.strip()
                if not s or s.startswith('#'):
                    continue
                if s not in seen:
                    seen.add(s)
                    out.append(s)
    return out


# ============================================================================
# FASTA 流式索引与读取
# ============================================================================

def scan_fasta_index(path):
    """流式扫描 FASTA，返回记录索引列表。

    每条记录：{'id': 首词, 'desc': 剩余描述, 'start': 头部行字节偏移,
               'end': 下一条头部行字节偏移（末条为 EOF）}
    """
    records = []
    cur = None
    with open(path, 'rb') as fh:
        offset = 0
        for raw in fh:
            if raw[:1] == b'>':
                if cur is not None:
                    cur['end'] = offset
                    records.append(cur)
                header = raw[1:].strip().decode('utf-8', errors='replace')
                if header:
                    parts = header.split(None, 1)
                    rid = parts[0]
                    desc = parts[1].strip() if len(parts) > 1 else ''
                else:
                    rid, desc = '', ''
                cur = {'id': rid, 'desc': desc, 'start': offset, 'end': None}
            offset += len(raw)
        if cur is not None:
            cur['end'] = offset
            records.append(cur)
    return records


def read_fasta_region(path, start, end):
    """按字节区间读取一条 FASTA 记录的核心序列（去换行，保留大小写）。"""
    with open(path, 'rb') as fh:
        fh.seek(start)
        block = fh.read(end - start)
    parts = block.split(b'\n', 1)
    if len(parts) < 2:
        return ''
    body = parts[1]
    body = body.replace(b'\r', b'')
    return body.replace(b'\n', b'').decode('ascii', errors='replace')


def iter_fasta(path, index=None):
    """生成 (record_dict, sequence_str)。index 可复用预扫描结果。"""
    if index is None:
        index = scan_fasta_index(path)
    for rec in index:
        yield rec, read_fasta_region(path, rec['start'], rec['end'])


def _gc_percent(seq):
    if not seq:
        return 0.0
    s = seq.upper()
    gc = s.count('G') + s.count('C')
    atgc = gc + s.count('A') + s.count('T') + s.count('U')
    denom = atgc if atgc > 0 else len(s)
    return round(100.0 * gc / denom, 4)


def _default_out_name(src, suffix):
    stem = os.path.basename(src)
    for ext in ('.fa', '.fasta', '.fna', '.fas', '.ffn', '.faa', '.fa.gz', '.fasta.gz'):
        if stem.lower().endswith(ext):
            stem = stem[: -len(ext)]
            break
    return stem + suffix


def _id_key(rid, mode):
    """按匹配模式归一 ID。"""
    if mode == 'exact':
        return rid
    if mode == 'first_word':
        return rid.split('|')[-1] if '|' in rid else rid
    return rid  # contains 模式单独处理


# ============================================================================
# op: fasta_extract —— 批量提取 / 条件过滤 / 子序列 / 最长代表
# ============================================================================

def _parse_regions(regions):
    """regions: ["seqid:100-200"] -> [(id, start1, end1)]（1-based 闭区间）。"""
    out = []
    for r in regions or []:
        if isinstance(r, dict):
            rid = str(r.get('id', ''))
            a, b = int(r.get('start', 0)), int(r.get('end', 0))
        else:
            s = str(r).strip()
            m = re.match(r'^(.+?):([0-9,]+)-([0-9,]+)$', s)
            if not m:
                raise ValueError('区域格式应为 id:start-end（1-based 闭区间），收到：%s' % s)
            rid = m.group(1)
            a, b = int(m.group(2).replace(',', '')), int(m.group(3).replace(',', ''))
        if a < 1 or b < a:
            raise ValueError('区域坐标非法（需 1-based 且 start<=end）：%s' % r)
        out.append((rid, a, b))
    return out


def op_fasta_extract(args):
    """批量提取：按 ID 列表 / 区域 / 条件过滤 / 最长代表。"""
    src = _req_path(args, 'input')
    ids = _norm_id_list(args)
    regions = _parse_regions(args.get('regions'))
    flt = args.get('filter') or {}
    id_match = str(args.get('id_match') or 'exact').lower()
    if id_match not in ('exact', 'first_word', 'contains'):
        raise ValueError("id_match 仅支持 exact / first_word / contains")
    longest = bool(args.get('longest'))
    longest_sep = str(args.get('longest_sep') or 'first_word')

    if not ids and not regions and not flt and not longest:
        raise ValueError('至少提供一种提取条件：ids / id_file / regions / filter / longest')

    index = scan_fasta_index(src)
    if not index:
        raise ValueError('输入 FASTA 中没有找到任何记录：%s' % src)

    # 长度缓存（过滤需要）
    lengths = {}

    def _len_of(rec):
        key = (rec['start'], rec['end'])
        if key not in lengths:
            lengths[key] = len(read_fasta_region(src, rec['start'], rec['end']))
        return lengths[key]

    selected = []      # [(rec, sub_or_None)]  sub=(start1,end1) 1-based
    missing = []

    if ids:
        # 建立查询索引
        exact = {}
        fw = {}
        for rec in index:
            exact.setdefault(rec['id'], []).append(rec)
            fw.setdefault(_id_key(rec['id'], 'first_word'), []).append(rec)
        for rid in ids:
            hits = []
            if id_match == 'exact':
                hits = exact.get(rid, [])
            elif id_match == 'first_word':
                hits = fw.get(_id_key(rid, 'first_word'), [])
            else:  # contains
                hits = [r for r in index if rid in r['id']]
            if not hits:
                missing.append(rid)
            for rec in hits:
                selected.append((rec, None))

    if regions:
        by_id = {}
        for rec in index:
            by_id.setdefault(rec['id'], []).append(rec)
        for rid, a, b in regions:
            cand = by_id.get(rid) or []
            if not cand and id_match != 'exact':
                cand = [r for r in index if rid in r['id']]
            if not cand:
                missing.append('region:%s' % rid)
                continue
            for rec in cand:
                selected.append((rec, (a, b)))

    if flt or longest:
        min_len = flt.get('min_len')
        max_len = flt.get('max_len')
        min_gc = flt.get('min_gc')
        max_gc = flt.get('max_gc')
        id_re = flt.get('id_regex')
        id_rx = re.compile(id_re) if id_re else None
        pool = []
        for rec in index:
            if id_rx and not id_rx.search(rec['id']):
                continue
            L = _len_of(rec)
            if min_len is not None and L < int(min_len):
                continue
            if max_len is not None and L > int(max_len):
                continue
            if (min_gc is not None) or (max_gc is not None):
                gcp = _gc_percent(read_fasta_region(src, rec['start'], rec['end']))
                if min_gc is not None and gcp < float(min_gc):
                    continue
                if max_gc is not None and gcp > float(max_gc):
                    continue
            pool.append(rec)
        if longest:
            groups = {}
            for rec in pool:
                if longest_sep == 'first_word':
                    key = rec['id'].split('|')[0].split('.')[0] if '|' in rec['id'] else re.split(r'[._]', rec['id'])[0]
                else:
                    key = rec['id'].split(str(longest_sep))[0]
                cur = groups.get(key)
                if cur is None or _len_of(rec) > _len_of(cur):
                    groups[key] = rec
            pool = list(groups.values())
        selected.extend((rec, None) for rec in pool)

    # 去重（同一记录同一子区间只输出一次）
    seen = set()
    final = []
    for rec, sub in selected:
        key = (rec['start'], rec['end'], sub)
        if key in seen:
            continue
        seen.add(key)
        final.append((rec, sub))

    if not final:
        raise ValueError('没有命中任何序列：请求 %d 个 ID/区域，0 命中（缺失示例：%s）'
                         % (len(ids) + len(regions), ', '.join(missing[:10]) or '无'))

    out_file = _out_path(args, _default_out_name(src, '.extracted.fasta'))
    total_bp = 0
    preview = []
    with open(out_file, 'w', encoding='utf-8', newline='\n') as out:
        for rec, sub in final:
            seq = read_fasta_region(src, rec['start'], rec['end'])
            if sub is not None:
                a, b = sub
                seq = seq[a - 1: b]
                header = '%s:%d-%d' % (rec['id'], a, min(b, len(seq) + a - 1))
            else:
                header = rec['id'] + ((' ' + rec['desc']) if rec['desc'] else '')
            # 按 60 列换行写出
            out.write('>' + header + '\n')
            for i in range(0, len(seq), 60):
                out.write(seq[i:i + 60] + '\n')
            total_bp += len(seq)
            if len(preview) < 20:
                preview.append({'id': header.split()[0], 'length': len(seq)})

    return {
        'count': len(final),
        'requested': len(ids) + len(regions),
        'missing': missing[:50],
        'missing_count': len(missing),
        'total_bp': total_bp,
        'output_file': out_file,
        'preview': preview,
        'note': '输出共 %d 条序列；缺失 %d 个请求 ID/区域。' % (len(final), len(missing)),
    }


# ============================================================================
# op: fasta_stats —— 批量统计
# ============================================================================

def _nxx(sorted_lengths_desc, total, x):
    """N50/N90 等：累积长度达到 x% 时的序列长度。"""
    target = total * x / 100.0
    acc = 0
    for L in sorted_lengths_desc:
        acc += L
        if acc >= target:
            return L
    return 0


def _n_metrics(lengths):
    n = len(lengths)
    total = sum(lengths)
    desc = sorted(lengths, reverse=True)
    return {
        'n': n,
        'total_bp': total,
        'mean_len': round(total / n, 2) if n else 0,
        'median_len': int(desc[n // 2]) if n else 0,
        'min_len': min(desc) if desc else 0,
        'max_len': max(desc) if desc else 0,
        'n50': _nxx(desc, total, 50),
        'n90': _nxx(desc, total, 90),
    }


def op_fasta_stats(args):
    """FASTA 批量统计：汇总指标 + 每条序列表 + 长度分布 + 可选滑窗。"""
    src = _req_path(args, 'input')
    per_sequence = bool(args.get('per_sequence', True))
    write_table = bool(args.get('write_table', True))
    window = args.get('window') or None
    wsize = args.get('window_size')
    if wsize:
        window = {'size': wsize, 'step': args.get('window_step', wsize)}

    index = scan_fasta_index(src)
    if not index:
        raise ValueError('输入 FASTA 中没有找到任何记录：%s' % src)

    rows = []
    lengths = []
    total_gc = 0
    total_denom = 0
    for rec, seq in iter_fasta(src, index):
        L = len(seq)
        lengths.append(L)
        gcp = _gc_percent(seq)
        s = seq.upper()
        gc = s.count('G') + s.count('C')
        atgc = gc + s.count('A') + s.count('T') + s.count('U')
        total_gc += gc
        total_denom += atgc if atgc > 0 else L
        rows.append({
            'id': rec['id'],
            'length': L,
            'gc_percent': gcp,
            'n_count': s.count('N'),
        })

    metrics = _n_metrics(lengths)
    metrics['gc_percent'] = round(100.0 * total_gc / total_denom, 4) if total_denom else 0.0

    # 长度分布直方图（自适应分箱：等宽 20 箱，空长度除外）
    hist = None
    if lengths:
        lo, hi = min(lengths), max(lengths)
        if hi == lo:
            hist = {'bin_width': 1, 'bins': [{'from': lo, 'to': hi, 'count': len(lengths)}]}
        else:
            nbins = min(20, max(5, len(lengths) // 5)) if len(lengths) > 20 else 10
            width = max(1, (hi - lo + nbins - 1) // nbins)
            bins = []
            start = lo
            counts = [0] * ((hi - lo) // width + 1)
            for L in lengths:
                counts[(L - lo) // width] += 1
            for i, c in enumerate(counts):
                bins.append({'from': lo + i * width, 'to': lo + (i + 1) * width - 1, 'count': c})
            hist = {'bin_width': width, 'bins': bins}

    # 滑窗统计（仅当给出 window 且记录数不太多时做聚合输出）
    window_stats = None
    if window:
        w = int(window.get('size') if isinstance(window, dict) else window)
        step = int(window.get('step', w) if isinstance(window, dict) else w)
        if w < 1 or step < 1:
            raise ValueError('window.size / window.step 必须为正整数')
        series = []
        for rec, seq in iter_fasta(src, index):
            s = seq.upper()
            vals = []
            for i in range(0, max(1, len(s) - w + 1), step):
                seg = s[i:i + w]
                g = seg.count('G') + seg.count('C')
                vals.append(round(100.0 * g / len(seg), 3) if seg else 0.0)
            series.append({'id': rec['id'], 'gc_windows': vals[:5000]})
        window_stats = {
            'window': w,
            'step': step,
            'series': series[:20],
            'truncated': len(series) > 20,
        }

    table_file = None
    if per_sequence and write_table:
        table_file = _out_path(args, _default_out_name(src, '.stats.tsv'))
        with open(table_file, 'w', encoding='utf-8', newline='\n') as out:
            out.write('id\tlength\tgc_percent\tn_count\n')
            for r in rows:
                out.write('%s\t%d\t%s\t%d\n' % (r['id'], r['length'], r['gc_percent'], r['n_count']))

    result = dict(metrics)
    result['length_histogram'] = hist
    result['per_sequence_preview'] = rows[:50]
    result['preview_truncated'] = len(rows) > 50
    result['table_file'] = table_file
    if window_stats:
        result['window_stats'] = window_stats
    return result


# ============================================================================
# op: fasta_table —— FASTA <-> 表格
# ============================================================================

def op_fasta_table(args):
    """FASTA -> 表格（id/desc/length/gc/seq 可选列）；表格 -> FASTA。"""
    action = str(args.get('action') or 'to_table').lower()
    src = _req_path(args, 'input')

    if action == 'to_table':
        fields = args.get('fields') or ['id', 'description', 'length', 'gc_percent']
        include_seq = bool(args.get('include_sequence', False))
        index = scan_fasta_index(src)
        if not index:
            raise ValueError('输入 FASTA 中没有找到任何记录：%s' % src)
        out_file = _out_path(args, _default_out_name(src, '.table.tsv'))
        n = 0
        with open(out_file, 'w', encoding='utf-8', newline='\n') as out:
            cols = list(fields) + (['sequence'] if include_seq and 'sequence' not in fields else [])
            out.write('\t'.join(cols) + '\n')
            for rec, seq in iter_fasta(src, index):
                vals = []
                for c in cols:
                    if c == 'id':
                        vals.append(rec['id'])
                    elif c == 'description':
                        vals.append(rec['desc'])
                    elif c == 'length':
                        vals.append(str(len(seq)))
                    elif c == 'gc_percent' or c == 'gc':
                        vals.append(str(_gc_percent(seq)))
                    elif c == 'sequence':
                        vals.append(seq)
                    else:
                        raise ValueError('不支持的表列字段：%s（支持 id/description/length/gc_percent/sequence）' % c)
                out.write('\t'.join(vals) + '\n')
                n += 1
        return {
            'action': 'to_table',
            'count': n,
            'columns': cols,
            'output_file': out_file,
        }

    if action == 'to_fasta':
        id_col = str(args.get('id_col') or 'id')
        seq_col = str(args.get('sequence_col') or 'sequence')
        desc_col = args.get('description_col')
        comment = str(args.get('comment_prefix') or '#')
        with open(src, 'r', encoding='utf-8', errors='replace', newline='') as fh:
            lines = [ln.rstrip('\r\n') for ln in fh if ln.strip() and not ln.startswith(comment)]
        if not lines:
            raise ValueError('输入表格没有数据行：%s' % src)
        header = lines[0].split('\t')
        if id_col not in header or seq_col not in header:
            raise ValueError('表头中没有找到 id_col=%s 或 sequence_col=%s（表头：%s）'
                             % (id_col, seq_col, ', '.join(header[:12])))
        i_id, i_seq = header.index(id_col), header.index(seq_col)
        i_desc = header.index(desc_col) if (desc_col and desc_col in header) else None
        out_file = _out_path(args, _default_out_name(src, '.fasta'))
        n = 0
        with open(out_file, 'w', encoding='utf-8', newline='\n') as out:
            for ln in lines[1:]:
                cells = ln.split('\t')
                if max(i_id, i_seq) >= len(cells):
                    continue
                rid = cells[i_id].strip()
                seq = re.sub(r'\s+', '', cells[i_seq])
                if not rid or not seq:
                    continue
                desc = cells[i_desc].strip() if (i_desc is not None and i_desc < len(cells)) else ''
                out.write('>' + rid + ((' ' + desc) if desc else '') + '\n')
                for i in range(0, len(seq), 60):
                    out.write(seq[i:i + 60] + '\n')
                n += 1
        if n == 0:
            raise ValueError('表格转换后 0 条序列（检查列名与内容是否为空）')
        return {
            'action': 'to_fasta',
            'count': n,
            'output_file': out_file,
        }

    raise ValueError("action 仅支持 to_table / to_fasta，收到：%s" % action)


# ============================================================================
# op: fasta_ids —— ID 简化 / 重命名 / 前后缀
# ============================================================================

def _simplify_id(rid, pattern=None, group=1):
    if pattern:
        m = re.match(pattern, rid)
        if not m:
            return None
        try:
            return m.group(group)
        except IndexError:
            return m.group(0)
    # 默认：截到首个分隔符（空白 / | / .）之前
    parts = re.split(r'[|.\s]', rid)
    return parts[0] if parts and parts[0] else rid


def op_fasta_ids(args):
    """FASTA ID 重写：simplify（默认首词）/ rename（映射文件）/ prefix / suffix。"""
    src = _req_path(args, 'input')
    action = str(args.get('action') or 'simplify').lower()
    out_file = _out_path(args, _default_out_name(src, '.ids.fasta'))

    mapping = None
    if action == 'rename':
        map_file = args.get('map_file')
        if not map_file or not os.path.isfile(map_file):
            raise ValueError('rename 需要 map_file（两列 TSV：旧ID<TAB>新ID）')
        mapping = {}
        with open(map_file, 'r', encoding='utf-8', errors='replace') as fh:
            for ln in fh:
                ln = ln.rstrip('\r\n')
                if not ln or ln.startswith('#'):
                    continue
                cells = re.split(r'\t+', ln)
                if len(cells) < 2:
                    cells = ln.split(None, 1)
                if len(cells) >= 2:
                    mapping[cells[0].strip()] = cells[1].strip()
        if not mapping:
            raise ValueError('map_file 中没有解析到映射条目：%s' % map_file)
    elif action == 'simplify':
        pass
    elif action in ('prefix', 'suffix'):
        if not args.get('text'):
            raise ValueError('%s 需要 text 参数（要加的前缀/后缀文本）' % action)
    else:
        raise ValueError('action 仅支持 simplify / rename / prefix / suffix')

    pattern = args.get('pattern')
    group = int(args.get('group', 1))
    text = str(args.get('text') or '')
    keep_desc = bool(args.get('keep_description', False))

    index = scan_fasta_index(src)
    if not index:
        raise ValueError('输入 FASTA 中没有找到任何记录：%s' % src)

    n = 0
    unmapped = []
    changed_ids = []
    with open(out_file, 'w', encoding='utf-8', newline='\n') as out:
        for rec, seq in iter_fasta(src, index):
            rid = rec['id']
            if action == 'simplify':
                new_id = _simplify_id(rid, pattern, group)
                if new_id is None:
                    new_id = rid
            elif action == 'rename':
                new_id = mapping.get(rid)
                if new_id is None:
                    unmapped.append(rid)
                    new_id = rid
            elif action == 'prefix':
                new_id = text + rid
            else:
                new_id = rid + text
            header = new_id + ((' ' + rec['desc']) if (keep_desc and rec['desc']) else '')
            out.write('>' + header + '\n')
            for i in range(0, len(seq), 60):
                out.write(seq[i:i + 60] + '\n')
            n += 1
            if len(changed_ids) < 20 and new_id != rid:
                changed_ids.append({'old': rid, 'new': new_id})

    return {
        'action': action,
        'count': n,
        'changed_preview': changed_ids,
        'unmapped_count': len(unmapped),
        'unmapped_preview': unmapped[:20],
        'output_file': out_file,
    }
