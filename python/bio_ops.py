"""dsh-biology Python 操作层 — JSON 协议分发器

TS 侧通过 stdin 发送 {"op": "...", "args": {...}}，本脚本执行后
将 {"ok": true, "result": ...} 或 {"ok": false, "error": "..."} 写到 stdout。

每个 op 对应一个生物学操作，内部使用 Biopython。新增功能 = 新增 op 函数 + 注册。
"""
import json
import os
import sys
import traceback

# Windows 下 sys.stdin/stdout 默认按 GBK（locale）编解码，而 Node 侧
# 以 UTF-8 写入/读取。不显式重配置会导致中文参数/结果损坏。强制 UTF-8。
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# -I（isolated）模式下脚本目录不进 sys.path，同目录的 figurelib 包因此
# 不可 import。显式把脚本目录加回（仅插件自己的 payload 目录，不污染宿主）。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 网络 op 统一 20s 单请求上限：慢网络（如中国直连 NCBI）下防无限挂起。
# 带显式 timeout 参数的请求（enrichr/ref_genome）以各自参数为准。
import socket
socket.setdefaulttimeout(20)


def _entrez():
    """配置好的 Bio.Entrez：单请求 20s（socket 级）+ 最多 2 试 + 5s 间隔。

    Bio.Entrez 默认 3 试 × 15s 间隔，最坏 3×30+30=120s 恰好顶满工具层超时；
    收紧后最坏 2×20+5=45s，保留一次重试应对瞬断。
    """
    from Bio import Entrez
    Entrez.max_tries = 2
    Entrez.sleep_between_tries = 5
    return Entrez

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

    # 自动判断序列类型（含蛋白启发式：出现非核酸字母判为蛋白）
    if seq_type == 'auto':
        upper = sequence.upper()
        # 完整 IUPAC DNA 字母表：ACGTN + 模糊碱基 RYSWKMBDHV + X（未知/修饰碱基，
        # 引物/探针/SNP 标记常用；Biopython 的 gc_fraction/reverse_complement/translate 均支持 X）
        # + gap 字符 -/.（比对结果/多序列比对常见；只含核酸+gap 的序列判 DNA 而非蛋白，
        # 蛋白序列由于几乎总含 DNA 字母表外的氨基酸（E/L/P/Q/I/F 等）不受影响）
        dna_iupac = set('ACGTRYSWKMBDHVNX-.')
        if 'U' in upper and 'T' not in upper:
            seq_type = 'rna'
        elif set(upper) - dna_iupac - {'U'}:
            seq_type = 'protein'
        else:
            seq_type = 'dna'

    if seq_type in ('dna', 'rna'):
        result['seq_type'] = seq_type
        result['gc_fraction'] = gc_fraction(s)
        result['gc_percent'] = round(gc_fraction(s) * 100, 2)
        result['reverse_complement'] = str(s.reverse_complement())

        if seq_type == 'dna':
            result['complement'] = str(s.complement())
            # 六框翻译：正链 3 框 + 负链（反向互补）3 框。
            # 含 X（未知/修饰碱基）或 gap 字符（-/.，比对序列常见）的序列直接 translate
            # 会因 XXG / --A / ... 等模糊密码子抛 TranslationError——翻译前统一把
            # X → N、gap → N（未知碱基），Biopython 对 N 密码子正常翻译为 X 氨基酸，
            # 避免整个分析失败（长度不变，逐位对齐保持一致）。
            rc = s.reverse_complement()
            translate_seq = s.replace('X', 'N').replace('-', 'N').replace('.', 'N')
            translate_rc = rc.replace('X', 'N').replace('-', 'N').replace('.', 'N')
            frames = {}
            for frame in range(3):
                frames[f'+{frame + 1}'] = str(translate_seq[frame:].translate(to_stop=False))
                frames[f'-{frame + 1}'] = str(translate_rc[frame:].translate(to_stop=False))
            result['translations'] = frames
        elif seq_type == 'rna':
            result['complement'] = str(s.complement())
            # 与 DNA 分支一致：含 X 的 RNA（探针/引物常见修饰碱基）或 gap 序列翻译前
            # X/gap → N，避免 XXA / --A 等模糊密码子抛 TranslationError（WB 第二轮 S2 确认）
            translate_rna = s.replace('X', 'N').replace('-', 'N').replace('.', 'N')
            frames = {}
            for frame in range(3):
                frames[f'+{frame + 1}'] = str(translate_rna[frame:].translate())
            result['translations'] = frames

    if seq_type == 'protein':
        result['seq_type'] = 'protein'
        try:
            result['molecular_weight'] = round(molecular_weight(s, seq_type='protein'), 2)
        except ValueError:
            # 蛋白序列含 X（未知氨基酸，如重组蛋白 N 端 X 标记）时 molecular_weight
            # 会抛 ValueError——降级为 None，避免整个分析失败
            result['molecular_weight'] = None
        # 氨基酸组成
        from collections import Counter
        result['aa_composition'] = dict(Counter(sequence.upper()))

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
    from Bio.Restriction import RestrictionBatch, AllEnzymes, CommOnly
    from Bio.Seq import Seq

    sequence = args['sequence']
    enzymes = args.get('enzymes', None)  # 如 ["EcoRI", "BamHI"]，None = 全部
    enzyme_set = args.get('enzyme_set', 'commonly')  # commonly(商业常用) | all(含虚构)
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
        # 不指定 → 默认分析商业常用酶（CommOnly ~700 种）；enzyme_set=all 时用全量 AllEnzymes
        batch = RestrictionBatch(first=CommOnly if enzyme_set == 'commonly' else AllEnzymes)

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
    # 编码容错：先读原始字节，再尝试 UTF-8 解码，失败回退 GBK（中文 Windows 常见）。
    # 注意：open(encoding=...) 是惰性的，UnicodeDecodeError 在迭代时才抛，所以必须显式 decode。
    import io
    raw = open(path, 'rb').read()
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        text = raw.decode('gbk', errors='replace')
    handle = io.StringIO(text)
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
    Entrez = _entrez()
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
    if ids and db in ('nucleotide', 'protein', 'gene'):
        try:
            shandle = Entrez.esummary(db=db, id=','.join(ids))
            records = Entrez.read(shandle)
            shandle.close()
            if db == 'gene':
                # gene esummary 解析结果包了 DocumentSummarySet → DocumentSummary 两层
                # （与 nucleotide/protein 直接返回 ListElement 不同）
                ds = records.get('DocumentSummarySet', {}) if isinstance(records, dict) else {}
                items = ds.get('DocumentSummary', []) if isinstance(ds, dict) else []
                if isinstance(items, dict):
                    items = [items]
                # gene docsum 不含 UID 字段，用 esearch 的 IdList 按序回填
                for uid, r in zip(ids, items):
                    ginfo = (r.get('GenomicInfo') or [{}])[0] if r.get('GenomicInfo') else {}
                    summaries.append({
                        'id': uid,
                        'name': r.get('Name', ''),
                        'description': r.get('Description', ''),
                        'chromosome': r.get('Chromosome', ''),
                        'map_location': r.get('MapLocation', ''),
                        'chr_start': ginfo.get('ChrStart', ''),
                        'chr_stop': ginfo.get('ChrStop', ''),
                        'aliases': r.get('OtherAliases', ''),
                        'summary': (r.get('Summary', '') or '')[:300],
                    })
            else:
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
    Entrez = _entrez()
    from Bio import SeqIO
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


