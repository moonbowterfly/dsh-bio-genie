"""共线性可视化（synteny/circos）—— 直测脚本（批次 C4）

用插件 venv python 直跑：
    $HOME/.dsh/dsh-bio-genie/python-env/Scripts/python.exe -I test/test_plot_synteny.py

含：collinearity 解析断言、两视图产物几何验证、环图产物验证、fail-closed。
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

import plot_toolkit3 as pt3  # noqa: E402

TMP = tempfile.mkdtemp(prefix='syn_test_')
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


def png_ok(path):
    if not os.path.isfile(path) or os.path.getsize(path) < 1000:
        return False, 'missing/small'
    try:
        from PIL import Image
        import numpy as np
        im = Image.open(path)
        arr = np.asarray(im.convert('L'))
        return (im.width > 200 and im.height > 100 and float(arr.std()) > 1.0), \
               'wxh=%dx%d std=%.2f' % (im.width, im.height, float(arr.std()))
    except Exception as e:
        return False, str(e)[:80]


# ---- fixtures：两个物种 sa/sb（2 字母前缀 + 染色体号）----
gff = []
for i in range(1, 21):
    gff.append('sa1\tgA%02d\t%d\t%d' % (i, i * 100000, i * 100000 + 900))
for i in range(1, 21):
    gff.append('sa2\tgA%02d\t%d\t%d' % (i + 100, i * 100000, i * 100000 + 900))
for i in range(1, 21):
    gff.append('sb1\tgB%02d\t%d\t%d' % (i, i * 100000, i * 100000 + 900))
GFF = fixture('syn.gff', '\n'.join(gff) + '\n')

col_lines = ['############### Parameters ###############',
             '# MATCH_SCORE: 50', '# MATCH_SIZE: 5', '# GAP_PENALTY: -1',
             '# OVERLAP_WINDOW: 5', '# E_VALUE: 1e-05', '# MAX GAPS: 25',
             '############### Statistics ###############',
             '# Number of collinear genes: 40, Percentage: 66.67',
             '# Number of all genes: 60', '##########################################']
# 两个块（sa1&sb1 plus 8 锚点；sa2&sb1 minus 5 锚点）
col_lines.append('## Alignment 0: score=400.0 e_value=1.2e-20 N=8 sa1&sb1 plus')
for i in range(1, 9):
    col_lines.append('%3d-%3d:\tgA%02d\tgB%02d\t  1e-50' % (0, i - 1, i, i))
col_lines.append('## Alignment 1: score=250.0 e_value=3.4e-10 N=5 sa2&sb1 minus')
for i in range(1, 6):
    col_lines.append('%3d-%3d:\tgA%03d\tgB%02d\t  1e-40' % (1, i - 1, 100 + i, 20 - i))
COL = fixture('syn.collinearity', '\n'.join(col_lines) + '\n')

print('== TMP:', TMP)

# ---- 1) 解析 ----
print('[1] parse_collinearity')
blocks, params = pt3.parse_collinearity(COL)
check('blocks=2', len(blocks) == 2, str(len(blocks)))
check('块0 mol_pair/orient/N', blocks[0]['mol_pair'] == 'sa1&sb1' and blocks[0]['orient'] == 'plus' and blocks[0]['n'] == 8,
      str(blocks[0]))
check('块0 锚点数=8', len(blocks[0]['anchors']) == 8, str(len(blocks[0]['anchors'])))
check('块1 minus 5 锚点', blocks[1]['orient'] == 'minus' and len(blocks[1]['anchors']) == 5, str(blocks[1]))

# ---- 2) bands 视图 ----
print('[2] plot_synteny bands')
r = pt3.op_plot_synteny({'collinearity': COL, 'gff': GFF, 'view': 'bands',
                         'output_file': os.path.join(TMP, 'bands.png')})
check('species_pair = [sa, sb]', r['species_pair'] == ['sa', 'sb'], str(r['species_pair']))
check('n_blocks_drawn=2', r['n_blocks_drawn'] == 2, str(r['n_blocks_drawn']))
ok, det = png_ok(r['files'][0])
check('bands png valid', ok, det)

# ---- 3) dotplot 视图 ----
print('[3] plot_synteny dotplot')
r = pt3.op_plot_synteny({'collinearity': COL, 'gff': GFF, 'view': 'dotplot',
                         'output_file': os.path.join(TMP, 'dotplot.png')})
check('dotplot n_blocks=2', r['n_blocks_drawn'] == 2, str(r['n_blocks_drawn']))
ok, det = png_ok(r['files'][0])
check('dotplot png valid', ok, det)

# ---- 4) circos ----
print('[4] plot_circos')
r = pt3.op_plot_circos({'gff': GFF, 'window': 500000,
                        'output_file': os.path.join(TMP, 'circos.png')})
check('circos n_chroms=3', r['n_chroms'] == 3, str(r['n_chroms']))
check('circos total_bp=6000000', r['total_bp'] == 6000000, str(r['total_bp']))
ok, det = png_ok(r['files'][0])
check('circos png valid', ok, det)

# ---- 5) fail-closed ----
print('[5] fail-closed')
bad = fixture('bad.col', 'not a collinearity file\n')
try:
    pt3.parse_collinearity(bad)
    check('非格式文件报错', False, 'no raise')
except ValueError:
    check('非格式文件报错', True)
try:
    pt3.op_plot_synteny({'collinearity': COL, 'gff': GFF, 'view': 'nope',
                         'output_file': os.path.join(TMP, 'x.png')})
    check('非法 view 报错', False, 'no raise')
except ValueError:
    check('非法 view 报错', True)

print()
print('=' * 60)
print('PASS: %d    FAIL: %d' % (PASSES[0], len(FAILURES)))
if FAILURES:
    for f in FAILURES:
        print('  FAILED:', f)
    sys.exit(1)
print('ALL OK')
