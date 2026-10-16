"""Ka/Ks（NG86）—— 直测脚本（批次 C3）

用插件 venv python 直跑：
    $HOME/.dsh/dsh-bio-genie/python-env/Scripts/python.exe -I test/test_kaks.py

含手算数值断言（位点/替换/校正的逐项核对）。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'python'))

os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

import kaks  # noqa: E402

FAILURES = []
PASSES = [0]


def check(name, cond, detail=''):
    if cond:
        PASSES[0] += 1
        print('  ok  %s' % name)
    else:
        FAILURES.append('%s %s' % (name, detail))
        print('  FAIL %s %s' % (name, detail))


def close(a, b, tol=1e-4):
    return a is not None and b is not None and abs(a - b) < tol


# ---- 1) 位点计数（手算） ----
print('[1] syn_sites 手算')
check('CTG 同义位点 = 1.3333', close(kaks.syn_sites('CTG'), 1.3333333), str(kaks.syn_sites('CTG')))
check('CTA 同义位点 = 1.3333', close(kaks.syn_sites('CTA'), 1.3333333), str(kaks.syn_sites('CTA')))
check('TTG 同义位点 = 0.6667', close(kaks.syn_sites('TTG'), 0.6666667), str(kaks.syn_sites('TTG')))
check('GCT 同义位点 = 1.0', close(kaks.syn_sites('GCT'), 1.0), str(kaks.syn_sites('GCT')))
check('GAT 同义位点 = 0.3333', close(kaks.syn_sites('GAT'), 0.3333333), str(kaks.syn_sites('GAT')))
check('TGG(Trp) 同义位点 = 0', close(kaks.syn_sites('TGG'), 0.0), str(kaks.syn_sites('TGG')))
check('ATG(Met) 同义位点 = 0', close(kaks.syn_sites('ATG'), 0.0), str(kaks.syn_sites('ATG')))

# ---- 2) 替换计数（含路径平均与终止路径排除） ----
print('[2] count_diff 手算')
check('同义单替换 CTG/CTA = (1,0)', kaks.count_diff('CTG', 'CTA') == (1.0, 0.0), str(kaks.count_diff('CTG', 'CTA')))
check('非同义单替换 GCT/GAT = (0,1)', kaks.count_diff('GCT', 'GAT') == (0.0, 1.0), str(kaks.count_diff('GCT', 'GAT')))
r = kaks.count_diff('TTT', 'GTA')
check('双差异路径平均 TTT/GTA = (0.5,1.5)', r == (0.5, 1.5), str(r))
r = kaks.count_diff('CGA', 'TGG')
check('含终止路径排除 CGA/TGG = (1,1)', r == (1.0, 1.0), str(r))
check('对称性 TTT/GTA', kaks.count_diff('TTT', 'GTA') == kaks.count_diff('GTA', 'TTT'))

# ---- 3) JC 校正（手算） ----
print('[3] jc_correct 手算')
check('p=0.5 -> 0.823959', close(kaks.jc_correct(0.5), 0.823959), str(kaks.jc_correct(0.5)))
check('p=0.75 -> None（饱和）', kaks.jc_correct(0.75) is None)
check('p=0.8 -> None', kaks.jc_correct(0.8) is None)

# ---- 4) ng86 单元（两对例：手算全链 Ks=0.635473；单对饱和边界） ----
print('[4] ng86 同义替换（两对例 Ks=0.635473 手算）')
res = kaks.ng86([('CTG', 'CTA'), ('GCT', 'GCT')])
check('S=2.3333', close(res['S'], 2.3333333), str(res['S']))
check('N=3.6667', close(res['N'], 3.6666667), str(res['N']))
check('Sd=1 Nd=0', res['Sd'] == 1.0 and res['Nd'] == 0.0, str(res))
check('pS=0.428571', close(res['pS'], 0.428571), str(res['pS']))
check('Ks=0.635473', close(res['Ks'], 0.635473, 1e-5), str(res['Ks']))
check('Ka=0（pN=0 -> dN=0）', res['Ka'] == 0.0, str(res['Ka']))
sat = kaks.ng86([('CTG', 'CTA')])
check('单对 CTG/CTA pS=0.75 恰好饱和 -> Ks None', sat['Ks'] is None and sat.get('Ks_reason') == 'saturated_pS', str(sat))

# ---- 5) ng86 非同义（Ka=0.635473 手算；Ks=0 触发零值哨兵） ----
print('[5] ng86 非同义替换（Ka=0.635473 手算）')
res = kaks.ng86([('GCT', 'GAT')])
check('Ka=0.635473', close(res['Ka'], 0.635473, 1e-5), str(res['Ka']))
check('Ks=0 -> None + zero 哨兵', res['Ks'] is None and res.get('Ks_reason') == 'zero', str(res))

# ---- 6) 全流程（合成 CDS，29 codons；按密码子列表替换保证框不变） ----
print('[6] 全流程 kaks_pair')
codons1 = ['ATG'] + ['GCT'] * 10 + ['CTG'] * 10 + ['AAA'] * 8   # 29 codons, 无终止
seq1 = ''.join(codons1)
c2 = list(codons1)
c2[11] = c2[13] = c2[15] = 'CTA'    # CTG 段内 3 个同义替换（Leu->Leu）
seq2 = ''.join(c2)
c3 = list(codons1)
c3[1] = c3[3] = 'GAT'               # GCT 段内 2 个非同义替换（Ala->Asp）
seq3 = ''.join(c3)
r12 = kaks.kaks_pair(seq1, seq2, protein_aln=None)
check('全流程同义对：Sd=3', r12['Sd'] == 3.0, str(r12['Sd']))
check('全流程同义对：Ks>0 且 Ka=0', (r12['Ks'] or 0) > 0 and r12['Ka'] == 0.0, str(r12))
check('无 -0.0（Ka 符号位非负）', __import__('math').copysign(1.0, r12['Ka']) > 0, repr(r12['Ka']))
check('omega=0（dN=0/dS>0）且判读纯化', r12['omega'] == 0.0 and r12['interpretation'] == 'purifying_selection', str(r12))
r13 = kaks.kaks_pair(seq1, seq3)
check('全流程非同义对：Nd=2', r13['Nd'] == 2.0, str(r13['Nd']))
check('全流程非同义对：Ka>0', (r13['Ka'] or 0) > 0, str(r13['Ka']))
r_id = kaks.kaks_pair(seq1, seq1)
check('相同序列：Sd=Nd=0、Ks/Ka 走哨兵', r_id['Sd'] == 0 and r_id['Nd'] == 0 and r_id['Ks'] is None,
      str(r_id))

# ---- 7) fail-closed ----
print('[7] fail-closed')
try:
    kaks._clean_cds('ATGG', 'x')
    check('非 3 倍数报错', False, 'no raise')
except ValueError:
    check('非 3 倍数报错', True)
try:
    kaks._clean_cds('ATGTAAGCT', 'x')
    check('内部终止报错', False, 'no raise')
except ValueError:
    check('内部终止报错', True)
try:
    kaks._clean_cds('ATGNNNGCT', 'x')
    check('非法字符报错', False, 'no raise')
except ValueError:
    check('非法字符报错', True)

# ---- 8) 末端终止去除 ----
print('[8] 末端终止处理')
c = kaks._clean_cds('ATGGCTTAA', 'x')
check('尾终止去除（3 codons 含终止）', len(c) == 2, str(c))

print()
print('=' * 60)
print('PASS: %d    FAIL: %d' % (PASSES[0], len(FAILURES)))
if FAILURES:
    for f in FAILURES:
        print('  FAILED:', f)
    sys.exit(1)
print('ALL OK')