def op_enrichr(args):
    """Enrichr 通路/功能富集分析（maayanlab REST，两步：addList → enrich）。

    零新增依赖：urllib 标准库即可。生物背景：给定基因符号列表，
    返回其在 GO/KEGG/Reactome 等库中的显著富集条目（p 值、基因重叠）。
    """
    import json
    import urllib.parse
    import urllib.request

    genes = args['genes']
    if not isinstance(genes, list) or not genes:
        raise ValueError('genes must be a non-empty list of gene symbols')
    library = args.get('library', 'GO_Biological_Process_2023')
    top = int(args.get('top', 10))

    def _multipart_post(url, fields, timeout):
        # Enrichr addList 官方 API 用 multipart/form-data（requests files= 参数），
        # JSON POST 会被 400 拒绝。stdlib 手工构造 multipart 体。
        from uuid import uuid4
        boundary = '----dshbio' + uuid4().hex
        body = b''
        for name, value in fields.items():
            body += (f'--{boundary}\r\n'
                     f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                     f'{value}\r\n').encode('utf-8')
        body += f'--{boundary}--\r\n'.encode('utf-8')
        req = urllib.request.Request(
            url, data=body, method='POST',
            headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode('utf-8'))

    # 1) 提交基因列表，换 userListId
    res = _multipart_post('https://maayanlab.cloud/Enrichr/addList',
                          {'list': '\n'.join(str(g).strip() for g in genes if str(g).strip()),
                           'description': 'dsh-bio-genie enrichment'},
                          timeout=30)
    user_list_id = res.get('userListId')
    if not user_list_id:
        raise ValueError(f'Enrichr addList 失败: {res}')

    # 2) 拉取富集结果。响应形如 {<library>: [[rank, term, p, z, combined, genes, adj_p], ...]}
    url = ('https://maayanlab.cloud/Enrichr/enrich'
           f'?userListId={user_list_id}&backgroundType={urllib.parse.quote(library)}')
    with urllib.request.urlopen(url, timeout=60) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    terms = data.get(library, [])

    results = []
    for t in terms[:top]:
        if not isinstance(t, (list, tuple)) or len(t) < 7:
            continue
        results.append({
            'rank': t[0],
            'term': t[1],
            'p_value': t[2],
            'odds_ratio': t[3],
            'combined_score': t[4],
            'overlap_genes': t[5],
            'overlap_count': len(t[5]) if isinstance(t[5], list) else None,
            'adjusted_p_value': t[6],
        })
    return {
        'library': library,
        'gene_count': len(genes),
        'total_terms': len(terms),
        'top': top,
        'results': results,
    }


