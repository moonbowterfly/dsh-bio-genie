#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sequence 参数「内容或文件路径」统一解析的回归测试（2026-10-04）。

背景：真实 E2E 会话（dsh 桌面端 lacZ 任务）中，agent 自然地把 FASTA 文件路径
传给 bio_seq_analyze / bio_primer3_design 的 sequence 参数，被当作字面序列解析
（报 Codon 错误 / 模板太短的底层怪错误），agent 被迫全文打印序列再复制粘贴。
修复：seq_util.read_seq_input 统一解析（存在路径 → FASTA/GenBank/纯文本；
像路径但不存在 → 明确报错；多记录 → fail-closed 报错）并接入全部序列参数 op。

用法（仓库根目录）：
  node scripts/run-python-test.mjs test/test_seq_input.py
"""
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, '..', 'python'))

import bio_ops  # noqa: E402
import seq_util  # noqa: E402

LF = chr(10)
FAILURES = 0


def check(cond, msg):
    global FAILURES
    if cond:
        print(f'  PASS {msg}')
    else:
        FAILURES += 1
        print(f'  FAIL {msg}')


def expect_error(fn):
    try:
        fn()
        return None
    except Exception as exc:  # noqa: BLE001
        return exc


SEQ = 'ATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAG'  # 39 bp（修复用例同族）
TEMPLATE = SEQ * 4  # 156 bp（primer3 模板下限 40）


def write(path, text):
    with open(path, 'w', encoding='utf-8', newline=LF) as fh:
        fh.write(text)
    return path


tmp = tempfile.TemporaryDirectory(prefix='seq_input_test_')
T = tmp.name
f_one = write(os.path.join(T, 'one.fasta'), '>t1 desc' + LF + SEQ + LF)
f_two = write(os.path.join(T, 'two.fasta'), '>a' + LF + SEQ + LF + '>b' + LF + SEQ + LF)
f_plain = write(os.path.join(T, 'plain.txt'), SEQ + LF)
f_empty = write(os.path.join(T, 'empty.fa'), '')
f_tmpl = write(os.path.join(T, 'template.fasta'), '>tmpl' + LF + TEMPLATE + LF)
f_gb = write(os.path.join(T, 'mini.gb'), LF.join([
    'LOCUS       mini_test                 39 bp    DNA     linear   SYN 04-OCT-2026',
    'DEFINITION  mini test sequence.',
    'ACCESSION   mini_test',
    'VERSION     mini_test.1',
    'ORIGIN',
    '        1 atggccattg taatgggccg ctgaaagggt gcccgatag',
    '//', '']))
f_nwk = write(os.path.join(T, 'tree.nwk'), '(A:0.1,B:0.2);' + LF)
missing = os.path.join(T, 'nope.fasta')

print('== seq_util 单元级 ==')
check(seq_util.read_seq_input(SEQ) == SEQ, '内联序列原样返回')
check(seq_util.read_seq_input('  ' + SEQ[:10] + LF + SEQ[10:] + '  ') == SEQ,
      '内联序列（含内部换行）去空白')
check(seq_util.read_seq_input(f_one) == SEQ, 'FASTA 单记录 → 序列')
check(seq_util.read_seq_input(f_plain) == SEQ, '纯文本文件 → 序列')
check(seq_util.read_seq_input(f_gb) == SEQ, 'GenBank 单记录 → 序列')
err = expect_error(lambda: seq_util.read_seq_input(f_two))
check(err is not None and '2 条 FASTA 记录' in str(err), f'FASTA 多记录 fail-closed（{err}）')
err = expect_error(lambda: seq_util.read_seq_input(missing))
check(err is not None and '文件不存在' in str(err), f'缺失路径明确报错（{type(err).__name__}）')
err = expect_error(lambda: seq_util.read_seq_input(T))
check(err is not None and '目录' in str(err), '目录路径明确报错')
err = expect_error(lambda: seq_util.read_seq_input(f_empty))
check(err is not None, '空文件报错')
err = expect_error(lambda: seq_util.read_seq_input(''))
check(err is not None and '不能为空' in str(err), '空输入报错')
check(seq_util.read_text_input(f_nwk) == '(A:0.1,B:0.2);' + LF, 'read_text_input 文件读取')
check(seq_util.read_text_input('(X:1);') == '(X:1);', 'read_text_input 内联文本')
check(seq_util.clean_seq('') == '', 'clean_seq 兼容性保持')

print('== op 级：文件 == 内联 一致性 ==')
a_inline = bio_ops.op_seq_analyze({'sequence': SEQ})
a_file = bio_ops.op_seq_analyze({'sequence': f_one})
check(a_inline.get('gc_percent') == a_file.get('gc_percent')
      and a_inline.get('length') == a_file.get('length') == 39,
      f'seq_analyze 文件==内联（gc={a_file.get("gc_percent")}）')
t_inline = bio_ops.op_seq_translate({'sequence': SEQ})
t_file = bio_ops.op_seq_translate({'sequence': f_one})
check(t_inline.get('protein') == t_file.get('protein') == 'MAIVMGR*KGAR*',
      'seq_translate 文件==内联')
k_inline = bio_ops.op_seq_kmer({'sequence': SEQ, 'k': 3})
k_file = bio_ops.op_seq_kmer({'sequence': f_one, 'k': 3})
check(k_inline == k_file, 'seq_kmer 文件==内联')
g_inline = bio_ops.op_seq_gc_skew({'sequence': SEQ, 'window': 10})
g_file = bio_ops.op_seq_gc_skew({'sequence': f_one, 'window': 10})
check(g_inline == g_file, 'seq_gc_skew 文件==内联')
orf = bio_ops.op_seq_find_orf({'sequence': f_one})
check(isinstance(orf, dict), 'seq_find_orf 文件输入可运行')
err = expect_error(lambda: bio_ops.op_seq_analyze({'sequence': f_two}))
check(err is not None and '2 条 FASTA 记录' in str(err), 'op 层多记录 fail-closed')

print('== 相对路径（基于进程工作目录解析）==')
old_cwd = os.getcwd()
try:
    os.chdir(T)
    rel = bio_ops.op_seq_analyze({'sequence': 'one.fasta'})
    check(rel.get('length') == 39, '相对路径（cwd 下文件名）可用')
finally:
    os.chdir(old_cwd)

print('== analysis_ext 序列/文本参数 ==')
dots = bio_ops.op_seq_dotplot({'seq1': f_one, 'seq2': f_plain,
                               'output_file': os.path.join(T, 'dotplot.png')})
check(isinstance(dots, dict) and dots.get('seq1_length') == 39,
      'seq_dotplot 双文件输入')

print('== primer3（第二层按需依赖，缺则显式跳过）==')
try:
    import primer3  # noqa: F401
    has_primer3 = True
except ImportError:
    has_primer3 = False
if has_primer3:
    p3 = bio_ops.op_primer3_design({'sequence': f_tmpl, 'num_return': 2})
    check(len(p3.get('pairs', [])) > 0, 'primer3_design 文件输入出对')
    # product_size_range 直接控制产物大小（2026-10-04 增补）
    p3b = bio_ops.op_primer3_design({'sequence': f_tmpl, 'product_size_range': [90, 130],
                                     'gc_range': [40, 60], 'tm_range': [57, 63]})
    sizes = [p['product_size'] for p in p3b.get('pairs', [])]
    check(len(sizes) > 0 and all(90 <= s <= 130 for s in sizes),
          f'product_size_range 直接控制产物大小（{sizes}）')
    err = expect_error(lambda: bio_ops.op_primer3_design(
        {'sequence': f_tmpl, 'product_size_range': [130, 100]}))
    check(err is not None and '无效' in str(err), 'product_size_range 倒置区间拒绝')
else:
    print('  SKIP primer3 未安装（第二层按需依赖，不在核心测试范围）')

print()
print('ALL PASS' if FAILURES == 0 else f'{FAILURES} FAILURES')
sys.exit(0 if FAILURES == 0 else 1)
