"""表格与文件工具（批次 E）：表格行列操作 / 文件合并拆分。

- bio_table_ops       表格：select / filter / sort / drop_dup / head / transpose / join
- bio_file_merge_split 文件：split_fasta / merge_fasta / split_table / merge_table

仅标准库（csv/io），分隔符自动嗅探（TSV / CSV / 空白）。确定性输出：
UTF-8 + LF，不做隐式列重排。
"""
import csv
import io
import os
import re


def _sniff_delim(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        head = fh.readline().rstrip('\r\n')
    if '\t' in head:
        return '\t'
    if ',' in head:
        return ','
    return None  # 空白分隔


def _read_table(path):
    delim = _sniff_delim(path)
    rows = []
    with open(path, 'r', encoding='utf-8', errors='replace', newline='') as fh:
        if delim is None:
            for ln in fh:
                ln = ln.rstrip('\r\n')
                if ln.strip() == '':
                    continue
                rows.append(ln.split())
        else:
            reader = csv.reader(fh, delimiter=delim)
            for row in reader:
                if not row:
                    continue
                rows.append(row)
    if not rows:
        raise ValueError('表格为空：%s' % path)
    return rows, delim


def _write_table(path, rows, delim):
    d = delim or '\t'
    with open(path, 'w', encoding='utf-8', newline='') as fh:
        w = csv.writer(fh, delimiter=d, lineterminator='\n')
        for row in rows:
            w.writerow(row)
    return os.path.abspath(path)


def _col_index(header, col):
    """列引用：名字（表头）或 0 基下标（int 或数字字符串）。"""
    if col is None:
        return None
    s = str(col)
    if s.isdigit() and int(s) < len(header):
        return int(s)
    if col in header:
        return header.index(col)
    raise ValueError('列不存在：%r（表头：%s）' % (col, ', '.join(header[:12])))


def _body_rows(rows, has_header):
    if has_header:
        return rows[0], rows[1:]
    return None, rows


def op_table_ops(args):
    """表格行列操作（action 族）。"""
    action = str(args.get('action') or '').lower()
    src = args.get('input')
    if not src or not os.path.isfile(src):
        raise ValueError('input 需要表格文件路径；收到：%s' % src)
    has_header = bool(args.get('has_header', True))
    rows, delim = _read_table(src)
    header, body = _body_rows(rows, has_header)
    out_file = args.get('output_file')

    if action == 'select':
        cols = args.get('columns')
        if not cols:
            raise ValueError('select 需要 columns（列名或下标清单）')
        idx = [_col_index(header if header else body[0], c) for c in cols]
        new_rows = []
        if header:
            new_rows.append([header[i] for i in idx])
        for r in body:
            new_rows.append([r[i] if i < len(r) else '' for i in idx])
        out = out_file or os.path.splitext(src)[0] + '.select.tsv'

    elif action == 'filter':
        col = _col_index(header if header else body[0], args.get('column'))
        op = str(args.get('op') or 'eq').lower()
        val = args.get('value')
        if val is None:
            raise ValueError('filter 需要 value')

        def keep(r):
            cell = r[col] if col < len(r) else ''
            if op == 'eq':
                return cell == str(val)
            if op == 'ne':
                return cell != str(val)
            if op == 'contains':
                return str(val) in cell
            if op == 'regex':
                return re.search(str(val), cell) is not None
            try:
                a, b = float(cell), float(val)
            except ValueError:
                raise ValueError('数值比较需要单元格为数值：%r %s %r' % (cell, op, val))
            return {'gt': a > b, 'ge': a >= b, 'lt': a < b, 'le': a <= b}.get(op, False)

        new_rows = ([header] if header else []) + [r for r in body if keep(r)]
        out = out_file or os.path.splitext(src)[0] + '.filtered.tsv'

    elif action == 'sort':
        col = _col_index(header if header else body[0], args.get('column'))
        numeric = bool(args.get('numeric', True))
        rev = bool(args.get('reverse', False))

        def key(r):
            cell = r[col] if col < len(r) else ''
            if numeric:
                try:
                    return (0, float(cell))
                except ValueError:
                    return (1, 0.0)
            return (0, cell)

        new_rows = ([header] if header else []) + sorted(body, key=key, reverse=rev)
        out = out_file or os.path.splitext(src)[0] + '.sorted.tsv'

    elif action == 'drop_dup':
        cols = args.get('columns')
        if cols:
            idx = [_col_index(header if header else body[0], c) for c in cols]
        else:
            idx = list(range(len(header if header else body[0])))
        seen = set()
        uniq = []
        for r in body:
            k = tuple(r[i] if i < len(r) else '' for i in idx)
            if k in seen:
                continue
            seen.add(k)
            uniq.append(r)
        new_rows = ([header] if header else []) + uniq
        out = out_file or os.path.splitext(src)[0] + '.dedup.tsv'

    elif action == 'head':
        n = int(args.get('n') or 10)
        new_rows = ([header] if header else []) + body[:n]
        out = out_file or os.path.splitext(src)[0] + '.head.tsv'

    elif action == 'transpose':
        all_rows = ([header] if header else []) + body
        width = max(len(r) for r in all_rows)
        padded = [r + [''] * (width - len(r)) for r in all_rows]
        new_rows = [list(col) for col in zip(*padded)]
        out = out_file or os.path.splitext(src)[0] + '.transposed.tsv'

    elif action == 'join':
        src2 = args.get('input2')
        if not src2 or not os.path.isfile(src2):
            raise ValueError('join 需要 input2')
        key = args.get('key')
        key2 = args.get('key2', key)
        how = str(args.get('how') or 'inner').lower()
        if not key:
            raise ValueError('join 需要 key（左表连接列名/下标）')
        rows2, _d2 = _read_table(src2)
        h2, b2 = _body_rows(rows2, bool(args.get('has_header2', True)))
        ref1 = header if header else body[0]
        ref2 = h2 if h2 else b2[0]
        k1 = _col_index(ref1, key)
        k2 = _col_index(ref2, key2)
        idx2 = {}
        for r in b2:
            idx2.setdefault(r[k2] if k2 < len(r) else '', []).append(r)
        extra_head = []
        if h2:
            extra_head = [c for i, c in enumerate(h2) if i != k2]
        new_rows = []
        if header:
            new_rows.append(header + extra_head)
        for r in body:
            k = r[k1] if k1 < len(r) else ''
            matches = idx2.get(k, [])
            if matches:
                for m in matches:
                    new_rows.append(r + [c for i, c in enumerate(m) if i != k2])
            elif how == 'left':
                new_rows.append(r + [''] * len(extra_head))
        out = out_file or os.path.splitext(src)[0] + '.joined.tsv'

    else:
        raise ValueError("action 仅支持 select / filter / sort / drop_dup / head / transpose / join；收到：%s" % action)

    abspath = _write_table(out, new_rows, delim)
    n_data = len(new_rows) - (1 if (header and action != 'transpose') else 0)
    return {
        'action': action,
        'rows_in': len(body),
        'rows_out': max(n_data, 0),
        'columns_out': len(new_rows[0]) if new_rows else 0,
        'output_file': abspath,
        'preview': new_rows[:3],
    }


def op_file_merge_split(args):
    """FASTA/表格文件合并与拆分（action 族）。"""
    action = str(args.get('action') or '').lower()

    if action in ('split_fasta', 'split_table'):
        src = args.get('input')
        if not src or not os.path.isfile(src):
            raise ValueError('input 需要文件路径；收到：%s' % src)
        out_dir = args.get('out_dir') or (os.path.splitext(src)[0] + '.split')
        os.makedirs(out_dir, exist_ok=True)

        if action == 'split_fasta':
            chunk = int(args.get('chunk_size') or 100)
            if chunk < 1:
                raise ValueError('chunk_size 需 >=1')
            seqs = []
            name, buf = None, []
            with open(src, 'r', encoding='utf-8', errors='replace') as fh:
                for ln in fh:
                    if ln.startswith('>'):
                        if name is not None:
                            seqs.append((name, buf))
                        name, buf = ln, []
                    else:
                        buf.append(ln)
            if name is not None:
                seqs.append((name, buf))
            if not seqs:
                raise ValueError('FASTA 为空：%s' % src)
            files = []
            for ci in range(0, len(seqs), chunk):
                part = seqs[ci:ci + chunk]
                fp = os.path.join(out_dir, 'part_%03d.fa' % (ci // chunk + 1))
                with open(fp, 'w', encoding='utf-8', newline='\n') as fh:
                    for nm, bf in part:
                        fh.write(nm)
                        fh.writelines(bf)
                files.append(fp)
            return {'action': action, 'n_sequences': len(seqs), 'n_files': len(files),
                    'out_dir': os.path.abspath(out_dir), 'files': files[:20]}

        # split_table
        src_rows, delim = _read_table(src)
        rows_per = int(args.get('rows_per_file') or 1000)
        keep_header = bool(args.get('keep_header', True))
        header, body = _body_rows(src_rows, bool(args.get('has_header', True)))
        files = []
        for ci in range(0, len(body), rows_per):
            part = body[ci:ci + rows_per]
            fp = os.path.join(out_dir, 'part_%03d.tsv' % (ci // rows_per + 1))
            to_write = ([header] if (header and keep_header) else []) + part
            _write_table(fp, to_write, delim)
            files.append(fp)
        return {'action': action, 'rows': len(body), 'n_files': len(files),
                'out_dir': os.path.abspath(out_dir), 'files': files[:20]}

    if action in ('merge_fasta', 'merge_table'):
        inputs = args.get('inputs')
        if not inputs or not isinstance(inputs, list):
            raise ValueError('inputs 需要文件路径列表')
        for p in inputs:
            if not os.path.isfile(p):
                raise ValueError('输入文件不存在：%s' % p)
        out = args.get('output_file') or ('merged.fa' if action == 'merge_fasta' else 'merged.tsv')

        if action == 'merge_fasta':
            seen = set()
            n_total = n_written = 0
            dedup = bool(args.get('dedup_id', False))
            with open(out, 'w', encoding='utf-8', newline='\n') as fo:
                for p in inputs:
                    with open(p, 'r', encoding='utf-8', errors='replace') as fh:
                        write_this = True
                        for ln in fh:
                            if ln.startswith('>'):
                                n_total += 1
                                sid = ln[1:].strip().split()[0] if ln[1:].strip() else ''
                                write_this = not (dedup and sid in seen)
                                if dedup:
                                    seen.add(sid)
                                if write_this:
                                    n_written += 1
                            if write_this:
                                fo.write(ln if ln.endswith('\n') else ln + '\n')
            return {'action': action, 'n_sequences_in': n_total, 'n_sequences_out': n_written,
                    'dedup_id': dedup, 'output_file': os.path.abspath(out), 'n_inputs': len(inputs)}

        # merge_table：第一个文件的表头保留，其余文件跳过表头（可选）
        skip_header_rest = bool(args.get('skip_rest_headers', True))
        delim = _sniff_delim(inputs[0])
        written = 0
        with open(out, 'w', encoding='utf-8', newline='') as fo:
            w = csv.writer(fo, delimiter=delim or '\t', lineterminator='\n')
            for i, p in enumerate(inputs):
                rows, _d = _read_table(p)
                start = 0 if (i == 0 or not skip_header_rest) else 1
                for r in rows[start:]:
                    w.writerow(r)
                    written += 1
        return {'action': action, 'rows_out': written, 'n_inputs': len(inputs),
                'output_file': os.path.abspath(out)}

    raise ValueError("action 仅支持 split_fasta / merge_fasta / split_table / merge_table；收到：%s" % action)
