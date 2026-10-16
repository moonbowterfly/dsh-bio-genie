"""序列与注释工具箱 —— 直测脚本（批次 A）

用插件 venv python 直跑：
    $HOME/.dsh/dsh-bio-genie/python-env/Scripts/python.exe -I test/test_seq_toolkit.py

覆盖：fasta_extract / fasta_stats / fasta_table / fasta_ids /
      seq_batch_translate / orf_predict / protein_params / ssr_mine /
      primer_check / gff_positions / gff_sequences / gff_ops

断言策略：fixtures 手工设计可验证；关键数值（N50/翻译/拼接）用独立构造的
期望值对照，不与被测实现共享计算路径。
"""
import os
import sys
import tempfile
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'python'))

os.environ.setdefault('PYTHONIOENCODING', 'utf-8')

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

import seq_toolkit as st          # noqa: E402
import seq_toolkit2 as st2        # noqa: E402
import gff_toolkit as gt          # noqa: E402

TMP = tempfile.mkdtemp(prefix='sxtest_')
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


# ---------------------------------------------------------------- fixtures
FA = fixture('test.fa', '\n'.join([
    '>seq1 first sequence',
    'ATGGCTAGCTAA',
    '>seq2 second',
    'ATGAAATTTGGGCCC',
    '>seq3 third',
    'ATATATATATATATATAT',
    '>seq4 longer one',
    'ACGT' * 15,
    '>seq5',
    'ATGAAACCCGGGTTTAAACCC',
]) + '\n')

DUP = fixture('dup.fa', '\n'.join([
    '>geneA.1',
    'ATGGCT',
    '>geneA.2',
    'ATGGCTAGCTAA',
    '>geneB.1',
    'ATGAAA',
]) + '\n')

SSR = fixture('ssr.fa', '\n'.join([
    '>ssr1',
    'GGG' + 'AT' * 9 + 'CCC',
    '>ssr2',
    'TTT' + 'CAG' * 7 + 'AAA',
    '>ssr3',
    'GG' + 'A' * 15 + 'TT',
    '>ssr4_none',
    'ACGTACGTACGT',
]) + '\n')

# 引物测试模板：确定性伪随机 80nt（保证 20-mer 唯一，避免重复序列歧义）
import random as _random  # noqa: E402
_rng = _random.Random(42)
TEMPLATE = ''.join(_rng.choice('ACGT') for _ in range(80))
PRIMER = fixture('primer.fa', '>tmpl1 template\n' + TEMPLATE + '\n')

CHR1 = 'ACGT' * 50
GENOME = fixture('mini.fa', '>chr1\n' + CHR1 + '\n')
GFF = fixture('mini.gff3', '\n'.join([
    '##gff-version 3',
    'chr1\ttest\tgene\t11\t60\t.\t+\t.\tID=g1',
    'chr1\ttest\tmRNA\t11\t60\t.\t+\t.\tID=m1;Parent=g1',
    'chr1\ttest\texon\t11\t30\t.\t+\t.\tID=e1;Parent=m1',
    'chr1\ttest\texon\t41\t60\t.\t+\t.\tID=e2;Parent=m1',
    'chr1\ttest\tCDS\t11\t30\t.\t+\t0\tID=c1;Parent=m1',
    'chr1\ttest\tCDS\t41\t60\t.\t+\t0\tID=c2;Parent=m1',
    'chr1\ttest\tgene\t81\t130\t.\t-\t.\tID=g2',
    'chr1\ttest\tmRNA\t81\t130\t.\t-\t.\tID=m2;Parent=g2',
    'chr1\ttest\tCDS\t81\t100\t.\t-\t0\tID=c3;Parent=m2',
    'chr1\ttest\tCDS\t111\t130\t.\t-\t0\tID=c4;Parent=m2',
]) + '\n')

OUT = os.path.join(TMP, 'outs')
os.makedirs(OUT, exist_ok=True)


