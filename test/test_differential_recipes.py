#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""differential_recipes 回归测试 — label_col 缺省回退（2026-10-05）。

背景（实测）：differential_plot 的 label_col=None 路径把 'name'
当默认列（`label_col or 'name'`），df 没有该列时直接 KeyError——agent 被迫
给 df 硬加一列 'name' 才能出图。修复后：'name' 仅在真实存在时才使用，
否则回退索引，且 _pick_labels / labels_arr 双侧一致。

运行：node scripts/run-python-test.mjs test/test_differential_recipes.py（已挂 bench 链）
"""
import os
import sys
import subprocess

if not sys.flags.isolated:
    raise SystemExit(subprocess.run([sys.executable, '-I', '-B', __file__, *sys.argv[1:]]).returncode)

import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'python'))

from figurelib.differential_recipes import differential_plot, _pick_labels  # noqa: E402

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


# 最小 df：无 'name' 列，index=基因名（agent 实际踩中场景）
df = pd.DataFrame({
    'log2FoldChange': [3.0, -2.2, 0.1, 0.2, -0.1],
    'pvalue': [1e-6, 1e-5, .5, .6, .7],
    'padj': [1e-5, 1e-4, .8, .9, .95],
    'baseMean': [100, 80, 50, 60, 70]},
    index=['geneA', 'geneB', 'geneC', 'geneD', 'geneE'])

# 1) _pick_labels：label_col='name' 但 df 无该列 → 回退索引匹配，不抛错
picked = _pick_labels(df, 'log2FoldChange', 'padj', 0.05, top_k=2,
                      user_labels=['geneA'], label_col='name')
check('_pick_labels 缺列时回退索引（不抛 KeyError）', 'geneA' in picked, str(sorted(picked)))

# 2) 完整 differential_plot：无 'name' 列应当直接出图（bug 原场景）
try:
    fig, ax, meta = differential_plot(
        df, effect_col='log2FoldChange', p_col='pvalue', padj_col='padj',
        base_mean_col='baseMean', mode='volcano', user_labels=['geneA', 'geneB'])
    ok = True
    check('differential_plot 无 name 列不再 KeyError', ok)
    check('meta 记录了标注基因', 'geneA' in meta.get('labeled', []), str(meta.get('labeled')))
    check('meta 记录 n_sig_up/down', meta.get('n_sig_up') == 1 and meta.get('n_sig_down') == 1,
          f"up={meta.get('n_sig_up')} down={meta.get('n_sig_down')}")
    check('meta 自动返回 layout_audit 和修正建议',
          isinstance(meta.get('layout_audit'), list) and isinstance(meta.get('layout_suggestions'), list))
    fig.canvas.draw()
    check('默认 legend 位于 axes 上方',
          ax.get_legend().get_window_extent(fig.canvas.get_renderer()).y0 > ax.bbox.y1)
    plt.close(fig)
except Exception as e:
    check('differential_plot 无 name 列不再 KeyError', False, f'{type(e).__name__}: {e}')

# 3) 有 'name' 列时仍优先用列（向后兼容）：user_labels 按列值匹配
df2 = df.copy()
df2['name'] = ['x1', 'x2', 'x3', 'x4', 'x5']
picked2 = _pick_labels(df2, 'log2FoldChange', 'padj', 0.05, top_k=2,
                       user_labels=['x2'], label_col='name')
check("'name' 列存在时仍按列值匹配（返回对应索引）", 'geneB' in picked2, str(sorted(picked2)))

# 4) 显式 label_col 指向缺失列 → 同样回退索引（防御性）
picked3 = _pick_labels(df, 'log2FoldChange', 'padj', 0.05, top_k=2,
                       user_labels=['geneD'], label_col='no_such_col')
check('显式缺列 label_col 也回退索引', 'geneD' in picked3, str(sorted(picked3)))

print(f"\n{'-'*60}\ndifferential-recipes: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
