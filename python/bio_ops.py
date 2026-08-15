"""dsh-biology Python 操作层 — JSON 协议分发器

TS 侧通过 stdin 发送 {"op": "...", "args": {...}}，本脚本执行后
将 {"ok": true, "result": ...} 或 {"ok": false, "error": "..."} 写到 stdout。

每个 op 对应一个生物学操作，内部使用 Biopython。新增功能 = 新增 op 函数 + 注册。
"""
import json
import sys
import traceback

# ---- 序列分析 ----

def op_seq_analyze(args):
    """分析 DNA/RNA/蛋白质序列：长度、GC%、翻译、互补、分子量等。"""
    from Bio.Seq import Seq
    from Bio.SeqUtils import gc_fraction, molecular_weight

    sequence = args['sequence']
    seq_type = args.get('seq_type', 'auto')  # auto | dna | rna | protein
    s = Seq(sequence)
    result = {
        'length': len(s),
        'sequence': sequence.upper(),
    }

    if seq_type in ('auto', 'dna', 'rna'):
        # 自动判断：含 U 视为 RNA，含 T 视为 DNA
        upper = sequence.upper()
        if seq_type == 'auto':
            if 'U' in upper and 'T' not in upper:
                seq_type = 'rna'
            else:
                seq_type = 'dna'
        result['seq_type'] = seq_type

        if seq_type == 'dna':
            result['gc_fraction'] = gc_fraction(s)
            result['gc_percent'] = round(gc_fraction(s) * 100, 2)
            result['reverse_complement'] = str(s.reverse_complement())
            result['complement'] = str(s.complement())
            # 六框翻译（前 3 个正链，后 3 个是负链的互补）
            frames = {}
            for frame in range(3):
                translated = s[frame:].translate(to_stop=False)
                frames[f'+{frame + 1}'] = str(translated)
            result['translations'] = frames
        elif seq_type == 'rna':
            result['gc_fraction'] = gc_fraction(s)
            result['gc_percent'] = round(gc_fraction(s) * 100, 2)
            result['reverse_complement'] = str(s.reverse_complement())
            result['translations'] = {f'+{frame + 1}': str(s[frame:].translate()) for frame in range(3)}

    if seq_type == 'protein':
        result['seq_type'] = 'protein'
        result['molecular_weight'] = round(molecular_weight(s), 2)

    return result


def op_seq_translate(args):
    """翻译 DNA/RNA 为蛋白质。"""
    from Bio.Seq import Seq
    s = Seq(args['sequence'])
    table = args.get('table', 1)
    to_stop = args.get('to_stop', False)
    result = {
        'protein': str(s.translate(table=table, to_stop=to_stop)),
        'table': table,
        'to_stop': to_stop,
    }
    return result


def op_seq_gc_skew(args):
    """计算 GC skew (G-C)/(G+C)，可窗口化。"""
    from Bio.SeqUtils import GC_skew
    sequence = args['sequence']
    window = args.get('window', 100)
    skews = GC_skew(sequence, window=window)
    return {'window': window, 'gc_skew': [round(float(v), 4) for v in skews]}


def op_seq_find_orf(args):
    """查找最长 ORF（开放阅读框）。"""
    from Bio.Seq import Seq
    sequence = args['sequence']
    min_len = args.get('min_len', 30)  # 至少 10 个密码子
    table = args.get('table', 1)
    s = Seq(sequence)
    best = None
    for frame in range(3):
        for start in range(frame, len(s) - 2, 3):
            # 从 ATG 开始
            if s[start:start + 3] != 'ATG':
                continue
            for end in range(start + 3, len(s) - 2, 3):
                codon = s[end:end + 3]
                if codon in ('TAA', 'TAG', 'TGA'):
                    length = end - start + 3
                    if length >= min_len and (best is None or length > best['length']):
                        best = {
                            'start': start,
                            'end': end + 3,
                            'length': length,
                            'frame': frame + 1,
                            'protein': str(s[start:end + 3].translate(table=table, to_stop=True)),
                        }
                    break
    return {'orf': best}


def op_seq_restriction(args):
    """限制酶位点分析。"""
    from Bio.Restriction import RestrictionBatch
    from Bio.Seq import Seq

    sequence = args['sequence']
    enzymes = args.get('enzymes', None)  # 如 ["EcoRI", "BamHI"]，None = 全部
    linear = args.get('linear', True)  # 线性/环状影响位点计数
    s = Seq(sequence)

    if enzymes:
        batch = RestrictionBatch()
        missing = []
        for e in enzymes:
            try:
                batch.add(e)
            except Exception:
                missing.append(e)
    else:
        batch = RestrictionBatch()

    sites = {}
    for enz in batch:
        hits = enz.search(s, linear=linear)
        if hits:
            # search 返回切割位点（0-based）；识别序列位置需用酶属性
            sites[str(enz)] = {
                'cut_positions': [int(p) for p in hits],
                'recognition_site': enz.site,
                'count': len(hits),
            }
    result = {'sites': sites}
    if enzymes:
        result['requested'] = enzymes
        if missing:
            result['missing_enzymes'] = missing
    return result