def read_fasta_keys(path):
    seqs = {}
    with open(path, 'r', encoding='utf-8') as fh:
        cur = None
        for ln in fh:
            ln = ln.strip()
            if ln.startswith('>'):
                cur = ln[1:].split()[0]
                seqs[cur] = ''
            elif cur:
                seqs[cur] += ln
    return seqs


print('== TMP:', TMP)

# ---------------------------------------------------------------- 1. fasta_extract
print('[1] fasta_extract')
r = st.op_fasta_extract({'input': FA, 'ids': ['seq1', 'seq2'],
                         'output_file': os.path.join(OUT, 'ex1.fa')})
check('extract ids count=2', r['count'] == 2, str(r['count']))
got = read_fasta_keys(r['output_file'])
check('extract seq1 content', got.get('seq1') == 'ATGGCTAGCTAA', str(got.get('seq1')))
check('extract seq2 content', got.get('seq2') == 'ATGAAATTTGGGCCC', str(got.get('seq2')))

r = st.op_fasta_extract({'input': FA, 'regions': ['seq1:1-9'],
                         'output_file': os.path.join(OUT, 'ex2.fa')})
got = read_fasta_keys(r['output_file'])
sub = list(got.values())[0]
check('region extract = ATGGCTAGC', sub == 'ATGGCTAGC', sub)

r = st.op_fasta_extract({'input': FA, 'filter': {'min_len': 16},
                         'output_file': os.path.join(OUT, 'ex3.fa')})
check('filter min_len>=16 count=3', r['count'] == 3, str(r['count']))  # seq3,seq4,seq5

r = st.op_fasta_extract({'input': FA, 'ids': ['seq1', 'nope'],
                         'output_file': os.path.join(OUT, 'ex4.fa')})
check('partial missing tracked', r['missing_count'] == 1 and r['count'] == 1, str(r))

try:
    st.op_fasta_extract({'input': FA, 'ids': ['nope'],
                         'output_file': os.path.join(OUT, 'ex5.fa')})
    check('all-missing raises', False, 'no raise')
except ValueError:
    check('all-missing raises', True)

# region_table：TSV 区域表（3 列 + 4 列混合文本；文件模式）
r = st.op_fasta_extract({'input': FA, 'region_table': 'name1\tseq1\t1\t9\nseq2\t1\t12\n',
                         'output_file': os.path.join(OUT, 'ex7.fa')})
got = read_fasta_keys(r['output_file'])
check('region_table parse 2 rows', r['count'] == 2, str(r['count']))
vals = list(got.values())
check('region_table seq1:1-9', any(v == 'ATGGCTAGC' for v in vals), str(vals[:2]))
check('region_table seq2:1-12', any(v == 'ATGAAATTTGGG' for v in vals), str(vals[:2]))

rt_file = fixture('regions.tsv', 'x\tseq3\t1\t10\n')
r = st.op_fasta_extract({'input': FA, 'region_table': rt_file,
                         'output_file': os.path.join(OUT, 'ex8.fa')})
got = read_fasta_keys(r['output_file'])
check('region_table file mode', r['count'] == 1 and list(got.values())[0] == 'ATATATATAT',
      str(got))

r = st.op_fasta_extract({'input': DUP, 'longest': True,
                         'output_file': os.path.join(OUT, 'ex6.fa')})
got = read_fasta_keys(r['output_file'])
check('longest per group -> geneA.2/geneB.1', set(got.keys()) == {'geneA.2', 'geneB.1'}, str(set(got.keys())))
check('longest geneA len=12', got.get('geneA.2') == 'ATGGCTAGCTAA', str(got.get('geneA.2')))