def op_pubmed_search(args):
    """PubMed 检索：esearch + esummary，返回 PMID/标题/年份/期刊/作者/DOI。"""
    Entrez = _entrez()
    term = args['term']
    retmax = args.get('retmax', 10)
    email = args.get('email', None)
    if email:
        Entrez.email = email
    handle = Entrez.esearch(db='pubmed', term=term, retmax=retmax)
    search = Entrez.read(handle)
    handle.close()
    ids = search.get('IdList', [])
    results = []
    if ids:
        try:
            shandle = Entrez.esummary(db='pubmed', id=','.join(ids))
            records = Entrez.read(shandle)
            shandle.close()
            for r in records:
                article_ids = r.get('ArticleIds') or {}
                results.append({
                    'pmid': r.get('Id', ''),
                    'title': r.get('Title', ''),
                    'journal': r.get('FullJournalName', ''),
                    'date': r.get('PubDate', ''),
                    'authors': r.get('AuthorList', [])[:10],
                    'doi': article_ids.get('doi', ''),
                    'has_abstract': r.get('HasAbstract', 0),
                })
        except Exception as e:
            results = [{'pmid': i, 'note': f'summary fetch failed: {e}'} for i in ids]
    return {'db': 'pubmed', 'count': int(search.get('Count', 0)), 'pmids': ids, 'results': results}