def op_seq_io_read(args):
    """读取序列文件（FASTA/GenBank 等），返回记录摘要。"""
    from Bio import SeqIO
    path = args['path']
    fmt = args.get('format', None)  # 不指定则自动推断
    limit = args.get('limit', 50)
    if fmt is None:
        # 简单自动推断
        lower = path.lower()
        if lower.endswith(('.fa', '.fasta', '.fna', '.ffn', '.faa', '.fas')):
            fmt = 'fasta'
        elif lower.endswith(('.gb', '.genbank', '.gbk')):
            fmt = 'genbank'
        else:
            fmt = 'fasta'
    records = []
    count = 0
    # 编码容错：优先 UTF-8，失败回退 GBK（中文 Windows 常见）
    try:
        handle = open(path, 'r', encoding='utf-8')
    except UnicodeDecodeError:
        handle = open(path, 'r', encoding='gbk')
    with handle:
        for rec in SeqIO.parse(handle, fmt):
            if count >= limit:
                break
            records.append({
                'id': rec.id,
                'name': rec.name,
                'description': rec.description,
                'length': len(rec.seq),
                'seq_preview': str(rec.seq[:100]),
            })
            count += 1
    return {'format': fmt, 'count': count, 'records': records}


def op_seq_io_write(args):
    """写序列到文件（FASTA）。"""
    from Bio.Seq import Seq
    from Bio.SeqRecord import SeqRecord
    from Bio import SeqIO
    path = args['path']
    records = args['records']  # [{id, sequence, description?}]
    fmt = args.get('format', 'fasta')
    seq_records = [
        SeqRecord(Seq(r['sequence']), id=r['id'], name=r.get('name', r['id']),
                  description=r.get('description', ''))
        for r in records
    ]
    SeqIO.write(seq_records, path, fmt)
    return {'path': path, 'format': fmt, 'written': len(seq_records)}


def op_seq_kmer(args):
    """k-mer 频率统计。"""
    from collections import Counter
    sequence = args['sequence'].upper()
    k = args.get('k', 3)
    if k < 1:
        raise ValueError('k must be >= 1')
    counts = Counter(sequence[i:i + k] for i in range(len(sequence) - k + 1))
    top = args.get('top', 10)
    return {
        'k': k,
        'total_kmers': len(sequence) - k + 1,
        'unique_kmers': len(counts),
        'top': dict(counts.most_common(top)),
    }


def op_entrez_search(args):
    """NCBI Entrez 检索：esearch + efetch 摘要。"""
    from Bio import Entrez
    term = args['term']
    db = args.get('db', 'nucleotide')
    retmax = args.get('retmax', 5)
    email = args.get('email', None)
    if email:
        Entrez.email = email
    handle = Entrez.esearch(db=db, term=term, retmax=retmax)
    search = Entrez.read(handle)
    handle.close()
    ids = search.get('IdList', [])
    summaries = []
    if ids and db in ('nucleotide', 'protein'):
        try:
            shandle = Entrez.esummary(db=db, id=','.join(ids))
            records = Entrez.read(shandle)
            shandle.close()
            for r in records:
                summaries.append({
                    'id': r.get('Id', r.get('uid', '')),
                    'title': r.get('Title', ''),
                    'length': r.get('Length', ''),
                    'accession': r.get('Caption', r.get('Accession', '')),
                })
        except Exception as e:
            summaries = [{'id': i, 'note': f'summary fetch failed: {e}'} for i in ids]
    return {'db': db, 'count': int(search.get('Count', 0)), 'ids': ids, 'summaries': summaries}


def op_entrez_fetch(args):
    """NCBI Entrez fetch：取序列。"""
    from Bio import Entrez, SeqIO
    ids = args['ids']
    db = args.get('db', 'nucleotide')
    rettype = args.get('rettype', 'fasta')
    email = args.get('email', None)
    if email:
        Entrez.email = email
    handle = Entrez.efetch(db=db, id=','.join(ids), rettype=rettype, retmode='text')
    text = handle.read()
    handle.close()
    return {'db': db, 'rettype': rettype, 'data': text[:50000]}


def op_env_status(args):
    """环境状态：Python 版本、Biopython 版本。"""
    import sys
    try:
        import Bio
        bio_version = Bio.__version__
    except ImportError:
        bio_version = None
    return {
        'python': sys.version.split()[0],
        'python_path': sys.executable,
        'biopython': bio_version,
    }


# ---- op 注册表 ----
OPS = {
    'seq_analyze': op_seq_analyze,
    'seq_translate': op_seq_translate,
    'seq_gc_skew': op_seq_gc_skew,
    'seq_find_orf': op_seq_find_orf,
    'seq_restriction': op_seq_restriction,
    'seq_io_read': op_seq_io_read,
    'seq_io_write': op_seq_io_write,
    'seq_kmer': op_seq_kmer,
    'entrez_search': op_entrez_search,
    'entrez_fetch': op_entrez_fetch,
    'env_status': op_env_status,
}


def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            print(json.dumps({'ok': False, 'error': 'empty request'}))
            return
        req = json.loads(raw)
        op = req.get('op')
        args = req.get('args', {})
        if op not in OPS:
            print(json.dumps({'ok': False, 'error': f'unknown op: {op}'}))
            return
        result = OPS[op](args)
        print(json.dumps({'ok': True, 'result': result}, ensure_ascii=False))
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