# ---------------------------------------------------------------- 2. fasta_stats
print('[2] fasta_stats')
r = st.op_fasta_stats({'input': FA, 'write_table': False})
check('stats n=5', r['n'] == 5, str(r['n']))
check('stats total=126', r['total_bp'] == 126, str(r['total_bp']))
check('stats N50=21', r['n50'] == 21, str(r['n50']))
lens = sorted([12, 15, 18, 60, 21], reverse=True)
acc, n50 = 0, 0
for L in lens:
    acc += L
    if acc >= 126 * 0.5:
        n50 = L
        break
check('N50 cross-check', r['n50'] == n50, '%s vs %s' % (r['n50'], n50))

# ---------------------------------------------------------------- 3. fasta_table
print('[3] fasta_table')
r = st.op_fasta_table({'input': FA, 'action': 'to_table', 'include_sequence': True,
                       'output_file': os.path.join(OUT, 'tbl.tsv')})
check('to_table rows=5', r['count'] == 5, str(r['count']))
with open(r['output_file'], encoding='utf-8') as fh:
    lines = fh.read().strip().split('\n')
check('table header', lines[0].startswith('id\tdescription'), lines[0])
r2 = st.op_fasta_table({'input': r['output_file'], 'action': 'to_fasta',
                        'output_file': os.path.join(OUT, 'tbl_back.fa')})
check('roundtrip count=5', r2['count'] == 5, str(r2['count']))
back = read_fasta_keys(r2['output_file'])
orig = read_fasta_keys(FA)
check('roundtrip seq1 preserved', back.get('seq1') == orig.get('seq1'))
r3 = st.op_fasta_table({'input': FA, 'action': 'to_table',
                        'output_file': os.path.join(OUT, 'tbl_noseq.tsv')})
try:
    st.op_fasta_table({'input': r3['output_file'], 'action': 'to_fasta',
                       'output_file': os.path.join(OUT, 'bad.fa')})
    check('to_fasta without seq col raises', False, 'no raise')
except ValueError:
    check('to_fasta without seq col raises', True)

# ---------------------------------------------------------------- 4. fasta_ids
print('[4] fasta_ids')
r = st.op_fasta_ids({'input': DUP, 'action': 'simplify',
                     'output_file': os.path.join(OUT, 'ids1.fa')})
got = read_fasta_keys(r['output_file'])
check('simplify: geneA.1 -> geneA', 'geneA' in got, str(list(got.keys())))

MAP = fixture('idmap.tsv', 'geneA.1\tAGO1\ngeneA.2\tAGO2\ngeneB.1\tAGO3\n')
r = st.op_fasta_ids({'input': DUP, 'action': 'rename', 'map_file': MAP,
                     'output_file': os.path.join(OUT, 'ids2.fa')})
got = read_fasta_keys(r['output_file'])
check('rename mapped', set(got.keys()) == {'AGO1', 'AGO2', 'AGO3'}, str(list(got.keys())))

r = st.op_fasta_ids({'input': DUP, 'action': 'prefix', 'text': 'sp1_',
                     'output_file': os.path.join(OUT, 'ids3.fa')})
got = read_fasta_keys(r['output_file'])
check('prefix applied', 'sp1_geneA.1' in got, str(list(got.keys())))

# ---------------------------------------------------------------- 5. seq_batch_translate
print('[5] seq_batch_translate')
r = st2.op_seq_batch_translate({'input': FA, 'to_stop': True,
                                'output_file': os.path.join(OUT, 'pep.fa')})
seqs = read_fasta_keys(r['output_file'])
check('translate seq1 = MAS', seqs.get('seq1') == 'MAS', str(seqs.get('seq1')))
check('translate seq2 = MKFGP', seqs.get('seq2') == 'MKFGP', str(seqs.get('seq2')))

r6 = st2.op_seq_batch_translate({'input': FA, 'frame': 'all6',
                                 'output_file': os.path.join(OUT, 'pep6.fa')})
