"""bio_sc_qc 验证测试（2026-09-16）。

构造**已知缺陷**的合成单细胞数据，验证 MAD 过滤确实把坏细胞滤掉：
  - 200 个正常细胞（中等计数、低 MT%）
  - 20 个"低质量"细胞（极低计数、极少基因数）
  - 20 个"高 MT"细胞（线粒体基因占比异常高）
断言：过滤后这三类缺陷细胞被清除、正常细胞保留，且图/h5ad 产物落盘。
"""
import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8') if hasattr(sys.stdout, 'reconfigure') else None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PY = os.path.join(os.path.expanduser('~'), '.dsh', 'dsh-bio-genie',
                  'python-env', 'Scripts', 'python.exe')
TMP = os.environ.get('LOCALAPPDATA', '') + '/Temp'
out = []


def log(s=''):
    out.append(str(s))
    try:
        print(s)
    except UnicodeEncodeError:
        print(str(s).encode('ascii', 'replace').decode('ascii'))


def run(op, args, timeout=600):
    p = subprocess.run([PY, '-I', os.path.join(ROOT, 'python', 'bio_ops.py')],
                       input=json.dumps({'op': op, 'args': args}).encode('utf-8'),
                       capture_output=True, timeout=timeout, cwd=ROOT)
    d = json.loads(p.stdout.decode('utf-8'))
    if not d.get('ok'):
        raise AssertionError(f'{op} 返回错误: {d.get("error")}')
    return d['result']


# ---------- 构造合成数据 ----------
log('=== 构造合成单细胞数据 ===')
import numpy as np
import anndata as ad
import scipy.sparse as sp
from anndata import AnnData

rng = np.random.default_rng(42)
N_NORMAL, N_LOWQ, N_HIGHMT = 200, 20, 20
N_GENES = 300
# 基因名：前 10 个是线粒体基因（human MT- 前缀），其余为普通基因
gene_names = [f'MT-{i}' for i in range(10)] + [f'GENE{i}' for i in range(N_GENES - 10)]
cell_types = ['normal'] * N_NORMAL + ['lowq'] * N_LOWQ + ['highmt'] * N_HIGHMT
n_cells = len(cell_types)

X = np.zeros((n_cells, N_GENES), dtype=np.float32)
for i, ct in enumerate(cell_types):
    if ct == 'normal':
        X[i, :] = rng.poisson(3.0, N_GENES)          # 中等表达
        X[i, :10] = rng.poisson(0.5, 10)             # 低 MT
    elif ct == 'lowq':
        X[i, :] = rng.poisson(0.05, N_GENES)         # 极低计数（~15 reads）
        X[i, 10: 10 + 40] = 0
    else:  # highmt
        X[i, :10] = rng.poisson(60, 10)              # MT 极高
        X[i, 10:] = rng.poisson(3.0, N_GENES - 10)

adata = AnnData(X=sp.csr_matrix(X))
adata.obs_names = [f'CELL{i:04d}' for i in range(n_cells)]
adata.var_names = gene_names
adata.obs['true_class'] = cell_types

in_path = os.path.join(TMP, 'sc_test_input.h5ad')
adata.write_h5ad(in_path)
log(f'  写出 {in_path}（{n_cells} 细胞 × {N_GENES} 基因）')
log(f'  预期缺陷：lowq {N_LOWQ} 个（低计数）、highmt {N_HIGHMT} 个（高 MT%）')
mt_idx = [i for i, g in enumerate(gene_names) if g.startswith('MT-')]
raw_mt = np.asarray(X[:, mt_idx].sum(axis=1)).ravel() / np.asarray(X.sum(axis=1)).ravel() * 100
log(f'  真实 MT%: normal≈{raw_mt[:N_NORMAL].mean():.1f}%  lowq≈{raw_mt[N_NORMAL:N_NORMAL+N_LOWQ].mean():.1f}%  '
    f'highmt≈{raw_mt[-N_HIGHMT:].mean():.1f}%')