def _pubmed_abstract_text(ab):
    """AbstractText 可能是 str / str 列表 / 分节 dict 列表（Label + #text）。"""
    if not isinstance(ab, dict):
        return str(ab or '')
    t = ab.get('AbstractText', '')
    if isinstance(t, str):
        return t
    if isinstance(t, list):
        parts = []
        for seg in t:
            if isinstance(seg, str):
                parts.append(seg)
            elif isinstance(seg, dict):
                label = seg.get('Label', '')
                txt = seg.get('#text', '')
                parts.append(f'[{label}] {txt}' if label else str(txt))
        return '\n'.join(p for p in parts if p)
    return str(t)


def op_pubmed_abstract(args):
    """按 PMID 取结构化摘要：标题/摘要/作者/期刊/日期/DOI。

    rettype=medline retmode=xml（text 模式是纯文本无法解析；Entrez.read 解析
    PubmedArticleSet）。走 Entrez.parse 会因根节点不是列表报错，故用 read。
    """
    import io
    Entrez = _entrez()
    ids = args['ids']
    if not isinstance(ids, list) or not ids:
        raise ValueError('ids must be a non-empty list of PMIDs')
    email = args.get('email', None)
    if email:
        Entrez.email = email
    handle = Entrez.efetch(db='pubmed', id=','.join(str(i) for i in ids),
                           rettype='medline', retmode='xml')
    data = handle.read()
    handle.close()
    parsed = Entrez.read(io.BytesIO(data))
    articles = parsed.get('PubmedArticle', [])
    if isinstance(articles, dict):
        articles = [articles]

    results = []
    for a in articles:
        med = a.get('MedlineCitation', {})
        art = med.get('Article', {})
        journal = art.get('Journal', {})
        pubdate = (journal.get('JournalIssue') or {}).get('PubDate', {})
        date = pubdate.get('Year', '')
        if pubdate.get('Month'):
            date = f"{date} {pubdate['Month']}"
        authors = []
        for au in art.get('AuthorList', []) or []:
            if isinstance(au, dict) and au.get('CollectiveName'):
                authors.append(au['CollectiveName'])
            elif isinstance(au, dict):
                authors.append(f"{au.get('LastName', '')} {au.get('ForeName', '')}".strip())
        # DOI：medline XML 的 ELocationID 是裸值（属性 EIdType='doi'），
        # 与 esummary 的 'doi: xxxx' 字符串形式不同，需按属性判断
        doi = ''
        eloc = art.get('ELocationID', '')
        if isinstance(eloc, list):
            for x in eloc:
                attrs = getattr(x, 'attributes', {}) or {}
                if attrs.get('EIdType') == 'doi' or str(x).startswith('doi'):
                    doi = str(x).replace('doi:', '').strip()
                    break
        elif eloc:
            doi = str(eloc).replace('doi:', '').strip()
        results.append({
            'pmid': med.get('PMID', ''),
            'title': art.get('ArticleTitle', ''),
            'abstract': _pubmed_abstract_text(art.get('Abstract')),
            'authors': authors,
            'journal': journal.get('Title', ''),
            'date': date,
            'doi': doi,
        })
    return {'db': 'pubmed', 'count': len(results), 'results': results}