seqs6 = read_fasta_keys(r6['output_file'])
check('all6 emits 30 records (5x6)', r6['count_out'] == 30, str(r6['count_out']))
check('all6 has frame+1', 'seq1|frame+1' in seqs6, str([k for k in seqs6 if 'seq1' in k]))

# ---------------------------------------------------------------- 6. orf_predict
print('[6] orf_predict')
r = st2.op_orf_predict({'input': FA, 'min_aa': 3, 'strands': 'plus',
                        'output_file': os.path.join(OUT, 'orfs.tsv')})
top = r['top_orfs'][0]
check('seq1 ORF 1..12', top['start'] == 1 and top['end'] == 12, str(top))
check('seq1 ORF aa=4', top['length_aa'] == 4, str(top))

r2 = st2.op_orf_predict({'input': FA, 'min_aa': 3, 'strands': 'both',
                         'output_file': os.path.join(OUT, 'orfs2.tsv')})
check('both strand finds reverse ORFs', r2['n_orfs'] >= r['n_orfs'], '%s >= %s' % (r2['n_orfs'], r['n_orfs']))

# ---------------------------------------------------------------- 7. protein_params
print('[7] protein_params')
r = st2.op_protein_params({'sequence': 'MKFGP', 'label': 'test5'})
p = r['results'][0]
check('protein mw approx 550-650', 500 < p['molecular_weight_kda'] * 1000 < 700, str(p['molecular_weight_kda']))
check('protein pi in range', 5 < p['isoelectric_point'] < 11, str(p['isoelectric_point']))
check('protein composition sums ~100', abs(sum(p['aa_composition_percent'].values()) - 100) < 1.5,
      str(sum(p['aa_composition_percent'].values())))
r = st2.op_protein_params({'input': FA})
check('batch protein params', r['count'] == 5, str(r['count']))

# ---------------------------------------------------------------- 8. ssr_mine
print('[8] ssr_mine')
r = st2.op_ssr_mine({'input': SSR, 'output_file': os.path.join(OUT, 'ssr.tsv')})
rows = r['preview']
hit1 = [x for x in rows if x['id'] == 'ssr1']
hit2 = [x for x in rows if x['id'] == 'ssr2']
hit3 = [x for x in rows if x['id'] == 'ssr3']
check('ssr1 AT x9', hit1 and hit1[0]['motif'] == 'AT' and hit1[0]['repeats'] == 9, str(hit1))
check('ssr2 CAG x7', hit2 and hit2[0]['motif'] == 'CAG' and hit2[0]['repeats'] == 7, str(hit2))
check('ssr3 A x15', hit3 and hit3[0]['motif'] == 'A' and hit3[0]['repeats'] == 15, str(hit3))
check('ssr4 none', not any(x['id'] == 'ssr4_none' for x in rows))

# ---------------------------------------------------------------- 9. primer_check
print('[9] primer_check')
fwd = TEMPLATE[0:20]
rev_bind = TEMPLATE[60:80]
from Bio.Seq import Seq as _S  # noqa: E402
rev_primer = str(_S(rev_bind).reverse_complement())
r = st2.op_primer_check({
    'pairs': [{'name': 'p1', 'forward': fwd, 'reverse': rev_primer}],
    'input': PRIMER, 'min_amplicon': 30, 'max_amplicon': 500,
})
check('pair amplicon unique', r['pairs'][0]['n_amplicons'] == 1,
      str(r['pairs'][0]['n_amplicons']))
amp = r['pairs'][0]['amplicons'][0]
check('amplicon size=80', amp['size'] == 80, str(amp))
check('fwd at 1', amp['forward_at'] == 1, str(amp))
check('rev at 61', amp['reverse_at'] == 61, str(amp))

r = st2.op_primer_check({'primers': [{'name': 'single1', 'sequence': TEMPLATE[10:30]}],
                         'input': PRIMER})
check('single primer hit at 11', r['primers'][0]['hits'][0]['position'] == 11, str(r['primers'][0]))

