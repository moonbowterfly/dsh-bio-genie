# -*- coding: utf-8 -*-
"""来源审计（bio_source_audit）测试。

分层：
  A. 单元层（零网络）：序列匹配 / 比对项评估 / 状态机 / scan 抽取 / 上限与
     入参校验 / 全流程（mock 抓取层）
  B. 实网冒烟（少量、稳定目标）：NCBI / UniProt 核验 + not_found 反例

运行：node scripts/run-python-test.mjs test/test_source_audit.py
（或直接：<python-env>/python.exe -B test/test_source_audit.py）
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, 'python'))
import source_audit_tools as sat  # noqa: E402

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

FAIL = []


def check(name, cond, extra=''):
    tag = 'PASS' if cond else 'FAIL'
    print('%s  %s  %s' % (tag, name, extra))
    if not cond:
        FAIL.append(name)


def mk(state, fields=None, sequence=None, detail='', source='fake'):
    return {'state': state, 'fields': fields, 'sequence': sequence,
            'detail': detail, 'source': source, 'retrieved_at': sat._now_iso()}


# ================= A. 单元层 =================
print('==== A1. 序列匹配 ====')
SEG = 'ATGCGTACGTAGCTAGCTAGCATCGATCG'
m = sat._match_sequence(SEG, 'TTTT' + SEG + 'AAAA')
check('fwd match', m['match'] and m['strand'] == '+' and m['positions_1based'][0] == 5, str(m))
rc = sat._revcomp(SEG)
m2 = sat._match_sequence(rc, 'TTTT' + SEG + 'AAAA')
check('revcomp match (strand -)', m2['match'] and m2['strand'] == '-', str(m2))
m3 = sat._match_sequence('GGGGGGGGGGGGGGGGGGGG', 'ATGC' * 10)
check('no match -> not match', not m3['match'], str(m3))
m4 = sat._match_sequence('AUG', 'ATGAAA')
check('U->T normalization', m4['match'] and m4['strand'] == '+', str(m4))
m5 = sat._match_sequence('  ATGC  GTAC  ', 'GGGGATGCGTACGGGG')
check('whitespace tolerated', m5['match'], str(m5))

print('==== A2. 比对项评估 ====')
F = {'organism': 'Agrobacterium fabrum str. C58', 'title': 'Agrobacterium fabrum chromosome linear',
     'length': 2075577, 'gene': None}
cs = sat._eval_checks(F, {'organism_contains': 'agrobacterium', 'length': 2075577}, 'ncbi_nucleotide')
check('checks all pass', all(c['status'] == 'pass' for c in cs), str(cs))
cs2 = sat._eval_checks(F, {'title_contains': 'NOT-THERE'}, 'ncbi_nucleotide')
check('check fail', cs2[0]['status'] == 'fail', str(cs2))
cs3 = sat._eval_checks(F, {'organism_contains': 'x'}, 'pdb')
check('unsupported for pdb', cs3[0]['status'] == 'unsupported', str(cs3))
cs4 = sat._eval_checks(F, {'length': 'abc'}, 'ncbi_nucleotide')
check('non-int length -> unsupported', cs4[0]['status'] == 'unsupported', str(cs4))
cs5 = sat._eval_checks(F, {'blah': 1}, 'ncbi_nucleotide')
check('unknown check -> unsupported', cs5[0]['status'] == 'unsupported', str(cs5))
cs6 = sat._eval_checks(F, {'gene_contains': 'TP53'}, 'ncbi_nucleotide')
check('missing field -> unsupported', cs6[0]['status'] == 'unsupported', str(cs6))

print('==== A3. 状态归并 ====')
check('resolve mismatch', sat._resolve_status([{'status': 'pass'}, {'status': 'fail'}]) == 'mismatch')
check('resolve partial', sat._resolve_status([{'status': 'pass'}, {'status': 'unsupported'}]) == 'partial')
check('resolve verified', sat._resolve_status([{'status': 'pass'}]) == 'verified')

print('==== A4. scan 抽取 ====')
T = ('见 NC_003063.2 与 NP_000546.2；另据 PMID: 36418310。PDB: 1TUP。'
     '序列 TGATATTGTTATTATGATCGATCGCCACTCAAATCTGAACTCCACTCC 来自该染色体。'
     '还有 ENST00000269305 转录本。')
hits, counts = sat._scan_text(T)
vals = {(h['kind'], h['value']) for h in hits}
check('scan nucleotide', ('ncbi_nucleotide', 'NC_003063.2') in vals, str(counts))
check('scan protein', ('ncbi_protein', 'NP_000546.2') in vals)
check('scan pmid value', ('pmid', '36418310') in vals)
check('scan pdb value', ('pdb', '1TUP') in vals)
check('scan ensembl', ('ensembl', 'ENST00000269305') in vals)
check('scan sequence 48nt', ('sequence', 'TGATATTGTTATTATGATCGATCGCCACTCAAATCTGAACTCCACTCC') in vals)
neg, ncounts = sat._scan_text('ACGTACGTACGT and acgtacgtacgtacgtacgt and BRCA1 and 36418310')
check('short/lowercase seq not caught', all(h['kind'] != 'sequence' for h in neg), str(ncounts))
check('bare number not caught as pmid', all(h['kind'] != 'pmid' for h in neg), str(ncounts))

print('==== A5. 入参校验与上限 ====')
try:
    sat.op_source_audit({'mode': 'identifiers', 'items_json': 'not-json'})
    check('bad items_json raises', False)
except ValueError as e:
    check('bad items_json raises', '不是合法 JSON' in str(e))
try:
    sat.op_source_audit({'mode': 'identifiers', 'items_json': json.dumps([{'db': 'uniprot', 'id': str(i)} for i in range(26)])})
    check('26 items raises', False)
except ValueError as e:
    check('26 items raises', '单次最多' in str(e))
try:
    sat.op_source_audit({'mode': 'nope'})
    check('bad mode raises', False)
except ValueError as e:
    check('bad mode raises', 'mode 必须为' in str(e))
try:
    sat.op_source_audit({'mode': 'scan'})
    check('scan without text raises', False)
except ValueError as e:
    check('scan without text raises', '需要 text 或 file' in str(e))

print('==== A6. 全流程（mock 抓取层） ====')
ORIG_FETCH = sat._fetch_record


def fake_fetch(db, rid, need_seq=False):
    if rid == 'OK1':
        return mk('ok', {'organism': 'Homo sapiens', 'title': 'Cellular tumor antigen p53',
                         'length': 393, 'gene': 'TP53'})
    if rid == 'BAD1':
        return mk('ok', {'organism': 'Homo sapiens', 'title': 'x', 'length': 393, 'gene': 'TP53'})
    if rid == 'PART1':
        return mk('ok', {'organism': 'Homo sapiens', 'title': 'x', 'length': 393, 'gene': None})
    if rid == 'NF1':
        return mk('not_found', detail='Invalid uid')
    if rid == 'UN1':
        return mk('unreachable', detail='timeout')
    if rid == 'SEQOK':
        return mk('ok', {'organism': None, 'title': None, 'length': 36, 'gene': None},
                  sequence='TTTT' + SEG + 'AAAA', source='fake-seq')
    raise AssertionError('unexpected fetch: %r %r' % (db, rid))


sat._fetch_record = fake_fetch
r = sat.op_source_audit({'mode': 'identifiers', 'items_json': json.dumps([
    {'db': 'uniprot', 'id': 'OK1', 'expect': {'organism_contains': 'homo'}},
    {'db': 'uniprot', 'id': 'BAD1', 'expect': {'length': 1}},
    {'db': 'uniprot', 'id': 'PART1', 'expect': {'gene_contains': 'TP53', 'length': 393}},
    {'db': 'uniprot', 'id': 'NF1'},
    {'db': 'uniprot', 'id': 'UN1'},
    {'db': 'nope', 'id': 'X'},
    'not-a-dict',
    {'db': 'uniprot', 'id': 'OK1'},
])})
s = r['summary']
check('flow total=8', s['total'] == 8, str(s))
check('flow verified=2', s['verified'] == 2, str(s))
check('flow mismatch=1', s['mismatch'] == 1, str(s))
check('flow partial=1', s['partial'] == 1, str(s))
check('flow not_found=1', s['not_found'] == 1, str(s))
check('flow unreachable=1', s['unreachable'] == 1, str(s))
check('flow error=2', s['error'] == 2, str(s))
check('flow all_verified False', s['all_verified'] is False)
ok_item = r['items'][0]
check('verified item has checks', ok_item['status'] == 'verified' and ok_item['checks'][0]['status'] == 'pass')
check('no-expect warning present', any('仅核验存在性' in w for w in r['items'][7].get('warnings', [])))

r2 = sat.op_source_audit({'mode': 'sequences', 'items_json': json.dumps([
    {'db': 'ncbi_nucleotide', 'id': 'SEQOK', 'sequence': SEG},
    {'db': 'ncbi_nucleotide', 'id': 'SEQOK', 'sequence': sat._revcomp(SEG)},
    {'db': 'ncbi_nucleotide', 'id': 'SEQOK', 'sequence': 'T' * 15},
    {'db': 'pdb', 'id': '1TUP', 'sequence': 'AAAA'},
])})
s2 = r2['summary']
check('seq flow verified=2', s2['verified'] == 2, str(s2))
check('seq flow mismatch=1', s2['mismatch'] == 1, str(s2))
check('seq flow error=1 (pdb unsupported)', s2['error'] == 1, str(s2))
check('seq per-item strand + / -', r2['items'][0]['match']['strand'] == '+' and r2['items'][1]['match']['strand'] == '-',
      str((r2['items'][0].get('match'), r2['items'][1].get('match'))))

tmpdir = tempfile.mkdtemp(prefix='src_audit_test_')
md_path = os.path.join(tmpdir, 'report.md')
r3 = sat.op_source_audit({'mode': 'identifiers', 'out_md': md_path,
                          'items_json': json.dumps([{'db': 'uniprot', 'id': 'OK1'}])})
check('out_md written', os.path.exists(md_path) and '来源审计报告' in open(md_path, encoding='utf-8').read())

r_al = sat.op_source_audit({'mode': 'identifiers', 'items_json': json.dumps([{'db': 'ncbi_nuccore', 'id': 'OK1'}])})
check('db alias nuccore accepted', r_al['items'][0]['status'] == 'verified' and r_al['items'][0]['db'] == 'ncbi_nucleotide', str(r_al['items'][0]))

sat._fetch_record = ORIG_FETCH

print('==== B. 实网冒烟 ====')
try:
    live1 = sat.op_source_audit({'mode': 'identifiers', 'items_json': json.dumps([
        {'db': 'ncbi_nucleotide', 'id': 'NC_003063.2',
         'expect': {'organism_contains': 'Agrobacterium', 'length': 2075577}},
    ])})
    it = live1['items'][0]
    check('live NCBI nuccore NC_003063.2 verified', it['status'] == 'verified', str(it.get('detail', '')))
except Exception as e:
    check('live NCBI nuccore NC_003063.2 verified', False, repr(e))

try:
    live2 = sat.op_source_audit({'mode': 'identifiers', 'items_json': json.dumps([
        {'db': 'uniprot', 'id': 'P04637',
         'expect': {'organism_contains': 'Homo sapiens', 'length': 393, 'gene_contains': 'TP53'}},
    ])})
    it = live2['items'][0]
    check('live UniProt P04637 verified', it['status'] == 'verified', str(it.get('detail', '')))
except Exception as e:
    check('live UniProt P04637 verified', False, repr(e))

try:
    live3 = sat.op_source_audit({'mode': 'identifiers', 'items_json': json.dumps([
        {'db': 'ncbi_nucleotide', 'id': 'NC_999999999'},
    ])})
    it = live3['items'][0]
    check('live bogus accession -> not_found', it['status'] == 'not_found', str(it))
except Exception as e:
    check('live bogus accession -> not_found', False, repr(e))

try:
    live4 = sat.op_source_audit({'mode': 'sequences', 'items_json': json.dumps([
        {'db': 'ncbi_nucleotide', 'id': 'NC_003063.2',
         'sequence': 'TGATATTGTTATTATGATCGATCGCCACTCAAATCTGAACTCCACTCC'},
    ])})
    it = live4['items'][0]
    check('live seq NC_003063.2 pos1 verified',
          it['status'] == 'verified' and it['match']['strand'] == '+' and it['match']['positions_1based'][0] == 1,
          str(it.get('match', {})))
except Exception as e:
    check('live seq NC_003063.2 pos1 verified', False, repr(e))

try:
    live5 = sat.op_source_audit({'mode': 'sequences', 'items_json': json.dumps([
        {'db': 'uniprot', 'id': 'P04637', 'sequence': 'MEEPQSDPSVEPPLSQETFSDLWK'},
    ])})
    it = live5['items'][0]
    check('live seq P04637 protein verified', it['status'] == 'verified' and it['match']['strand'] == '+',
          str(it.get('match', {})))
except Exception as e:
    check('live seq P04637 protein verified', False, repr(e))

print()
if FAIL:
    print('FAILED: %d 项未通过 -> %s' % (len(FAIL), FAIL))
    sys.exit(1)
print('ALL PASS（source_audit）')