def op_ref_genome(args):
    """参考基因组 assembly 信息（Ensembl REST）。

    Ensembl 要求显式 User-Agent 头（默认 urllib UA 会被 429 拒绝）。
    主站失败自动切 asia.ensembl.org 镜像。
    """
    import json
    import urllib.request

    SPECIES_ALIAS = {
        'human': 'homo_sapiens',
        'mouse': 'mus_musculus',
        'rat': 'rattus_norvegicus',
        'zebrafish': 'danio_rerio',
        'fly': 'drosophila_melanogaster',
        'drosophila': 'drosophila_melanogaster',
        'worm': 'caenorhabditis_elegans',
        'c.elegans': 'caenorhabditis_elegans',
        'arabidopsis': 'arabidopsis_thaliana',
        'rice': 'oryza_sativa',
        'yeast': 'saccharomyces_cerevisiae',
        'ecoli': 'escherichia_coli',
    }
    species = args['species'].strip().lower()
    species = SPECIES_ALIAS.get(species, species)

    headers = {'User-Agent': 'dsh-bio-genie/0.1.4'}
    url = f'https://rest.ensembl.org/info/assembly/{species}?content-type=application/json'
    # 网络策略（WB 审查发现）：部分代理环境对 rest.ensembl.org 超时/404，
    # 直连稳定。因此直连优先，失败回退系统代理。
    # 注意：只有 rest.ensembl.org 一个 host —— asia.ensembl.org 是网页门户
    # 而非 REST API，/info/assembly/ 路径必然 404，不可作 fallback。
    openers = (
        ('direct', urllib.request.build_opener(urllib.request.ProxyHandler({}))),
        ('proxy', urllib.request.build_opener()),
    )
    last_err = None
    for label, opener in openers:
        try:
            req = urllib.request.Request(url, headers=headers)
            with opener.open(req, timeout=15 if label == 'direct' else 30) as resp:
                d = json.loads(resp.read().decode('utf-8'))
            # 目录名首字母大写（Homo_sapiens）
            sdir = species[0].upper() + species[1:]
            # top_level_region 含数百条 scaffold，压缩为染色体列表 + scaffold 计数
            regions = d.get('top_level_region', [])
            chromosomes = [r for r in regions if r.get('coord_system') == 'chromosome']
            chromosomes.sort(key=lambda r: (int(r['name']), 0) if str(r.get('name', '')).isdigit() else (99, str(r.get('name', ''))))
            return {
                'species': species,
                'assembly_name': d.get('assembly_name', ''),
                'assembly_accession': d.get('assembly_accession', ''),
                'assembly_date': d.get('assembly_date', ''),
                'karyotype': d.get('karyotype', ''),
                'chromosomes': [
                    {'name': c.get('name'), 'length': c.get('length')} for c in chromosomes
                ],
                'scaffold_count': len(regions) - len(chromosomes),
                'download_urls': {
                    'fasta_dir': f'https://ftp.ensembl.org/pub/current_fasta/{sdir}/dna/',
                    'gtf_dir': f'https://ftp.ensembl.org/pub/current_gtf/{sdir}/',
                },
            }
        except Exception as e:
            last_err = e
    raise RuntimeError(
        f'Ensembl assembly 查询失败（{species}）: {last_err}。'
        'rest.ensembl.org 直连与系统代理均不可用；'
        '代理环境可尝试设置 NO_PROXY=rest.ensembl.org 后重试。')


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


# ---- 出版级绘图（figurelib）----

def _to_jsonable(obj):
    """递归把 numpy 标量/数组转成原生 JSON 类型（fig_profile 报告含 numpy 值）。"""
    import numpy as np
    if isinstance(obj, dict):
        return {k: _to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_jsonable(v) for v in obj]
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.ndarray):
        return _to_jsonable(obj.tolist())
    return obj


def op_fig_profile(args):
    """数据剖析 + 图型建议：CSV/TSV/Excel → 列类型/样本量/分布/异常/相关 + 建议。

    对应 scipilot「思考-绘制」工作流的第 1 步。相对路径基于工作区。
    """
    from figurelib.profile_data import profile_data
    path = args.get('path')
    if not path:
        raise ValueError('path is required (CSV/TSV/Excel 文件路径)')
    group_cols = args.get('group_cols') or []
    info = profile_data(path, group_cols=group_cols)
    return _to_jsonable(info)