# ---------------------------------------------------------------- 10. gff_positions
print('[10] gff_positions')
r = gt.op_gff_positions({'gff': GFF, 'types': ['gene'], 'attrs': ['ID'],
                         'output_file': os.path.join(OUT, 'pos.tsv')})
check('positions genes=2', r['n_records'] == 2, str(r['n_records']))
check('g1 11-60 +', r['preview'][0]['start'] == 11 and r['preview'][0]['end'] == 60, str(r['preview'][0]))

# ---------------------------------------------------------------- 11. gff_sequences
print('[11] gff_sequences')
r = gt.op_gff_sequences({'genome': GENOME, 'gff': GFF, 'feature': 'CDS',
                         'output_file': os.path.join(OUT, 'cds.fa')})
got = read_fasta_keys(r['output_file'])
# g1 期望 = chr1[10:30] + chr1[40:60]（1-based 11-30 / 41-60）
exp_g1 = CHR1[10:30] + CHR1[40:60]
check('CDS g1 concat', got.get('m1') == exp_g1, str(got.get('m1'))[:40] + ' vs ' + exp_g1[:40])
# g2 期望 = rc(chr1[80:100] + chr1[110:130])
exp_g2 = str(_S(CHR1[80:100] + CHR1[110:130]).reverse_complement())
check('CDS g2 revcomp', got.get('m2') == exp_g2, str(got.get('m2'))[:40] + ' vs ' + exp_g2[:40])
check('CDS count=2', r['count'] == 2, str(r['count']))

r = gt.op_gff_sequences({'genome': GENOME, 'gff': GFF, 'feature': 'gene',
                         'ids': ['g1'], 'output_file': os.path.join(OUT, 'gene.fa')})
got = read_fasta_keys(r['output_file'])
check('gene g1 = chr1[10:60]', got.get('g1') == CHR1[10:60], str(got.get('g1'))[:40])

r = gt.op_gff_sequences({'genome': GENOME, 'gff': GFF, 'feature': 'promoter',
                         'promoter_len': 5, 'output_file': os.path.join(OUT, 'prom.fa')})
got = read_fasta_keys(r['output_file'])
# g1 + strand TSS=11 -> upstream 5nt = chr1[5:10]
check('promoter g1 = chr1[5:10]', got.get('g1') == CHR1[5:10], str(got.get('g1')))
# g2 - strand TSS=130 -> upstream = chr1[130:135] rc
exp_g2p = str(_S(CHR1[130:135]).reverse_complement())
check('promoter g2 revcomp', got.get('g2') == exp_g2p, str(got.get('g2')))

# ---------------------------------------------------------------- 12. gff_ops
print('[12] gff_ops')
r = gt.op_gff_ops({'gff': GFF, 'action': 'stats'})
check('gff stats gene=2', r['by_type'].get('gene') == 2, str(r['by_type']))
check('gff stats CDS=4', r['by_type'].get('CDS') == 4, str(r['by_type']))
check('gene len stats', r['gene_length_stats']['count'] == 2, str(r.get('gene_length_stats')))

r = gt.op_gff_ops({'gff': GFF, 'action': 'filter', 'types': ['CDS'],
                   'output_file': os.path.join(OUT, 'cds_only.gff3')})
check('gff filter CDS=4', r['n_selected'] == 4, str(r['n_selected']))

r = gt.op_gff_ops({'gff': GFF, 'action': 'extract_region', 'region': 'chr1:1-70',
                   'output_file': os.path.join(OUT, 'reg.gff3')})
check('gff region 1-70 -> 6 records', r['n_selected'] == 6, str(r['n_selected']))

# ---------------------------------------------------------------- summary
print()
print('=' * 60)
print('PASS: %d    FAIL: %d' % (PASSES[0], len(FAILURES)))
if FAILURES:
    for f in FAILURES:
        print('  FAILED:', f)
    sys.exit(1)
print('ALL OK')
