"""共线性核心 —— 直测脚本（批次 C1）

用插件 venv python 直跑：
    $HOME/.dsh/dsh-bio-genie/python-env/Scripts/python.exe -I test/test_collinearity.py

覆盖：合成数据块检测（plus/minus）、输出格式逐行断言、参数联动、
      fail-closed 用例、确定性双跑。

注：更大规模的金标准逐行对拍（外部参考数据）在本地验收档执行，不随仓库附带。
"""
import os
import re
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

import collinearity as col  # noqa: E402

TMP = tempfile.mkdtemp(prefix='col_test_')
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


# ---- fixtures：x1 8 基因；y1 8 基因；单段 8 点共线（E≈1.2e-7 稳定显著）----
gff_lines = []
for i in range(1, 9):
    gff_lines.append('x1\tgA%d\t%d\t%d' % (i, i * 1000, i * 1000 + 900))
for i in range(1, 9):
    gff_lines.append('y1\tgB%d\t%d\t%d' % (i, i * 1000, i * 1000 + 900))
GFF = fixture('syn.gff', '\n'.join(gff_lines) + '\n')

bl_lines = []
for i in range(1, 9):
    bl_lines.append('gA%d\tgB%d\t95\t500\t0\t0\t1\t500\t1\t500\t1e-50\t400' % (i, i))
BLAST = fixture('syn.blast', '\n'.join(bl_lines) + '\n')

print('== TMP:', TMP)

# ---- 1) 综合运行 ----
print('[1] 综合运行（8 锚点，plus+minus）')
res = col.run_collinearity(GFF, BLAST, col.Params())
print('  blocks:', len(res['seg_list']))
for i, sf in enumerate(res['seg_list']):
    print('    #%d %s score=%.1f N=%d %s' % (i, sf['mol_pair'], sf['score'],
                                              len(sf['pids']),
                                              'plus' if sf['sameStrand'] else 'minus'))
check('blocks == 1（单段 plus）', len(res['seg_list']) == 1, str(len(res['seg_list'])))
check('genes=16', len(res['gene_map']) == 16, str(len(res['gene_map'])))
check('anchors=8', len(res['match_list']) == 8, str(len(res['match_list'])))

# ---- 2) 输出格式逐行断言 ----
print('[2] 输出格式')
out = os.path.join(TMP, 'syn.collinearity')
col.write_collinearity(res, out)
with open(out, 'r', encoding='utf-8') as fh:
    lines = fh.read().splitlines()
check('L1 参数区头', lines[0] == '############### Parameters ###############', lines[0])
check('L2 MATCH_SCORE', lines[1] == '# MATCH_SCORE: 50', lines[1])
check('L4 GAP_PENALTY', lines[3] == '# GAP_PENALTY: -1', lines[3])
check('L6 E_VALUE 格式', lines[5] == '# E_VALUE: 1e-05', lines[5])
check('L7 MAX GAPS（空格非下划线）', lines[6] == '# MAX GAPS: 25', lines[6])
check('L8 统计区头', lines[7] == '############### Statistics ###############', lines[7])
check('L9 统计行格式', re.match(r'^# Number of collinear genes: \d+, Percentage: \d+\.\d\d$', lines[8]) is not None, lines[8])
check('L10 全基因数', lines[9] == '# Number of all genes: 16', lines[9])
check('L11 分隔线 42 个 #', lines[10] == '#' * 42, '%d chars' % len(lines[10]))
blk = lines[11]
check('块头格式', re.match(r'^## Alignment 0: score=400\.0 e_value=[\d.e+-]+ N=8 x1&y1 plus$', blk) is not None, blk)
a0 = lines[12]
check('锚点行格式', a0 == '  0-  0:\tgA1\tgB1\t  1e-50', repr(a0))

# ---- 3) 参数联动（MATCH_SIZE=2 → cutoff 100）----
print('[3] 参数联动')
res2 = col.run_collinearity(GFF, BLAST, col.Params(match_size=2, match_score=10))
check('cutoff = score*size = 20', res2['params'].cutoff_score == 20, str(res2['params'].cutoff_score))
check('参数变小后块不减少', len(res2['seg_list']) >= len(res['seg_list']), '%d vs %d' % (len(res2['seg_list']), len(res['seg_list'])))

# ---- 4) fail-closed ----
print('[4] fail-closed')
dup = fixture('dup.gff', 'x1\tgA1\t100\t200\nx1\tgA1\t300\t400\n')
try:
    col.read_gff(dup)
    check('重复基因报错', False, 'no raise')
except ValueError:
    check('重复基因报错', True)
bad = fixture('bad.gff', 'x1\tgA1\n')
try:
    col.read_gff(bad)
    check('缺列报错', False, 'no raise')
except ValueError:
    check('缺列报错', True)

# ---- 5) 确定性双跑 ----
print('[5] 确定性')
out2 = os.path.join(TMP, 'syn2.collinearity')
res_b = col.run_collinearity(GFF, BLAST, col.Params())
col.write_collinearity(res_b, out2)
with open(out, 'rb') as f1, open(out2, 'rb') as f2:
    check('双跑逐字节一致', f1.read() == f2.read())

# ---- 6) E-value 量级合理性（无 gap 4 锚点）----
print('[6] E-value 数值')
sf = res['seg_list'][0]
check('e_value 数值存在且 < 1e-5', sf['e_value'] < 1e-5 and sf['e_value'] > 0,
      str(sf['e_value']))

print()
print('=' * 60)
print('PASS: %d    FAIL: %d' % (PASSES[0], len(FAILURES)))
if FAILURES:
    for f in FAILURES:
        print('  FAILED:', f)
    sys.exit(1)
print('ALL OK')