def op_fig_export(args):
    """图文件合规审计 + 可选 PNG 预览：格式/DPI/尺寸/字体嵌入检查。

    对应 scipilot 工作流的第 7 步（投稿前机器审计）。对已落盘的 PDF/SVG/
    PNG/TIFF 文件逐张检查：JPEG 数据图、DPI 不足、尺寸偏离目标、PDF 含
    Type 3 字体等。preview=true 时额外渲染 PNG 预览（PDF 需要 pypdf/
    PyMuPDF 支持）。相对路径基于工作区。
    """
    import os
    from figurelib.check_figure import check_figure
    from figurelib.visual_qa import render_preview

    paths = args.get('paths')
    if not isinstance(paths, list) or not paths:
        raise ValueError('paths must be a non-empty list of figure file paths')
    min_dpi = args.get('min_dpi', 300)
    width_in = args.get('width_in')
    height_in = args.get('height_in')
    target = None
    if width_in and height_in:
        target = (float(width_in), float(height_in))
    preview = bool(args.get('preview', False))

    results = []
    for p in paths:
        issues, info = check_figure(p, min_dpi=min_dpi, target_inches=target)
        sev = {'INFO': 0, 'WARN': 1, 'FAIL': 2}
        verdict = 'PASS' if not issues else {0: 'INFO', 1: 'WARN', 2: 'FAIL'}[max(sev[s] for s, _ in issues)]
        entry = {
            'path': p,
            'verdict': verdict,
            'issues': [{'severity': s, 'message': m} for s, m in issues],
            'info': _to_jsonable(info),
        }
        if preview:
            try:
                out = os.path.splitext(os.path.abspath(p))[0] + '_preview.png'
                entry['preview_png'] = render_preview(p, out)
            except Exception as e:  # PDF 缺 pypdf/PyMuPDF 等：审计不受影响
                entry['preview_error'] = f'{type(e).__name__}: {e}'
        results.append(entry)
    return {'count': len(results), 'results': results}


def op_metabolic_model(args):
    """代谢模型管理：加载、查看、列出可用模型。"""
    import cobra
    
    action = args.get('action', 'list')
    
    if action == 'list':
        # 列出可用模型
        model_dir = os.path.join(os.path.dirname(__file__), '..', 'data', 'models')
        if not os.path.exists(model_dir):
            os.makedirs(model_dir, exist_ok=True)
        
        models = [
            {'id': 'textbook', 'file': 'COBRApy built-in', 'description': 'E. coli core model (built-in)'},
        ]
        
        for f in os.listdir(model_dir):
            if f.endswith(('.xml', '.sbml', '.json')):
                model_path = os.path.join(model_dir, f)
                models.append({
                    'id': os.path.splitext(f)[0],
                    'file': f,
                    'path': model_path,
                    'size_kb': round(os.path.getsize(model_path) / 1024, 1)
                })
        return {'models': models}
    
    elif action == 'load':
        model_id = args.get('model_id', 'textbook')
        file_path = args.get('file_path')
        
        if file_path:
            if not os.path.exists(file_path):
                return {'error': f'Model file not found: {file_path}'}
            model = cobra.io.read_sbml_model(file_path)
        elif model_id == 'textbook' or model_id == 'e_coli_core':
            # 使用COBRApy自带的模型
            model = cobra.io.load_model('textbook')
        else:
            # 从默认目录加载
            model_dir = os.path.join(os.path.dirname(__file__), '..', 'data', 'models')
            model_path = os.path.join(model_dir, f'{model_id}.xml')
            if not os.path.exists(model_path):
                return {'error': f'Model not found: {model_id}.xml in {model_dir}'}
            model = cobra.io.read_sbml_model(model_path)
        
        # 返回模型信息
        return {
            'id': model.id,
            'name': model.name,
            'reactions': len(model.reactions),
            'metabolites': len(model.metabolites),
            'genes': len(model.genes),
            'objective': str(model.objective),
            'compartments': model.compartments,
            'exchanges': len(model.exchanges),
        }
    
    elif action == 'info':
        model_id = args.get('model_id', 'textbook')
        
        if model_id == 'textbook' or model_id == 'e_coli_core':
            # 使用COBRApy自带的模型
            model = cobra.io.load_model('textbook')
        else:
            model_dir = os.path.join(os.path.dirname(__file__), '..', 'data', 'models')
            model_path = os.path.join(model_dir, f'{model_id}.xml')
            
            if not os.path.exists(model_path):
                return {'error': f'Model not found: {model_id}.xml'}
            
            model = cobra.io.read_sbml_model(model_path)
        
        # 获取反应信息
        reactions = []
        for r in model.reactions:
            reactions.append({
                'id': r.id,
                'name': r.name,
                'reaction': r.reaction,
                'bounds': r.bounds,
            })
        
        # 获取代谢物信息
        metabolites = []
        for m in model.metabolites:
            metabolites.append({
                'id': m.id,
                'name': m.name,
                'formula': m.formula,
                'compartment': m.compartment,
            })
        
        return {
            'id': model.id,
            'name': model.name,
            'reactions': reactions,
            'metabolites': metabolites,
            'genes': [g.id for g in model.genes],
            'objective': str(model.objective),
        }
    
    else:
        return {'error': f'Unknown action: {action}'}


