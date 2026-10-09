"""R2 production-op and JSON-bridge behavior counterexamples (no backend SKIP)."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python'))
from deg_tools import op_deseq2_python, op_gsea_python
from ml_tools import op_ml_pipeline

checks = 0


def check(name, condition):
    global checks
    assert condition, name
    checks += 1
    print('PASS', name)


with tempfile.TemporaryDirectory(prefix='genie-r2-') as td:
    td = Path(td)
    rng = np.random.default_rng(20261008)
    samples = [f'c{i}' for i in range(4)] + [f't{i}' for i in range(4)]
    counts = pd.DataFrame(rng.poisson(25, size=(100, 8)),
                          index=[f'g{i}' for i in range(100)], columns=samples)
    meta = pd.DataFrame({'sample': samples, 'condition': ['ctrl'] * 4 + ['trt'] * 4,
                         'type': ['A', 'B'] * 4})
    c, m = td / 'counts.csv', td / 'meta.csv'
    counts.to_csv(c)
    meta.to_csv(m, index=False)
    base = {'counts_file': str(c), 'meta_file': str(m), 'contrast': 'trt_vs_ctrl'}
    original_counts_hash = __import__('hashlib').sha256(c.read_bytes()).hexdigest()
    check('DE refuses overwriting source input', op_deseq2_python({**base, 'out_csv': str(c)}).get('code') == 'OUTPUT_CONFLICT'
          and __import__('hashlib').sha256(c.read_bytes()).hexdigest() == original_counts_hash)

    bad = counts.astype(float).copy()
    bad.iloc[0, 0] = 1000000.25
    bad.to_csv(c)
    check('large noninteger counts rejected exactly', op_deseq2_python({**base, 'backend': 'legacy_welch'}).get('code') == 'INPUT_INVALID')
    counts.to_csv(c)
    c.write_text(c.read_text(encoding='utf-8').replace(',c1,', ',c0,', 1), encoding='utf-8')
    check('physical duplicate counts header rejected', op_deseq2_python(base).get('code') == 'INPUT_READ_FAILED')
    counts.to_csv(c)
    meta_dup = meta.copy()
    meta_dup.loc[1, 'sample'] = 'c0'
    meta_dup.to_csv(m, index=False)
    check('duplicate metadata sample rejected', op_deseq2_python(base).get('code') == 'INPUT_INVALID')
    meta.to_csv(m, index=False)
    check('absent factor is structured error', op_deseq2_python({**base, 'factor': 'missing'}).get('code') == 'DESIGN_INVALID')
    check('one-sided contrast rejected', op_deseq2_python({**base, 'numerator': 'trt'}).get('code') == 'CONTRAST_INVALID')
    check('interaction unsupported explicitly', op_deseq2_python({**base, 'design': '~ type * condition'}).get('code') == 'DESIGN_INVALID')
    meta_conf = meta.copy()
    meta_conf['type'] = meta_conf['condition']
    meta_conf.to_csv(m, index=False)
    check('rank deficient design rejected', op_deseq2_python({**base, 'design': '~type + condition'}).get('code') == 'DESIGN_INVALID')
    meta.to_csv(m, index=False)
    extra = counts.copy()
    for i in range(4):
        extra[f'o{i}'] = rng.poisson(25, size=len(extra))
    extra.to_csv(c)
    meta_extra = pd.concat([meta, pd.DataFrame({'sample': [f'o{i}' for i in range(4)],
                                                 'condition': ['other'] * 4,
                                                 'type': ['A', 'B'] * 2})], ignore_index=True)
    meta_extra.to_csv(m, index=False)
    out = td / 'de-full.csv'
    formal = op_deseq2_python({**base, 'out_csv': str(out)})
    check('all matched third-level samples fitted', formal.get('n_samples') == 12
          and formal.get('method', {}).get('sample_order') == meta_extra['sample'].tolist())
    check('formal LFC unshrunken and full table hash', formal.get('method', {}).get('lfc_shrinkage', '').startswith('none')
          and formal.get('out_csv', {}).get('sha256') == __import__('hashlib').sha256(out.read_bytes()).hexdigest())
    check('DE output failure is analysis failure', op_deseq2_python({**base, 'out_csv': str(td)}).get('code') == 'OUTPUT_WRITE_FAILED')
    counts.to_csv(c)
    meta.to_csv(m, index=False)

    rank_csv, gmt, gsea_csv = td / 'rank.csv', td / 'sets.gmt', td / 'gsea.csv'
    pd.DataFrame({'gene': [f'G{i}' for i in range(100)],
                  'stat': np.arange(100., 0., -1.)}).to_csv(rank_csv, index=False)
    gmt.write_text('POS\tdesc\t' + '\t'.join(f'G{i}' for i in range(20)) + '\n', encoding='utf-8')
    g_args = {'de_results_file': str(rank_csv), 'gene_set_file': str(gmt),
              'min_size': 5, 'permutation_num': 100, 'out_csv': str(gsea_csv),
              'species': 'human', 'id_namespace': 'gene_symbol',
              'gene_set_species': 'human', 'gene_set_id_namespace': 'gene_symbol'}
    g = op_gsea_python(g_args)
    original_gmt_hash = __import__('hashlib').sha256(gmt.read_bytes()).hexdigest()
    check('GSEA refuses overwriting GMT source', op_gsea_python({**g_args, 'out_csv': str(gmt)}).get('code') == 'OUTPUT_CONFLICT'
          and __import__('hashlib').sha256(gmt.read_bytes()).hexdigest() == original_gmt_hash)
    check('GSEA full output path rows hash returned', g.get('out_csv', {}).get('path') == str(gsea_csv)
          and g.get('out_csv', {}).get('n_rows') == len(pd.read_csv(gsea_csv))
          and g.get('out_csv', {}).get('sha256') == __import__('hashlib').sha256(gsea_csv.read_bytes()).hexdigest())
    check('GMT hash and intersection recorded', g.get('method', {}).get('gmt', {}).get('byte_sha256') == __import__('hashlib').sha256(gmt.read_bytes()).hexdigest()
          and g['method']['gmt']['set_statistics']['POS']['intersection_size'] == 20)
    check('GSEA species conflict rejected', op_gsea_python({**g_args, 'gene_set_species': 'mouse'}).get('code') == 'REFERENCE_CONFLICT')
    check('GSEA invalid permutation rejected', op_gsea_python({**g_args, 'permutation_num': 1.5}).get('code') == 'PARAMETER_INVALID')
    check('GSEA output failure is analysis failure', op_gsea_python({**g_args, 'out_csv': str(td)}).get('code') == 'OUTPUT_WRITE_FAILED')
    gmt.write_text('NO\tdesc\tXYZ\tABC\n', encoding='utf-8')
    empty = op_gsea_python({**g_args, 'out_csv': str(td / 'empty.csv')})
    check('zero effective sets has new empty output', empty.get('status') == 'no_effective_sets'
          and empty.get('out_csv', {}).get('n_rows') == 0
          and (td / 'empty.csv').exists())

    ml_csv = td / 'ml.csv'
    pd.DataFrame({'x': range(20), 'target': [0] * 19 + [1]}).to_csv(ml_csv, index=False)
    ml = op_ml_pipeline({'path': str(ml_csv), 'target': 'target', 'cv': 0})
    check('singleton classification unavailable', ml.get('code') == 'EVALUATION_UNAVAILABLE')

    def bridge(op, arguments):
        run = subprocess.run([sys.executable, '-B', str(ROOT / 'python' / 'bio_ops.py')],
                             input=json.dumps({'op': op, 'args': arguments}),
                             text=True, encoding='utf-8', capture_output=True,
                             env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
        check(f'{op} bridge process exit', run.returncode == 0)
        return json.loads(run.stdout)

    b = bridge('deseq2', {**base, 'factor': 'missing'})
    check('DE bridge top-level failure', b.get('ok') is False and b.get('code') == 'DESIGN_INVALID')
    b = bridge('ml_pipeline', {'path': str(ml_csv), 'target': 'target', 'cv': 0})
    check('ML bridge top-level failure', b.get('ok') is False and b.get('code') == 'EVALUATION_UNAVAILABLE')
    b = bridge('gsea', {'de_results_file': str(rank_csv)})
    check('GSEA bridge top-level failure', b.get('ok') is False and not b.get('result'))

print(f'Genie R2 contract checks: {checks} PASS, 0 SKIP')