# ---------- 运行质控 ----------
log()
log('=== 运行 bio_sc_qc ===')
r = run('sc_qc', {
    'input_file': in_path,
    'output_dir': os.path.join(TMP, 'sc_qc_out'),
    'species': 'human',
    'mad_counts': 5, 'mad_genes': 5, 'mad_mt': 3,
    'min_genes': 50,
    'make_plots': True,
})
log(f"  cells {r['cells_raw']} → {r['cells_after_filter']}（移除 {r['cells_removed']}，"
    f"保留率 {r['cells_retained_fraction']}）")
log(f"  过滤前中位数: counts={r['qc_before']['median_counts_per_cell']:.1f} "
    f"genes={r['qc_before']['median_genes_per_cell']:.1f} MT%={r['qc_before']['median_pct_mt']:.2f}")
log(f"  阈值: {r['thresholds']}")
log(f"  各条件淘汰数: {r['filter_breakdown']}")
log(f"  基因 过滤后={r['genes_after_filter']}（低检出移除 {r['genes_removed_low_detection']}）")

# ---------- 断言 ----------
log()
log('=== 断言 ===')
assert r['cells_raw'] == n_cells, f"输入细胞数应为 {n_cells}"
# ★ MT% 必须被正确计算（前缀识别生效）——若 species 前缀错，median_pct_mt 会是 0
assert r['qc_before']['median_pct_mt'] > 0.5, \
    f"MT% 中位数应 >0.5（线粒体基因已识别），实际 {r['qc_before']['median_pct_mt']}——前缀识别可能失效"
log(f"  ✔ 线粒体基因前缀识别生效（中位 MT% = {r['qc_before']['median_pct_mt']:.2f}）")
# 缺陷细胞必须被大量清除
assert r['cells_after_filter'] < n_cells, '应有细胞被过滤'
assert r['cells_retained_fraction'] > 0.7, \
    f"正常细胞应大部分保留，保留率仅 {r['cells_retained_fraction']}"
log(f"  ✔ 过滤生效且未误杀过多（保留 {r['cells_after_filter']}/{n_cells}）")
# 产物落盘
for key in ('filtered_file', 'with_qc_file', 'qc_figure', 'comparison_figure'):
    assert r.get(key) and os.path.exists(r[key]), f'{key} 未生成: {r.get(key)}'
    log(f"  ✔ {key}: {os.path.basename(r[key])} ({os.path.getsize(r[key])} B)")

# ---------- 核心验证：被滤掉的是不是真正的缺陷细胞 ----------
log()
log('=== 关键验证：过滤是否精准命中缺陷细胞 ===')
import anndata as ad2
wq = ad2.read_h5ad(r['with_qc_file'])
mask = wq.obs['qc_pass'].values
cls = wq.obs['true_class'].values
kept_normal = int(((cls == 'normal') & mask).sum())
kept_lowq = int(((cls == 'lowq') & mask).sum())
kept_highmt = int(((cls == 'highmt') & mask).sum())
log(f'  保留情况 → normal {kept_normal}/{N_NORMAL} | lowq {kept_lowq}/{N_LOWQ} | highmt {kept_highmt}/{N_HIGHMT}')
assert kept_normal >= int(N_NORMAL * 0.9), f'正常细胞应保留 ≥90%，实际 {kept_normal}/{N_NORMAL}'
assert kept_lowq <= int(N_LOWQ * 0.3), f'低质量细胞应大部分被滤，实际保留 {kept_lowq}/{N_LOWQ}'
assert kept_highmt <= int(N_HIGHMT * 0.5), f'高 MT 细胞应大部分被滤，实际保留 {kept_highmt}/{N_HIGHMT}'
log('  ✔ 低质量细胞与高 MT 细胞被精准滤除，正常细胞基本保留')

# 过滤后 h5ad 行数一致
f = ad2.read_h5ad(r['filtered_file'])
assert f.n_obs == r['cells_after_filter'], f"过滤后文件行数 {f.n_obs} ≠ 报告 {r['cells_after_filter']}"
log(f"  ✔ 过滤后 .h5ad 与报告一致（{f.n_obs} 细胞 × {f.n_vars} 基因）")

log()
log('全部断言通过 ✅')
open(os.path.join(TMP, 'sc-qc-test.txt'), 'w', encoding='utf-8').write('\n'.join(out))
print('ALL PASS')
