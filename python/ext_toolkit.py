"""外部工具链包装（批次 D）：HMM 搜索 / 比对裁剪 / ML 建树。

组件：
  - hmm_search   pyhmmer（pip 依赖，EXTRA_DEPS 按需安装）：build（MSA→HMM）/ search（HMM×序列）
  - msa_trim     trimAl（二进制自举，pin v1.5.0）：automated1/gappyout/strict/gt
  - phylo_ml     IQ-TREE2（二进制自举，pin v2.4.0）：ML 建树（模型选择 + 超快自助）

pyhmmer 集成按实测坑位规避：
  - 不做多 HMM 的 hmmpress（本机 0.12.3 挂起）；直接读 .hmm 搜索
  - 返回类型统一归一化；hit.name 为 str
  - TextMSA 等长要求由 MSAFile 读取路径规避（对齐文件本就等长）
"""
import os
import re
import subprocess
import tempfile

from binary_boot import ensure_binary


# ============================================================================
# pyhmmer 适配
# ============================================================================

def _load_sequences(path):
    import pyhmmer
    alpha = pyhmmer.easel.Alphabet.amino()
    with pyhmmer.easel.SequenceFile(path, digital=True, alphabet=alpha) as sf:
        return sf.read_block(), alpha


def op_hmm_search(args):
    """HMM 建库 / 搜索（pyhmmer）。

    action=build : msa（对齐 FASTA）→ HMM 文件（.hmm）
    action=search: hmm（.hmm 文件或目录）+ sequences（FASTA）→ 命中表
    """
    try:
        import pyhmmer  # noqa: F401
    except ImportError:
        raise RuntimeError('pyhmmer 未安装（第二层依赖在工具调用路径上会自动安装；'
                           '直接经 op 通道调用时请先安装：pip install "pyhmmer>=0.12"）')
    import pyhmmer

    action = str(args.get('action') or 'search').lower()
    out_file = args.get('output_file')

    if action == 'build':
        msa_path = args.get('msa')
        if not msa_path or not os.path.isfile(msa_path):
            raise ValueError('build 需要 msa（对齐 FASTA 文件路径）')
        alpha = pyhmmer.easel.Alphabet.amino()
        with pyhmmer.easel.MSAFile(msa_path, format='afa', digital=True, alphabet=alpha) as mf:
            msa = mf.read()
        if not msa.name:
            # HMM 命名需要 MSA 名（否则 "Unable to name the HMM"）
            msa.name = os.path.splitext(os.path.basename(msa_path))[0].encode('utf-8')
        background = pyhmmer.plan7.Background(alpha)
        builder = pyhmmer.plan7.Builder(alpha)
        hmm, _profile, _opt = builder.build_msa(msa, background)
        target = out_file or (os.path.splitext(msa_path)[0] + '.hmm')
        with open(target, 'wb') as fh:
            hmm.write(fh)
        return {
            'action': 'build',
            'msa': msa_path,
            'n_sequences': len(msa.sequences),
            'alignment_length': (len(msa.sequences[0]) if len(msa.sequences) else 0),
            'hmm_name': (hmm.name or b'').decode('utf-8', 'replace') if isinstance(hmm.name, bytes) else str(hmm.name),
            'hmm_file': os.path.abspath(target),
        }

    if action == 'search':
        hmm_arg = args.get('hmm')
        seq_arg = args.get('sequences')
        if not hmm_arg or not seq_arg:
            raise ValueError('search 需要 hmm（.hmm 文件或包含 .hmm 的目录）与 sequences（FASTA 文件）')
        if not os.path.isfile(seq_arg):
            raise ValueError('sequences 需为 FASTA 文件路径：%s' % seq_arg)
        hmm_paths = []
        if os.path.isdir(hmm_arg):
            for root, _dirs, files in os.walk(hmm_arg):
                for f in sorted(files):
                    if f.lower().endswith('.hmm'):
                        hmm_paths.append(os.path.join(root, f))
            if not hmm_paths:
                raise ValueError('目录中没有 .hmm 文件：%s' % hmm_arg)
        elif os.path.isfile(hmm_arg):
            hmm_paths = [hmm_arg]
        else:
            raise ValueError('hmm 路径不存在：%s' % hmm_arg)

        e_max = float(args.get('e_value_max') or 0.01)
        top = int(args.get('top') or 50)
        seqs, alpha = _load_sequences(seq_arg)

        results = []
        for hp in hmm_paths[: int(args.get('max_hmms') or 500)]:
            with pyhmmer.plan7.HMMFile(hp) as hf:
                for hmm in hf:
                    hits_iter = pyhmmer.hmmer.hmmsearch(hmm, seqs)
                    for hits in hits_iter:
                        hname = hmm.name.decode('utf-8', 'replace') if isinstance(hmm.name, bytes) else str(hmm.name)
                        for hit in hits:
                            ev = float(hit.evalue)
                            if ev <= e_max:
                                d = hit.description or b''
                                results.append({
                                    'hmm': hname,
                                    'target': str(hit.name),
                                    'evalue': ev,
                                    'score': float(hit.score),
                                    'bias': float(hit.bias),
                                    'description': d.decode('utf-8', 'replace') if isinstance(d, bytes) else str(d),
                                    'hmm_file': os.path.basename(hp),
                                })
        results.sort(key=lambda r: r['evalue'])
        results = results[:top]
        return {
            'action': 'search',
            'n_hmms_searched': len(hmm_paths),
            'n_sequences': len(seqs),
            'e_value_max': e_max,
            'n_hits': len(results),
            'hits': results,
            'engine': 'pyhmmer (HMMER)',
        }

    raise ValueError("action 仅支持 build / search，收到：%s" % action)