def op_fba(args):
    """通量平衡分析（FBA）：预测代谢通量分布。"""
    import cobra
    
    model_id = args.get('model_id', 'ecoli_core_model')
    objective = args.get('objective')
    
    # 加载模型
    if model_id == 'textbook' or model_id == 'e_coli_core':
        # 使用COBRApy自带的模型
        model = cobra.io.load_model('textbook')
    else:
        model_dir = os.path.join(os.path.dirname(__file__), '..', 'data', 'models')
        model_path = os.path.join(model_dir, f'{model_id}.xml')
        
        if not os.path.exists(model_path):
            return {'error': f'Model not found: {model_id}.xml'}
        
        model = cobra.io.read_sbml_model(model_path)
    
    # 设置目标函数
    if objective:
        if objective in model.reactions:
            model.objective = objective
        else:
            return {'error': f'Objective reaction not found: {objective}'}
    
    # 运行FBA
    solution = model.optimize()
    
    if solution.status != 'optimal':
        return {'error': f'FBA failed: {solution.status}'}
    
    # 收集结果
    fluxes = {}
    for r in model.reactions:
        flux = solution.fluxes[r.id]
        if abs(flux) > 1e-10:  # 只返回非零通量
            fluxes[r.id] = round(flux, 6)
    
    # 影子价格（代谢物）
    shadow_prices = {}
    for m in model.metabolites:
        price = solution.shadow_prices[m.id]
        if abs(price) > 1e-10:
            shadow_prices[m.id] = round(price, 6)
    
    return {
        'objective_value': round(solution.objective_value, 6),
        'status': solution.status,
        'fluxes': fluxes,
        'shadow_prices': shadow_prices,
        'model_id': model_id,
        'objective': str(model.objective),
    }


def op_gene_knockout(args):
    """基因敲除分析：预测基因敲除对生长的影响。"""
    import cobra
    
    model_id = args.get('model_id', 'ecoli_core_model')
    gene = args.get('gene')
    
    if not gene:
        return {'error': 'Gene ID required'}
    
    # 加载模型
    if model_id == 'textbook' or model_id == 'e_coli_core':
        # 使用COBRApy自带的模型
        model = cobra.io.load_model('textbook')
    else:
        model_dir = os.path.join(os.path.dirname(__file__), '..', 'data', 'models')
        model_path = os.path.join(model_dir, f'{model_id}.xml')
        
        if not os.path.exists(model_path):
            return {'error': f'Model not found: {model_id}.xml'}
        
        model = cobra.io.read_sbml_model(model_path)
    
    # 检查基因是否存在
    gene_obj = model.genes.get_by_id(gene)
    if not gene_obj:
        return {'error': f'Gene not found: {gene}'}
    
    # 野生型FBA
    wt_solution = model.optimize()
    wt_growth = wt_solution.objective_value
    
    # 基因敲除
    with model:
        gene_obj.knock_out()
        ko_solution = model.optimize()
        ko_growth = ko_solution.objective_value
    
    # 计算影响
    growth_change = ko_growth - wt_growth
    growth_percent = (growth_change / wt_growth * 100) if wt_growth > 0 else 0
    
    # 判断必需性
    is_essential = ko_growth < 1e-6  # 生长率接近0
    
    return {
        'gene': gene,
        'gene_name': gene_obj.name,
        'model_id': model_id,
        'wild_type_growth': round(wt_growth, 6),
        'knockout_growth': round(ko_growth, 6),
        'growth_change': round(growth_change, 6),
        'growth_change_percent': round(growth_percent, 2),
        'is_essential': is_essential,
        'essentiality': 'essential' if is_essential else ('reduced' if growth_percent < -10 else 'non-essential'),
    }


