"""外部工具链（批次 D）—— 直测脚本

用插件 venv python 直跑：
    $HOME/.dsh/dsh-bio-genie/python-env/Scripts/python.exe -I test/test_ext_toolkit.py

覆盖：hmm build/search（pyhmmer）、msa_trim（trimAl 自举）、phylo_ml（IQ-TREE 自举）、
      二进制状态诊断。首次运行会真实下载并自举二进制（零手动安装全链验证）。
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'python'))

os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

import binary_boot  # noqa: E402
import ext_toolkit  # noqa: E402

TMP = tempfile.mkdtemp(prefix='ext_test_')
FAILURES = []
PASSES = [0]


def check(name, cond, detail=''):
    if cond:
        PASSES[0] += 1
        print('  ok  %s' % name)
    else:
        FAILURES.append('%s %s' % (name, detail))
        print('  FAIL %s %s' % (name, detail))


def fixture(name, content):
    p = os.path.join(TMP, name)
    with open(p, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(content)
    return p


BASE = 'MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQ'

def mutate(seq, pos, aa):
    return seq[:pos] + aa + seq[pos + 1:]

# 8 条近缘序列（单点突变）
variants = [
    BASE,
    mutate(BASE, 2, 'S'), mutate(BASE, 5, 'L'), mutate(BASE, 8, 'H'),
    mutate(BASE, 12, 'T'), mutate(BASE, 18, 'A'), mutate(BASE, 23, 'D'), mutate(BASE, 28, 'N'),
]
MSA = fixture('family.fa', ''.join('>s%d\n%s\n' % (i, s) for i, s in enumerate(variants)))
RANDOM_SEQ = fixture('random.fa', '>rnd\n' + 'WWWWCCCCYYYYFFFFWWWWCCCCYYYYFF\n')

print('== TMP:', TMP)

# ---- 1) HMM build ----
print('[1] hmm_search build')
r = ext_toolkit.op_hmm_search({'action': 'build', 'msa': MSA})
check('build n_sequences=8', r['n_sequences'] == 8, str(r))
check('build alignment_length=33', r['alignment_length'] == 33, str(r))
check('hmm 文件存在且非空', os.path.isfile(r['hmm_file']) and os.path.getsize(r['hmm_file']) > 100,
      r.get('hmm_file'))
HMM = r['hmm_file']

# ---- 2) HMM search ----
print('[2] hmm_search search')
r2 = ext_toolkit.op_hmm_search({'action': 'search', 'hmm': HMM, 'sequences': MSA,
                                'e_value_max': 1e-3})
check('search 有命中', r2['n_hits'] >= 8, str(r2['n_hits']))
top = r2['hits'][0]
check('top hit 显著性（evalue 很小）', top['evalue'] < 1e-5, str(top))
r3 = ext_toolkit.op_hmm_search({'action': 'search', 'hmm': HMM, 'sequences': RANDOM_SEQ,
                                'e_value_max': 1e-3})
check('随机序列不命中', r3['n_hits'] == 0, str(r3['n_hits']))

# ---- 3) trimAl（自举） ----
print('[3] msa_trim（首次运行将自举 trimAl）')
noisy = []
for i, s in enumerate(variants):
    noisy.append('>t%d\n%s%s%s\n' % (i, '-' * 10, s, '-' * 10))
NOISY = fixture('noisy.fa', ''.join(noisy))
r = ext_toolkit.op_msa_trim({'input': NOISY, 'method': 'automated1'})
check('trim 列数 53->33', r['columns_before'] == 53 and r['columns_after'] == 33, str(r))
check('trim 序列数保持 8', r['sequences'] == 8, str(r))
check('trim binary source', r['binary']['source'] in ('system', 'bootstrapped'), str(r['binary']))

# ---- 4) IQ-TREE ML（自举） ----
print('[4] phylo_ml（首次运行将自举 IQ-TREE）')
r = ext_toolkit.op_phylo_ml({'alignment_file': MSA, 'bootstrap': 1000, 'threads': '2'})
check('tree 非空 Newick', isinstance(r['tree_newick'], str) and r['tree_newick'].endswith(';'),
      str(r['tree_newick'])[:80])
n_leaves = r['tree_newick'].count('s') >= 8
check('tree 含 8 taxa 名', all(('s%d' % i) in r['tree_newick'] for i in range(8)), r['tree_newick'][:120])
check('best_model 记录', r['best_model'] is not None, str(r['best_model']))

# ---- 5) 状态诊断 ----
print('[5] binary_status')
st = binary_boot.binary_status()
check('status 覆盖 trimal/iqtree2', len(st) == 2, str(st))
for s in st:
    print('    %s: system=%s bootstrapped=%s' % (s['name'], s['system_path'], s['bootstrapped']))

print()
print('=' * 60)
print('PASS: %d    FAIL: %d' % (PASSES[0], len(FAILURES)))
if FAILURES:
    for f in FAILURES:
        print('  FAILED:', f)
    sys.exit(1)
print('ALL OK')