# ============================================================================
# trimAl
# ============================================================================

def _aln_stats(path):
    """对齐文件统计（列数/序列数）——用于裁剪前后对比。"""
    nseq = 0
    width = None
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        cur_len = 0
        for ln in fh:
            ln = ln.rstrip('\r\n')
            if ln.startswith('>'):
                if width is None:
                    width = 0
                nseq += 1
                cur_len = 0
            else:
                cur_len += len(ln)
                if width is not None:
                    width = max(width, cur_len)
    return nseq, (width or 0)


def op_msa_trim(args):
    """比对裁剪（trimAl）：automated1 / gappyout / strict / gt 阈值。"""
    src = args.get('input')
    if not src or not os.path.isfile(src):
        raise ValueError('input 需要对齐文件路径（FASTA 格式）；收到：%s' % src)

    method = str(args.get('method') or 'automated1').lower()
    info = ensure_binary('trimal')
    exe = info['path']

    flags = []
    if method == 'automated1':
        flags = ['-automated1']
    elif method == 'gappyout':
        flags = ['-gappyout']
    elif method == 'strict':
        flags = ['-strict']
    elif method == 'gt':
        gt = args.get('gt')
        if gt is None:
            raise ValueError('method=gt 需要 gt 参数（0-1 之间的最小列占位比例）')
        flags = ['-gt', str(float(gt))]
    else:
        raise ValueError("method 仅支持 automated1 / gappyout / strict / gt")

    out_file = args.get('output_file') or (os.path.splitext(src)[0] + '.trimmed.fa')
    n_before, cols_before = _aln_stats(src)
    cmd = [exe, '-in', os.path.abspath(src), '-out', os.path.abspath(out_file)] + flags
    proc = subprocess.run(cmd, capture_output=True, timeout=int(args.get('timeout_s') or 600))
    if proc.returncode != 0:
        err = ((proc.stdout or b'') + (proc.stderr or b'')).decode('utf-8', 'replace')
        raise RuntimeError('trimAl 运行失败（rc=%d）：%s' % (proc.returncode, err.strip()[:400]))
    if not os.path.isfile(out_file):
        raise RuntimeError('trimAl 未产出输出文件：%s' % out_file)
    n_after, cols_after = _aln_stats(out_file)
    return {
        'method': method,
        'sequences': n_after,
        'columns_before': cols_before,
        'columns_after': cols_after,
        'columns_removed': cols_before - cols_after,
        'output_file': os.path.abspath(out_file),
        'binary': {'path': exe, 'source': info['source'], 'version': info['version']},
        'engine': 'trimAl',
    }


