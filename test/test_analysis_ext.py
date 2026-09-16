"""能力补缺 5 op 的验证测试（2026-09-16）。

覆盖：内含子外显子 / 点阵图 / UniProt / 树比较 / RNA 折叠。
断言全部基于真实计算结果与可独立推导的期望值。
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PY = os.path.join(os.path.expanduser('~'), '.dsh', 'dsh-bio-genie',
                  'python-env', 'Scripts', 'python.exe')
TMP = os.environ.get('LOCALAPPDATA', '') + '/Temp'
out = []

# Windows 控制台默认 GBK，打印 ✔/中文会 UnicodeEncodeError —— 强制 UTF-8
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def run(op, args, timeout=180):
    req = json.dumps({'op': op, 'args': args})
    p = subprocess.run([PY, '-I', os.path.join(ROOT, 'python', 'bio_ops.py')],
                       input=req.encode('utf-8'), capture_output=True, timeout=timeout,
                       cwd=ROOT)
    if p.returncode != 0:
        raise AssertionError(f'{op} 进程失败 rc={p.returncode}: {p.stderr.decode("utf-8", "replace")[-800:]}')
    d = json.loads(p.stdout.decode('utf-8'))
    if not d.get('ok'):
        raise AssertionError(f'{op} 返回错误: {d.get("error")}')
    return d['result']


def log(s=''):
    out.append(str(s))
    try:
        print(str(s))
    except UnicodeEncodeError:  # 控制台不支持时退化为 ASCII 摘要
        print(str(s).encode('ascii', 'replace').decode('ascii'))


# ================= 1) 点阵图（确定性：构造两条共享片段的序列）=================
log('=== 1) seq_dotplot ===')
seg = 'ATGCGTACGTAGCTAGCTAGCATCGATCGTACGATCGATCGTAGCTAGCTAGCATCGATCGTAG'
s1 = 'GGGG' + seg + 'TTTTTTTTTTTTTTTTTTTT'
s2 = 'CCCCCCCCCCCC' + seg + 'AAAAAAAAAAAA'
r = run('seq_dotplot', {'seq1': s1, 'seq2': s2, 'window': 12, 'threshold': 0.9,
                        'output_file': os.path.join(TMP, 'dotplot_test.png')})
log(f"  seq1={r['seq1_length']} seq2={r['seq2_length']} dots={r['dots']} "
    f"density={r['dot_density']} self={r['self_comparison']}")
assert r['dots'] > 0, '共享片段应产生对角点'
assert os.path.exists(r['output_file']), '图文件未生成'
assert os.path.getsize(r['output_file']) > 3000, '图文件过小'
log(f"  ✔ 共享 59bp 片段检出 {r['dots']} 个对角点；图 {os.path.getsize(r['output_file'])}B")
# 自比对应出现主对角
r2 = run('seq_dotplot', {'seq1': seg, 'seq2': seg, 'window': 12, 'threshold': 0.9,
                         'output_file': os.path.join(TMP, 'dotplot_self.png')})
assert r2['self_comparison'] and r2['main_diagonal_hits'] > 0
log(f"  ✔ 自比对检出主对角 {r2['main_diagonal_hits']} 点")
# 参数守护
try:
    run('seq_dotplot', {'seq1': 'ACGT', 'seq2': 'ACGT'})
    raise AssertionError('短序列未被拒')
except AssertionError as e:
    if '短序列未被拒' in str(e):
        raise
    log('  ✔ 短序列被拒')

# ================= 2) 树比较（RF 距离，可手工验证）=================
log()
log('=== 2) phylo_compare ===')
t_same_a = '((A:1,B:1):1,(C:1,D:1):1);'
r = run('phylo_compare', {'tree1': t_same_a, 'tree2': t_same_a})
log(f"  同拓扑: RF={r['robinson_foulds_distance']} shared_splits={r['shared_splits']} "
    f"identical={r['trees_identical_topology']}")
assert r['robinson_foulds_distance'] == 0
assert r['trees_identical_topology'] is True
# 四叶树只有 2 种拓扑：(AB|CD) vs (AC|BD) → RF = 2（各贡献 1 个独有分裂）
t_other = '((A:1,C:1):1,(B:1,D:1):1);'
r2 = run('phylo_compare', {'tree1': t_same_a, 'tree2': t_other})
log(f"  拓扑翻转: RF={r2['robinson_foulds_distance']} max_rf={r2['max_possible_rf']} "
    f"norm={r2['normalized_rf']}")
assert r2['robinson_foulds_distance'] == 2, f'四叶树拓扑翻转 RF 应为 2，实际 {r2["robinson_foulds_distance"]}'
assert r2['normalized_rf'] == 1.0
log('  ✔ 四叶树 (AB|CD) vs (AC|BD) → RF=2, normalized=1.0（手工推导一致）')
# 叶名不同 → 应剪枝后比较
r3 = run('phylo_compare', {'tree1': '((A:1,B:1):1,(C:1,D:1):1);',
                           'tree2': '((A:1,B:1):1,(C:1,D:1):1,E:1);'})
log(f"  叶集不同: shared={r3['shared_leaves']} dropped2={r3['dropped_from_tree2']} rf={r3['robinson_foulds_distance']}")
assert r3['dropped_from_tree2'] == ['E']

# 5 叶深树：检查分裂计数与互补边去重（浅用例抓不住互补双计）
t5a = '(((A:1,B:1):1,C:1):1,(D:1,E:1):1);'
t5b = '(((A:1,C:1):1,B:1):1,(D:1,E:1):1);'
r5a = run('phylo_compare', {'tree1': t5a, 'tree2': t5a})
r5b = run('phylo_compare', {'tree1': t5a, 'tree2': t5b})
log(f"  5叶自身: splits={r5a['tree1_splits']}（无根二叉 5 叶应 2 条内部边） rf={r5a['robinson_foulds_distance']}")
log(f"  5叶翻转一内部边: splits={r5b['tree1_splits']}/{r5b['tree2_splits']} "
    f"shared={r5b['shared_splits']} rf={r5b['robinson_foulds_distance']}")
assert r5a['tree1_splits'] == 2, f"5 叶树内部边应为 2，实际 {r5a['tree1_splits']}（互补边未去重）"
assert r5a['robinson_foulds_distance'] == 0
assert r5b['robinson_foulds_distance'] == 2, f'单边差异 RF 应为 2，实际 {r5b["robinson_foulds_distance"]}'
assert r5b['shared_splits'] == 1
log('  ✔ 互补分裂正确去重（词典序规范形）；单内部边差异 → RF=2')
# 完全不相关拓扑（3 个内部边全不同）：6 叶
t6a = '(((A,B),C),((D,E),F));'
t6b = '(((A,D),E),((B,C),F));'
r6 = run('phylo_compare', {'tree1': t6a, 'tree2': t6b})
log(f"  6叶: splits={r6['tree1_splits']}/{r6['tree2_splits']} shared={r6['shared_splits']} "
    f"rf={r6['robinson_foulds_distance']} max={r6['max_possible_rf']} norm={r6['normalized_rf']}")
assert r6['tree1_splits'] == 3, f"6 叶无根二叉应 3 条内部边，实际 {r6['tree1_splits']}"

# ================= 3) RNA 折叠（ViennaRNA 真计算）=================
log()
log('=== 3) rna_fold ===')
# 经典发夹：茎 6bp + 环 4nt
hairpin = 'GCGCGC' + 'UUUU' + 'GCGCGC'
r = run('rna_fold', {'sequence': hairpin, 'also_ensemble': True,
                     'output_file': os.path.join(TMP, 'rnafold_test.png')})
log(f"  seq={r['sequence']}")
log(f"  structure={r['structure_dot_bracket']}  ΔG={r['mfe_kcal_per_mol']} kcal/mol")
log(f"  bp={r['base_pairs']}  ensemble={r.get('ensemble')}")
assert r['base_pairs'] == 6, f'设计发夹应 6 对碱基，实际 {r["base_pairs"]}'
assert r['structure_dot_bracket'] == '((((((....))))))', f"结构异常: {r['structure_dot_bracket']}"
assert r['mfe_kcal_per_mol'] < 0
assert os.path.exists(r['output_file'])
log(f"  ✔ 发夹精确折叠为 6bp 茎+4nt 环；图 {os.path.getsize(r['output_file'])}B")
# DNA 输入自动 T→U
r2 = run('rna_fold', {'sequence': 'GCGCGCTTTTGCGCGC', 'also_ensemble': False})
assert r2['sequence'] == 'GCGCGCUUUUGCGCGC', r2['sequence']
log('  ✔ DNA 输入自动 T→U')

# ================= 4) UniProt（真实 REST）=================
log()
log('=== 4) uniprot ===')
r = run('uniprot', {'accession': 'P38398', 'mode': 'entry'})  # BRCA1
p = r['protein']
log(f"  {p['accession']} {p['protein_name'][:50]} | {p['genes']} | {p['organism']} | {p['length']} aa")
log(f"  feature_total={r['feature_total']} 类型数={len(r['feature_counts'])} xref库={r['xref_database_count']}")
assert p['genes'] == ['BRCA1'] and p['length'] == 1863
r_ptm = run('uniprot', {'accession': 'P38398', 'mode': 'ptm'})
log(f"  PTM 总数={r_ptm['total_sites']} 分类={r_ptm['ptm_counts']}")
assert r_ptm['total_sites'] > 0
r_x = run('uniprot', {'accession': 'P38398', 'mode': 'xref'})
log(f"  交叉引用: {r_x['database_total']} 个库 / {r_x['xref_total']} 条；top: {list(r_x['database_counts'])[:5]}")
r_path = run('uniprot', {'accession': 'P38398', 'mode': 'pathway'})
log(f"  通路库: {r_path['pathway_databases']}")
r_seq = run('uniprot', {'accession': 'P38398', 'mode': 'sequence'})
assert r_seq['length'] == 1863 and r_seq['sequence'].startswith('MDLSAL')
log(f"  序列模式: {r_seq['length']} aa, 起始 {r_seq['sequence'][:12]}")
r_search = run('uniprot', {'mode': 'search', 'query': 'BRCA1 AND organism_id:9606 AND reviewed:true', 'limit': 5})
log(f"  检索模式: {r_search['count']} 条；首条 {r_search['results'][0]['accession']} {r_search['results'][0]['entry_name']}")

# ================= 5) 内含子/外显子（真实 GenBank）=================
log()
log('=== 5) seq_introns ===')
# NG_005905 是含多个基因的 RefSeqGene 区（TMEM106A/NBR1/BRCA1/RND2…）
r = run('seq_introns', {'accession': 'NG_005905', 'gene': 'BRCA1', 'max_features': 3}, timeout=400)
log(f"  记录={r['record_id']} 长度={r['record_length']} 物种={r['organism']}")
log(f"  转录本数={r['count']}  剪接统计={r.get('splice_summary')}")
assert r['count'] > 0, f"BRCA1 应能解析出含内含子的转录本；note={r.get('note')}"
assert r['count'] == 1, f"精确匹配 BRCA1 应只命中 1 个 CDS，实际 {r['count']}（宽松匹配会误中 NBR1）"
t = r['transcripts'][0]
log(f"  命中: gene={t['gene']} name={t['name'][:40]} strand={t['strand']} "
    f"外显子={t['exon_count']} 内含子={t['intron_count']} 编码={t['coding_length_bp']}bp "
    f"蛋白={t['protein_length_aa']}aa")
# ★ 回归守卫：NBR1 的 product 字面含 "next to BRCA1 gene"，绝不能因宽松匹配被选中
assert t['gene'].upper() == 'BRCA1', f"基因过滤误中 {t['gene']}（应为 BRCA1）——宽松匹配回归！"
assert t['strand'] == '+', f"BRCA1 应为正链，实际 {t['strand']}"
assert t['intron_count'] >= 20, f"BRCA1 应有 20+ 内含子，实际 {t['intron_count']}"
log(f"  ✔ 基因精确匹配（未误中 product 含 BRCA1 字样的 NBR1）")

i0 = t['introns'][0]
log(f"    内含子1: {i0['start']}-{i0['end']} ({i0['length']}bp) "
    f"{i0['donor_dinucleotide']}..{i0['acceptor_dinucleotide']} [{i0['splice_class']}]")
# ★ 真核基因绝大多数内含子是经典 GT-AG —— 若方向/互补算错会全体落到 non_canonical
frac = r['splice_summary']['canonical_fraction']
log(f"  ✔ 剪接位点：canonical {r['splice_summary']['canonical_GT_AG']}/{r['splice_summary']['total_introns']} = {frac}")
assert frac is not None and frac > 0.9, f"正链基因 canonical 比例应 >0.9，实际 {frac}——剪接位点判读方向可能有误"

# 拓扑自洽：正链外显子坐标必须递增，且内含子落在相邻外显子之间
prev_end = 0
for e in t['exons']:
    assert e['start'] > prev_end, f'正链外显子坐标应递增: {e}'
    prev_end = e['end']
for a, b, i in zip(t['exons'], t['exons'][1:], t['introns']):
    assert a['end'] < i['start'] and i['end'] < b['start'], '内含子应位于相邻外显子之间'
log(f"  ✔ 外显子/内含子坐标拓扑自洽（{t['intron_count']} 个内含子全部落在相邻外显子之间）")

# ---- 负链基因：验证转录方向排序 + 反向互补判定 ----
log()
log('  --- 负链基因（TMEM106A，strand=-）---')
r2 = run('seq_introns', {'accession': 'NG_005905', 'gene': 'TMEM106A', 'max_features': 1}, timeout=400)
assert r2['count'] == 1, f'TMEM106A 应命中 1 个转录本，实际 {r2["count"]}'
t2 = r2['transcripts'][0]
log(f"  gene={t2['gene']} strand={t2['strand']} 外显子={t2['exon_count']} 内含子={t2['intron_count']}")
# 负链按转录方向输出 → 外显子坐标递减
for a, b in zip(t2['exons'], t2['exons'][1:]):
    assert a['start'] > b['end'], f'负链外显子应按转录方向递减: {a} → {b}'
for a, b, i in zip(t2['exons'], t2['exons'][1:], t2['introns']):
    assert i['start'] > b['end'] and i['end'] < a['start'], \
        f'负链内含子应位于两个外显子之间（基因组坐标）: exon {b} | intron {i} | exon {a}'
f2 = r2['splice_summary']['canonical_fraction']
log(f"  ✔ 负链 canonical = {r2['splice_summary']['canonical_GT_AG']}/{r2['splice_summary']['total_introns']} = {f2}")
log(f"    首位内含子: {t2['introns'][0]['donor_dinucleotide']}..{t2['introns'][0]['acceptor_dinucleotide']} "
    f"[{t2['introns'][0]['splice_class']}]")
assert f2 is not None and f2 > 0.9, f'负链 canonical 比例应 >0.9，实际 {f2}——反向互补判定有误'

# ---- 错误基因名：应给出可用基因清单而不是静默空 ----
r3 = run('seq_introns', {'accession': 'NG_005905', 'gene': 'NBR1X'}, timeout=400)
log()
log(f"  不存在基因名 → count={r3['count']}，available_genes={r3.get('available_genes')}")
assert r3['count'] == 0 and r3.get('available_genes'), '未匹配时应返回可用基因清单'
near_hint = [g for g in r3['available_genes'] if 'NBR1X' in g]
assert r3['note'], '应给出说明性 note'

log()
log('全部断言通过 ✅')
open(os.path.join(TMP, 'analysis-ext-test.txt'), 'w', encoding='utf-8').write('\n'.join(out))
print('ALL PASS')
