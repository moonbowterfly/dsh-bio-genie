"""批次 E 直测：表格/文件工具 + 域结构图 + DIAMOND 本地比对。

用插件 venv python 直跑：
    $HOME/.dsh/dsh-bio-genie/python-env/Scripts/python.exe -I test/test_batchE.py

DIAMOND 首次运行会真实自举（下载→校验→解压→冒烟）。
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'python'))

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

import ext_toolkit  # noqa: E402
import table_toolkit  # noqa: E402

TMP = tempfile.mkdtemp(prefix='be_test_')
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


print('== TMP:', TMP)

# ============================================================================
# 1) table_ops
# ============================================================================
print('[1] table_ops')
TAB = fixture('genes.tsv', (
    'gene\tchrom\tstart\tend\tscore\n'
    'g1\tchr1\t100\t200\t5.5\n'
    'g2\tchr1\t300\t450\t2.1\n'
    'g3\tchr2\t50\t120\t9.2\n'
    'g4\tchr2\t800\t900\t2.1\n'
    'g1\tchr1\t100\t200\t5.5\n'  # 重复行
))

r = table_toolkit.op_table_ops({'action': 'select', 'input': TAB, 'columns': ['gene', 'score']})
check('select 3->2 列 & 5 行', r['columns_out'] == 2 and r['rows_out'] == 5, str(r))
r = table_toolkit.op_table_ops({'action': 'filter', 'input': TAB, 'column': 'score', 'op': 'gt', 'value': 3})
check('filter score>3 -> 3 行（含重复行 g1）', r['rows_out'] == 3, str(r))
r = table_toolkit.op_table_ops({'action': 'filter', 'input': TAB, 'column': 'chrom', 'op': 'eq', 'value': 'chr2'})
check('filter chrom=chr2 -> 2 行', r['rows_out'] == 2, str(r))
r = table_toolkit.op_table_ops({'action': 'sort', 'input': TAB, 'column': 'score', 'reverse': True})
check('sort score desc 首数据行 9.2', len(r['preview']) > 1 and r['preview'][1][4] == '9.2', str(r['preview'][:2]))
r = table_toolkit.op_table_ops({'action': 'drop_dup', 'input': TAB})
check('drop_dup -> 4 行', r['rows_out'] == 4, str(r))
r = table_toolkit.op_table_ops({'action': 'head', 'input': TAB, 'n': 2})
check('head 2 -> 2 行', r['rows_out'] == 2, str(r))
r = table_toolkit.op_table_ops({'action': 'transpose', 'input': TAB})
check('transpose 6 列 x 5 行', r['columns_out'] == 6 and r['rows_out'] == 5, str(r))

TAB2 = fixture('anno.tsv', 'gene\tnote\ng1\tkinase\ng3\tphosphatase\n')
r = table_toolkit.op_table_ops({'action': 'join', 'input': TAB, 'input2': TAB2, 'key': 'gene', 'how': 'left'})
check('join left -> 5 行 & 6 列', r['rows_out'] == 5 and r['columns_out'] == 6, str(r))
try:
    table_toolkit.op_table_ops({'action': 'filter', 'input': TAB, 'column': 'nope', 'op': 'eq', 'value': 'x'})
    check('filter 未知列 fail-closed', False, 'no raise')
except ValueError as e:
    check('filter 未知列 fail-closed', '列不存在' in str(e), str(e))

# ============================================================================
# 2) file_merge_split
# ============================================================================
print('[2] file_merge_split')
FA = fixture('seqs.fa', ''.join('>s%d desc%d\nMKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQ\n' % (i, i) for i in range(7)))
r = table_toolkit.op_file_merge_split({'action': 'split_fasta', 'input': FA, 'chunk_size': 3, 'out_dir': os.path.join(TMP, 'split_f')})
check('split_fasta 7 -> 3 文件', r['n_files'] == 3 and r['n_sequences'] == 7, str(r))
parts = r['files']
r = table_toolkit.op_file_merge_split({'action': 'merge_fasta', 'inputs': [parts[0], parts[1], parts[0]], 'output_file': os.path.join(TMP, 'merged.fa')})
check('merge_fasta 无去重 -> 9', r['n_sequences_out'] == 9, str(r))
r = table_toolkit.op_file_merge_split({'action': 'merge_fasta', 'inputs': [parts[0], parts[1], parts[0]], 'dedup_id': True, 'output_file': os.path.join(TMP, 'merged_dedup.fa')})
check('merge_fasta 去重 -> 6', r['n_sequences_out'] == 6, str(r))
r = table_toolkit.op_file_merge_split({'action': 'split_table', 'input': TAB, 'rows_per_file': 2, 'out_dir': os.path.join(TMP, 'split_t')})
check('split_table 5 -> 3 文件', r['n_files'] == 3, str(r))
r = table_toolkit.op_file_merge_split({'action': 'merge_table', 'inputs': [TAB, TAB], 'output_file': os.path.join(TMP, 'merged.tsv')})
check('merge_table 6+5=11 行', r['rows_out'] == 11, str(r))

# ============================================================================
# 4) diamond（自举 + 建库 + 比对）
# ============================================================================
print('[4] diamond（首次运行将自举）')
BASE = 'MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQ'
DB = fixture('db.fa', '>target1\n%s\n>target2\nMKTAYIAKQRQISFVKSHFSRQLEERLGLIEVW\n' % BASE)
Q = fixture('query.fa', '>q1\n%s\n' % BASE)
r = ext_toolkit.op_diamond({'action': 'makedb', 'input': DB})
check('makedb 2 序列', r['n_sequences'] == 2, str(r))
check('dmnd 文件存在', os.path.isfile(r['db_file']), r['db_file'])
r = ext_toolkit.op_diamond({'action': 'blastp', 'query': Q, 'db': r['db_file']})
check('blastp 命中 target1', r['n_hits'] >= 1 and r['hits'][0]['sseqid'] == 'target1', str(r['hits'][:2]))
check('命中 pident=100', r['hits'][0]['pident'] == 100.0, str(r['hits'][0]))
FA_DB = fixture('fa_db.fa', '>x\n%s\n' % BASE)
r = ext_toolkit.op_diamond({'action': 'blastp', 'query': Q, 'db': FA_DB})
check('FASTA 库自动建库命中', r['n_hits'] >= 1 and r['hits'][0]['sseqid'] == 'x', str(r['hits'][:1]))
try:
    ext_toolkit.op_diamond({'action': 'blastp', 'query': Q, 'db': os.path.join(TMP, 'missing.dmnd')})
    check('缺库 fail-closed', False, 'no raise')
except ValueError as e:
    check('缺库 fail-closed', True)

print()
print('=' * 60)
print('PASS: %d    FAIL: %d' % (PASSES[0], len(FAILURES)))
if FAILURES:
    for f in FAILURES:
        print('  FAILED:', f)
    sys.exit(1)
print('ALL OK')