# ============================================================================
# IQ-TREE2（ML 建树）
# ============================================================================

def op_phylo_ml(args):
    """ML 系统发育树（IQ-TREE2）：模型选择（MFP）+ 超快自助（-B）。"""
    aln = args.get('alignment_file')
    aln_content = args.get('alignment')
    if not aln and not aln_content:
        raise ValueError('需要 alignment_file（对齐文件路径）或 alignment（对齐内容）')

    model = str(args.get('model') or 'MFP')
    bootstrap = int(args.get('bootstrap') if args.get('bootstrap') is not None else 1000)
    threads = str(args.get('threads') or 'AUTO')
    seed = args.get('seed')

    info = ensure_binary('iqtree2')
    exe = info['path']

    with tempfile.TemporaryDirectory(prefix='iqtree_') as tmp:
        if aln and os.path.isfile(aln):
            aln_path = os.path.abspath(aln)
        else:
            aln_path = os.path.join(tmp, 'input.fa')
            with open(aln_path, 'w', encoding='utf-8', newline='\n') as fh:
                fh.write(aln_content)
        prefix = os.path.abspath(args.get('output_prefix') or (os.path.splitext(aln_path)[0] + '.iqtree'))
        cmd = [exe, '-s', aln_path, '-m', model, '-T', threads, '--prefix', prefix, '--redo', '-quiet']
        if bootstrap > 0:
            cmd += ['-B', str(bootstrap)]
        if seed is not None:
            cmd += ['-seed', str(int(seed))]
        proc = subprocess.run(cmd, capture_output=True, timeout=int(args.get('timeout_s') or 1800))
        log = ((proc.stdout or b'') + (proc.stderr or b'')).decode('utf-8', 'replace')
        treefile = prefix + '.treefile'
        if proc.returncode != 0 or not os.path.isfile(treefile):
            raise RuntimeError('IQ-TREE 运行失败（rc=%d）：%s' % (proc.returncode, log.strip()[-500:]))
        newick = open(treefile, 'r', encoding='utf-8').read().strip()
        report = prefix + '.iqtree'
        report_tail = ''
        report_full = ''
        if os.path.isfile(report):
            report_full = open(report, 'r', encoding='utf-8', errors='replace').read()
            report_tail = '\n'.join(report_full.splitlines()[:40])[:2500]

    # 从日志 + 报告全文里抓最佳模型（-quiet 模式下 stdout 不含模型选择细节）
    best_model = None
    m = re.search(r'Best-fit model[^:\n]*:\s*([^\s]+)', log + '\n' + report_full)
    if m:
        best_model = m.group(1)

    return {
        'method': 'ML (IQ-TREE2)',
        'n_taxa': None,
        'model_requested': model,
        'best_model': best_model,
        'bootstrap': bootstrap,
        'tree_newick': newick,
        'report_excerpt': report_tail,
        'output_prefix': prefix,
        'binary': {'path': exe, 'source': info['source'], 'version': info['version']},
    }


# ============================================================================
# DIAMOND（本地蛋白比对）
# ============================================================================

def _resolve_dmnd(prefix):
    """解析 diamond 实际生成的库文件（-d 值含/不含 .dmnd 后缀两种行为都覆盖）。"""
    cands = [prefix if prefix.lower().endswith('.dmnd') else prefix + '.dmnd',
             prefix + '.dmnd' if not prefix.lower().endswith('.dmnd') else prefix]
    for cand in cands:
        if cand.lower().endswith('.dmnd') and os.path.isfile(cand):
            return cand
    return None


