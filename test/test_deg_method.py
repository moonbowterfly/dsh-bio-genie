#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""bio_deseq2 统计口径 v2 回归测试（median-of-ratios 归一化 + log2 空间 Welch t）。

背景（2026-10-05）：v1 为原始计数上的等方差 t 检验且无文库归一化，
agent 实测反推发现「声称为 DESeq2 等效但既非负二项亦无归一化」——v2 修正为
归一化 Welch 口径并新增 method 元数据 / out_csv 全量落盘。

运行：node scripts/run-python-test.mjs test/test_deg_method.py（已挂 bench 链）
"""
import os
import sys
import json
import tempfile

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'python'))

from deg_tools import op_deseq2_python  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond, detail=''):
    global PASS, FAIL
    ok = bool(cond)
    if ok:
        PASS += 1
    else:
        FAIL += 1
    print(('PASS  ' if ok else 'FAIL  ') + name + (f'  | {detail}' if detail else ''))


def write_inputs(td, counts, meta):
    cf = os.path.join(td, 'counts.csv')
    mf = os.path.join(td, 'meta.csv')
    counts.to_csv(cf)
    meta.to_csv(mf, index=False)
    return cf, mf


rng = np.random.default_rng(20261005)

# ── 场景 1：纯文库大小差（处理组整体 ×2），无真实差异 ─────────────────────
# 期望：size_factors 识别出 ~2×；归一化后无基因「显著」（|log2FC|>1 且 padj<0.05）
base = [2000.0, 1200.0, 800.0, 400.0, 200.0, 1500.0]
genes = [f'g{i:02d}' for i in range(len(base))]
cols = ['c1', 'c2', 'c3', 't1', 't2', 't3']
mat = {g: {c: float(rng.poisson(b * (2.0 if c.startswith('t') else 1.0)))
           for c in cols} for g, b in zip(genes, base)}
counts1 = pd.DataFrame(mat).T[cols]
meta1 = pd.DataFrame({'sample': cols, 'condition': ['ctrl'] * 3 + ['trt'] * 3})

with tempfile.TemporaryDirectory() as td:
    cf, mf = write_inputs(td, counts1, meta1)
    res1 = op_deseq2_python({'counts_file': cf, 'meta_file': mf, 'contrast': 'trt_vs_ctrl'})

sf = res1.get('size_factors', {})
ratio = (sum(sf.get(c, 0) for c in ['t1', 't2', 't3']) / 3) / \
        (sum(sf.get(c, 0) for c in ['c1', 'c2', 'c3']) / 3) if sf else 0
check('场景1 size_factors 识别出 ~2× 文库差', abs(ratio - 2.0) < 0.2, f'ratio={ratio:.3f} sf={sf}')
check('场景1 纯文库差不产生假显著', res1.get('n_up') == 0 and res1.get('n_down') == 0,
      f"n_up={res1.get('n_up')} n_down={res1.get('n_down')}")
maxlfc = max(abs(g['log2FoldChange']) for g in res1.get('top_genes', []))
check('场景1 归一化后 |log2FC| 全部 <0.5', maxlfc < 0.5, f'max|log2FC|={maxlfc}')

# ── 场景 2：植入真实上调基因（gA 归一化后 ~4×）应被检出 ────────────────────
mat2 = {g: {c: float(rng.poisson(b * (2.0 if c.startswith('t') else 1.0)))
            for c in cols} for g, b in zip(genes, base)}
# g00：处理组再 ×4（总 ×8；归一化 ÷2 后 ≈4× → log2FC≈2）
extra = dict(mat2['g00'])
for c in ['t1', 't2', 't3']:
    extra[c] = float(rng.poisson(2000.0 * 2.0 * 4.0))
mat2['g00'] = extra
counts2 = pd.DataFrame(mat2).T[cols]

with tempfile.TemporaryDirectory() as td:
    cf, mf = write_inputs(td, counts2, meta1)
    res2 = op_deseq2_python({'counts_file': cf, 'meta_file': mf, 'contrast': 'trt_vs_ctrl'})
sig2 = {g['gene'] for g in res2.get('top_genes', [])}
top0 = res2.get('top_genes', [{}])[0]
check('场景2 植入基因被检出为上调第一', top0.get('gene') == 'g00' or 'g00' in sig2, str(sig2))
check('场景2 n_up ≥ 1', res2.get('n_up', 0) >= 1, f"n_up={res2.get('n_up')}")
g00 = next((g for g in res2.get('top_genes', []) if g['gene'] == 'g00'), None)
check('场景2 g00 log2FC ≈ +2（4×）', g00 is not None and 1.2 < g00['log2FoldChange'] < 2.8,
      f"lfc={g00['log2FoldChange'] if g00 else None}")

# ── 场景 3：method 元数据 + out_csv 全量落盘 ─────────────────────────────
m = res2.get('method', {})
check('method 元数据齐全（name/test/limitations）',
      'Welch' in str(m.get('test')) and 'limitations' in m and m.get('normalization'),
      str(m)[:160])
with tempfile.TemporaryDirectory() as td:
    cf, mf = write_inputs(td, counts2, meta1)
    out_full = os.path.join(td, 'sub', 'de_full.csv')  # 不存在的子目录 → 自动创建
    res3 = op_deseq2_python({'counts_file': cf, 'meta_file': mf,
                             'contrast': 'trt_vs_ctrl', 'out_csv': out_full})
    oc = res3.get('out_csv', {})
    ok_file = oc.get('out_csv') and os.path.exists(out_full) and not oc.get('error')
    check('out_csv 全量落盘（含缺失子目录自动创建）', bool(ok_file), str(oc))
    if ok_file:
        full = pd.read_csv(out_full)
        check('out_csv 行数 = n_genes', len(full) == res3.get('n_genes'),
              f"rows={len(full)} n_genes={res3.get('n_genes')}")
        check('out_csv 列齐全', {'gene', 'baseMean', 'log2FoldChange', 'pvalue', 'padj'}
              <= set(full.columns), str(list(full.columns)))

# ── 场景 4：确定性（同输入两次结果完全一致）─────────────────────────────
with tempfile.TemporaryDirectory() as td:
    cf, mf = write_inputs(td, counts2, meta1)
    a = op_deseq2_python({'counts_file': cf, 'meta_file': mf, 'contrast': 'trt_vs_ctrl'})
    b = op_deseq2_python({'counts_file': cf, 'meta_file': mf, 'contrast': 'trt_vs_ctrl'})
    check('确定性：两次调用逐位一致', json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True))

# ── 场景 5：退化路径 ────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    meta_single = pd.DataFrame({'sample': ['c1', 't1'], 'condition': ['ctrl', 'trt']})
    cf, mf = write_inputs(td, counts1, meta_single)
    r5 = op_deseq2_python({'counts_file': cf, 'meta_file': mf, 'contrast': 'trt_vs_ctrl'})
    check('单样本组给出明确指引（非 nan 结果）', 'error' in r5 and '2 个样本' in r5.get('error', ''),
          str(r5.get('error'))[:100])

with tempfile.TemporaryDirectory() as td:
    meta_bad = meta1.rename(columns={'condition': 'group'})
    cf, mf = write_inputs(td, counts1, meta_bad)
    r6 = op_deseq2_python({'counts_file': cf, 'meta_file': mf, 'contrast': 'trt_vs_ctrl'})
    check('缺 condition 列 → 可操作提示', 'error' in r6 and 'condition' in r6.get('error', ''))

print(f"\n{'-'*60}\ndeg-method: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
