"""可视化工具箱 —— 直测脚本（批次 B）

用插件 venv python 直跑：
    $HOME/.dsh/dsh-bio-genie/python-env/Scripts/python.exe -I test/test_plot_toolkit.py

覆盖：plot_gene_structure / plot_gene_locations / plot_gene_density /
      plot_heatmap / plot_venn / plot_upset / plot_enrichment / plot_domains

断言策略：产物几何验证（PIL 读 PNG 尺寸 + 非空白）+ 集合计算手算核对 +
fail-closed 用例。不依赖肉眼。
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

import plot_toolkit as pt    # noqa: E402
import plot_toolkit2 as pt2  # noqa: E402

TMP = tempfile.mkdtemp(prefix='plot_test_')
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
    """PNG 存在、可打开、尺寸合理、非纯空白。"""
    if not os.path.isfile(path) or os.path.getsize(path) < 1000:
        return False, 'missing/small'
    try:
        from PIL import Image
        import numpy as np
        im = Image.open(path)
        arr = np.asarray(im.convert('L'))
        std = float(arr.std())
        return (im.width > 200 and im.height > 100 and std > 1.0), 'wxh=%dx%d std=%.2f' % (im.width, im.height, std)
    except Exception as e:
        return False, str(e)[:80]


OUT = os.path.join(TMP, 'outs')
os.makedirs(OUT, exist_ok=True)

GFF = fixture('mini.gff3', '\n'.join([
    '##gff-version 3',
    'chr1\ttest\tgene\t1001\t2500\t.\t+\t.\tID=g1;Name=GeneA',
    'chr1\ttest\tmRNA\t1001\t2500\t.\t+\t.\tID=m1;Parent=g1',
    'chr1\ttest\texon\t1001\t1300\t.\t+\t.\tID=e1;Parent=m1',
    'chr1\ttest\texon\t1600\t1900\t.\t+\t.\tID=e2;Parent=m1',
    'chr1\ttest\texon\t2200\t2500\t.\t+\t.\tID=e3;Parent=m1',
    'chr1\ttest\tCDS\t1051\t1300\t.\t+\t0\tID=c1;Parent=m1',
    'chr1\ttest\tCDS\t1600\t1850\t.\t+\t0\tID=c2;Parent=m1',
    'chr1\ttest\tgene\t4001\t6500\t.\t-\t.\tID=g2;Name=GeneB',
    'chr1\ttest\tmRNA\t4001\t6500\t.\t-\t.\tID=m2;Parent=g2',
    'chr1\ttest\texon\t4001\t4600\t.\t-\t.\tID=e4;Parent=m2',
    'chr1\ttest\texon\t5500\t6500\t.\t-\t.\tID=e5;Parent=m2',
    'chr1\ttest\tgene\t8001\t9200\t.\t+\t.\tID=g3;Name=GeneC',
]) + '\n')

MAT = fixture('matrix.tsv', '\n'.join([
    '\tcondA\tcondB\tcondC\tcondD',
    'gene1\t10\t12\t3\t4',
    'gene2\t9\t11\t3.5\t4.2',
    'gene3\t1\t1\t8\t9',
    'gene4\t1.2\t0.9\t8.5\t9.5',
    'gene5\t5\t5\t5\t5',
]) + '\n')

# 集合：A=1..10, B=5..15, C=10..20（手算交集见断言）
GA = fixture('setA.txt', '\n'.join(str(i) for i in range(1, 11)) + '\n')
GB = fixture('setB.txt', '\n'.join(str(i) for i in range(5, 16)) + '\n')
GC = fixture('setC.txt', '\n'.join(str(i) for i in range(10, 21)) + '\n')

ENR = fixture('enrich.tsv', '\n'.join([
    'term\tp_value\tcount',
    'GO:0006412 translation\t1e-30\t120',
    'GO:0005840 ribosome\t3e-25\t88',
    'GO:0015935 small ribosomal subunit\t1e-18\t40',
    'GO:0003735 structural constituent of ribosome\t5e-15\t60',
    'GO:0022625 cytosolic large ribosomal subunit\t2e-12\t35',
    'GO:0002181 cytoplasmic translation\t8e-10\t50',
    'GO:0042254 ribosome biogenesis\t4e-5\t22',
    'GO:0006413 translational initiation\t0.002\t10',
]) + '\n')

DOM = fixture('domains.tsv', '\n'.join([
    'protein\tlength\tdomain\tstart\tend',
    'P1\t800\tKinase\t50\t250',
    'P1\t800\tSH2\t400\t480',
    'P1\t800\tSH3\t700\t780',
    'P2\t600\tKinase\t30\t230',
    'P2\t600\tPH\t300\t420',
]) + '\n')

print('== TMP:', TMP)

# ---------------------------------------------------------------- 1. gene structure
print('[1] plot_gene_structure')
r = pt.op_plot_gene_structure({'gff': GFF, 'output_file': os.path.join(OUT, 'gs.png')})
check('structure n_genes=3', r['n_genes'] == 3, str(r['n_genes']))
check('structure files>=2 (png+svg)', len(r['files']) >= 2, str(r['files']))
ok, det = png_ok(r['files'][0])
check('structure png valid', ok, det)
g1 = [g for g in r['genes'] if g['id'] == 'g1'][0]
check('g1 exons=3', g1['exons'] == 3, str(g1))

# ---------------------------------------------------------------- 2. gene locations
print('[2] plot_gene_locations')
r = pt.op_plot_gene_locations({'gff': GFF, 'ids': ['g2'],
                               'output_file': os.path.join(OUT, 'gl.png')})
check('locations genes=3', r['n_genes'] == 3, str(r['n_genes']))
check('locations highlighted=1', r['n_highlighted'] == 1, str(r['n_highlighted']))
ok, det = png_ok(r['files'][0])
check('locations png valid', ok, det)

# ---------------------------------------------------------------- 3. gene density
print('[3] plot_gene_density')
r = pt.op_plot_gene_density({'gff': GFF, 'window': 2000,
                             'output_file': os.path.join(OUT, 'gd.png')})
check('density chroms=1', len(r['chroms']) == 1, str(r['chroms']))
ok, det = png_ok(r['files'][0])
check('density png valid', ok, det)

# ---------------------------------------------------------------- 4. heatmap
print('[4] plot_heatmap')
r = pt2.op_plot_heatmap({'matrix': MAT, 'scale': 'row',
                         'output_file': os.path.join(OUT, 'hm.png')})
check('heatmap shape 5x4', r['shape'] == [5, 4], str(r['shape']))
check('heatmap clustered', r['clustered']['rows'] is False or r['clustered']['rows'] is True)
ok, det = png_ok(r['files'][0])
check('heatmap png valid', ok, det)
try:
    pt2.op_plot_heatmap({'matrix': MAT, 'cmap': 'jet', 'output_file': os.path.join(OUT, 'hm_bad.png')})
    check('heatmap rainbow raises', False, 'no raise')
except ValueError:
    check('heatmap rainbow raises', True)

# ---------------------------------------------------------------- 5. venn
print('[5] plot_venn')
r = pt2.op_plot_venn({'group_files': [GA, GB, GC], 'labels': ['A', 'B', 'C'],
                      'output_file': os.path.join(OUT, 'venn3.png')})
reg = r['regions']
check('venn A-only=4', reg['A'] == 4, str(reg))
check('venn AB=5', reg['AB'] == 5, str(reg))
check('venn AC=0', reg['AC'] == 0, str(reg))
check('venn BC=5', reg['BC'] == 5, str(reg))
check('venn ABC=1', reg['ABC'] == 1, str(reg))
ok, det = png_ok(r['files'][0])
check('venn png valid', ok, det)
try:
    pt2.op_plot_venn({'group_files': [GA, GB, GC, MAT], 'output_file': os.path.join(OUT, 'v4.png')})
    check('venn >3 raises', False, 'no raise')
except ValueError:
    check('venn >3 raises', True)

# ---------------------------------------------------------------- 6. upset
print('[6] plot_upset')
r = pt2.op_plot_upset({'group_files': [GA, GB, GC], 'labels': ['A', 'B', 'C'],
                       'output_file': os.path.join(OUT, 'upset.png')})
tops = {(tuple(x['sets']), x['size']) for x in r['top_intersections']}
check('upset has (A,B)=5', (('A', 'B'), 5) in tops, str(tops))
check('upset has (B,C)=5', (('B', 'C'), 5) in tops, str(tops))
check('upset has (A,B,C)=1', (('A', 'B', 'C'), 1) in tops, str(tops))
ok, det = png_ok(r['files'][0])
check('upset png valid', ok, det)

# ---------------------------------------------------------------- 7. enrichment
print('[7] plot_enrichment')
r = pt2.op_plot_enrichment({'table': ENR, 'output_file': os.path.join(OUT, 'enr.png')})
check('enrichment n_terms=8', r['n_terms'] == 8, str(r['n_terms']))
check('enrichment term col auto', r['columns']['term'] is not None and 'term' in r['columns']['term'].lower(), str(r['columns']))
ok, det = png_ok(r['files'][0])
check('enrichment png valid', ok, det)

# ---------------------------------------------------------------- 8. domains
print('[8] plot_domains')
r = pt2.op_plot_domains({'table': DOM, 'output_file': os.path.join(OUT, 'dom.png')})
check('domains n_proteins=2', r['n_proteins'] == 2, str(r['n_proteins']))
check('domains types>=4', r['n_domain_types'] >= 4, str(r['n_domain_types']))
ok, det = png_ok(r['files'][0])
check('domains png valid', ok, det)

# ---------------------------------------------------------------- summary
print()
print('=' * 60)
print('PASS: %d    FAIL: %d' % (PASSES[0], len(FAILURES)))
if FAILURES:
    for f in FAILURES:
        print('  FAILED:', f)
    sys.exit(1)
print('ALL OK')