def op_pathway_search(args):
    """代谢通路搜索：在KEGG数据库中搜索代谢通路。"""
    from kegg_client import search_pathways
    
    target_metabolite = args.get('target_metabolite')
    organism = args.get('organism', 'eco')
    limit = args.get('limit', 10)
    
    if not target_metabolite:
        return {'error': 'Target metabolite required'}
    
    pathways = search_pathways(target_metabolite, organism, limit)
    
    return {
        'target_metabolite': target_metabolite,
        'organism': organism,
        'pathways': pathways,
        'count': len(pathways),
    }


def op_pathway_design(args):
    """代谢通路设计：设计异源代谢通路。"""
    from kegg_client import design_pathway
    
    target_product = args.get('target_product')
    host_organism = args.get('host_organism', 'eco')
    strategy = args.get('strategy', 'shortest')
    
    if not target_product:
        return {'error': 'Target product required'}
    
    result = design_pathway(target_product, host_organism, strategy)
    
    return result


def op_fig_qa(args):
    """绘图环境自检：CJK 字体可用性 + 期刊预设应用测试。

    中文图出方框的根因是默认字体无 CJK 字符表。本 op 在画图前探测：
    cjk_ready=false 时画中文图必然方框——应改用英文标签或提示安装
    Noto Sans CJK。preset_test 验证期刊预设可应用（含中文模式字体配置）。
    """
    import matplotlib
    from figurelib.setup_style import list_cjk_fonts, setup_style

    lang = args.get('lang', 'zh')
    journal = args.get('journal', 'nature')
    cjk = list_cjk_fonts()
    preset_ok = True
    applied = None
    error = None
    try:
        applied = setup_style(journal=journal, lang=lang)
    except Exception as e:
        preset_ok = False
        error = f'{type(e).__name__}: {e}'
    return {
        'matplotlib': matplotlib.__version__,
        'cjk_fonts': cjk,
        'cjk_ready': len(cjk) > 0,
        'preset_test': {
            'journal': journal,
            'lang': lang,
            'ok': preset_ok,
            'applied': _to_jsonable(applied) if applied else None,
            'error': error,
        },
        'hint': ('中文图可正常渲染。' if cjk else
                 '本机未检测到 CJK 字体——中文标签会渲染成方框。改用英文标签，'
                 '或安装 Noto Sans CJK（见 bio-figure skill）。'),
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
    'enrichr': op_enrichr,
    'pubmed_search': op_pubmed_search,
    'pubmed_abstract': op_pubmed_abstract,
    'ref_genome': op_ref_genome,
    'fig_profile': op_fig_profile,
    'fig_export': op_fig_export,
    'fig_qa': op_fig_qa,
    'env_status': op_env_status,
    'metabolic_model': op_metabolic_model,
    'fba': op_fba,
    'gene_knockout': op_gene_knockout,
    'pathway_search': op_pathway_search,
    'pathway_design': op_pathway_design,
}


def main():
    try:
        # binary 读取 + 容错解码：任何输入字节都不会崩溃（与 bridge.py 一致）
        raw = sys.stdin.buffer.read().decode('utf-8', errors='replace')
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