def op_diamond(args):
    """本地蛋白比对（DIAMOND 引擎，二进制自举）：makedb / blastp。"""
    action = str(args.get('action') or 'blastp').lower()
    threads = str(args.get('threads') or '4')
    info = ensure_binary('diamond')
    exe = info['path']

    if action == 'makedb':
        src = args.get('input')
        if not src or not os.path.isfile(src):
            raise ValueError('makedb 需要 input（蛋白 FASTA 路径）；收到：%s' % src)
        out = args.get('output_file') or (os.path.splitext(src)[0] + '.dmnd')
        cmd = [exe, 'makedb', '--in', os.path.abspath(src), '-d', os.path.abspath(out),
               '--threads', threads]
        proc = subprocess.run(cmd, capture_output=True, timeout=int(args.get('timeout_s') or 1800))
        log = ((proc.stdout or b'') + (proc.stderr or b'')).decode('utf-8', 'replace')
        db_file = _resolve_dmnd(os.path.abspath(out))
        if proc.returncode != 0 or not db_file:
            raise RuntimeError('DIAMOND makedb 失败（rc=%d）：%s' % (proc.returncode, log.strip()[-400:]))
        m = re.search(r'Database sequences?\s+(\d+)', log)
        return {
            'action': 'makedb',
            'db_file': db_file,
            'n_sequences': int(m.group(1)) if m else None,
            'binary': {'path': exe, 'source': info['source'], 'version': info['version']},
        }

    if action == 'blastp':
        query = args.get('query')
        db = args.get('db')
        if not query or not os.path.isfile(query):
            raise ValueError('blastp 需要 query（蛋白 FASTA）；收到：%s' % query)
        if not db or not os.path.isfile(db):
            raise ValueError('blastp 需要 db（.dmnd 库或 FASTA——后者将自动建临时库）；收到：%s' % db)
        e_max = float(args.get('e_value_max') if args.get('e_value_max') is not None else 1e-5)
        topk = int(args.get('max_target_seqs') or 25)
        out = args.get('output_file') or (os.path.splitext(query)[0] + '.diamond.tsv')

        db_file = db
        if not db.lower().endswith('.dmnd'):
            temp_db = db + '.auto'
            db_file = _resolve_dmnd(temp_db)
            if not db_file:
                sub = subprocess.run([exe, 'makedb', '--in', os.path.abspath(db), '-d', os.path.abspath(temp_db),
                                      '--threads', threads], capture_output=True, timeout=1800)
                db_file = _resolve_dmnd(temp_db)
                if sub.returncode != 0 or not db_file:
                    err = ((sub.stdout or b'') + (sub.stderr or b'')).decode('utf-8', 'replace')
                    raise RuntimeError('自动建库失败：%s' % err.strip()[-300:])

        cmd = [exe, 'blastp', '-q', os.path.abspath(query), '-d', os.path.abspath(db_file),
               '-o', os.path.abspath(out), '-e', str(e_max), '-k', str(topk),
               '--threads', threads, '--outfmt', '6', 'qseqid', 'sseqid', 'pident',
               'length', 'evalue', 'bitscore', '--quiet']
        proc = subprocess.run(cmd, capture_output=True, timeout=int(args.get('timeout_s') or 1800))
        log = ((proc.stdout or b'') + (proc.stderr or b'')).decode('utf-8', 'replace')
        if proc.returncode != 0:
            raise RuntimeError('DIAMOND blastp 失败（rc=%d）：%s' % (proc.returncode, log.strip()[-400:]))
        hits = []
        if os.path.isfile(out):
            with open(out, 'r', encoding='utf-8', errors='replace') as fh:
                for ln in fh:
                    parts = ln.rstrip('\r\n').split('\t')
                    if len(parts) < 6:
                        continue
                    hits.append({
                        'qseqid': parts[0], 'sseqid': parts[1],
                        'pident': float(parts[2]), 'length': int(parts[3]),
                        'evalue': float(parts[4]), 'bitscore': float(parts[5]),
                    })
        hits.sort(key=lambda h: h['evalue'])
        return {
            'action': 'blastp',
            'query': os.path.abspath(query),
            'db_file': os.path.abspath(db_file),
            'e_value_max': e_max,
            'n_hits': len(hits),
            'hits': hits[:200],
            'output_file': os.path.abspath(out),
            'binary': {'path': exe, 'source': info['source'], 'version': info['version']},
        }

    raise ValueError('action 仅支持 makedb / blastp；收到：%s' % action)
