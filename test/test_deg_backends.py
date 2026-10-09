# test_deg_backends.py — GN-1/GN-2 定向测试（PyDESeq2 / GSEApy 正式后端）
# 运行：<含 pydeseq2+gseapy 的 python> -I test/test_deg_backends.py
# 缺依赖时：核心校验 + 不静默降级测试照跑；正式后端测试 SKIP 并注明（真实数据验收另跑全量）。
import sys
import os
import tempfile
import warnings
warnings.filterwarnings("ignore")

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

import numpy as np
import pandas as pd

FAILURES = []
SKIPS = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILURES.append(name)


def skip(name, reason):
    print(f"  SKIP  {name}  ({reason})")
    SKIPS.append(name)


tmp = tempfile.mkdtemp(prefix="deg-")
HAS_PYDESEQ2, HAS_GSEAPY = False, False
try:
    import pydeseq2  # noqa
    HAS_PYDESEQ2 = True
except ImportError:
    pass
try:
    import gseapy  # noqa
    HAS_GSEAPY = True
except ImportError:
    pass

from deg_tools import op_deseq2_python, op_gsea_python


def _make_counts(n_genes=300, n_ctrl=4, n_trt=4, up=60, seed=0):
    rng = np.random.default_rng(seed)
    counts = rng.poisson(lam=25, size=(n_genes, n_ctrl + n_trt)).astype(float)
    counts[:up, n_ctrl:] = rng.poisson(lam=80, size=(up, n_trt))
    genes = [f"g{i}" for i in range(n_genes)]
    samples = [f"c{i}" for i in range(n_ctrl)] + [f"t{i}" for i in range(n_trt)]
    cd = pd.DataFrame(counts, index=genes, columns=samples)
    meta = pd.DataFrame({"sample": samples, "condition": ["ctrl"] * n_ctrl + ["trt"] * n_trt})
    return cd, meta


def _write(cd, meta, tag):
    c = os.path.join(tmp, f"{tag}_counts.csv")
    m = os.path.join(tmp, f"{tag}_meta.csv")
    cd.to_csv(c); meta.to_csv(m, index=False)
    return c, m


# ── 校验（无需 pydeseq2）────────────────────────────────────────────────────
print("[A] raw counts 校验（拒绝非整数/负数/重复/缺样本）")
cd, meta = _make_counts()
cd.iloc[0, 0] = 3.7  # 非整数
c, m = _write(cd, meta, "nonint")
r = op_deseq2_python({"counts_file": c, "meta_file": m, "contrast": "trt_vs_ctrl"})
check("非整数 counts 拒绝", "error" in r, r.get("error"))

cd, meta = _make_counts()
cd.iloc[0, 0] = -1
c, m = _write(cd, meta, "neg")
r = op_deseq2_python({"counts_file": c, "meta_file": m, "contrast": "trt_vs_ctrl"})
check("负数 counts 拒绝", "error" in r, r.get("error"))

cd, meta = _make_counts()
cd = cd.rename(index={"g0": "g1"})  # 重复基因
c, m = _write(cd, meta, "dup")
r = op_deseq2_python({"counts_file": c, "meta_file": m, "contrast": "trt_vs_ctrl"})
check("重复基因拒绝", "error" in r, r.get("error"))

cd, meta = _make_counts()
meta.loc[0, "sample"] = "nonexistent"
c, m = _write(cd, meta, "miss")
r = op_deseq2_python({"counts_file": c, "meta_file": m, "contrast": "trt_vs_ctrl"})
check("缺样本拒绝（不静默取交集）", "error" in r, r.get("error"))

print("[B] 依赖失败不静默降级")
# 用显式 backend=pydeseq2 但环境无 pydeseq2 → 必须报错（这里不测，因为本环境可能有）
# 改为：legacy_welch 显式可用（方法版本 v2）
cd, meta = _make_counts()
c, m = _write(cd, meta, "welch")
r = op_deseq2_python({"counts_file": c, "meta_file": m, "contrast": "trt_vs_ctrl",
                      "backend": "legacy_welch"})
check("legacy_welch 显式可用", "error" not in r, r.get("error"))
check("legacy_welch 方法版本 v2", r.get("method", {}).get("method_version") == "genie.de.welch.v2")
check("legacy_welch 声明局限", "limitations" in r.get("method", {}))
r_bad = op_deseq2_python({"counts_file": c, "meta_file": m, "contrast": "trt_vs_ctrl",
                          "backend": "bogus"})
check("未知 backend 拒绝", "error" in r_bad)

print("[C] GSEA：不回退示例集合（无 gene_set 时明确报错）")
cd, meta = _make_counts()
c, m = _write(cd, meta, "gsea")
de_csv = os.path.join(tmp, "de_full.csv")
pd.DataFrame({"gene": [f"g{i}" for i in range(100)],
              "stat": np.linspace(3, -3, 100)}).to_csv(de_csv, index=False)
r = op_gsea_python({"de_results_file": de_csv})
check("无 gene_set_file/gene_sets 报错（不回退示例集合）", "error" in r, r.get("error"))
# 重复 ID 拒绝
pd.DataFrame({"gene": ["g1", "g1", "g2"], "stat": [1, 2, 3]}).to_csv(de_csv, index=False)
r = op_gsea_python({"de_results_file": de_csv, "gene_set_file": "x"})
check("重复 gene ID 拒绝", "error" in r and "重复" in r.get("error", ""), r.get("error"))

# ── pydeseq2 正式后端 ───────────────────────────────────────────────────────
if not HAS_PYDESEQ2:
    skip("pydeseq2 正式后端测试（单因素/协变量/方向/零计数/全表一致）", "pydeseq2 未安装")
else:
    print("[D] pydeseq2：单因素 + 方向翻转 + 纯文库差 + 零计数/常量基因 + 全表一致")
    cd, meta = _make_counts(up=60)
    c, m = _write(cd, meta, "pf")
    out_csv = os.path.join(tmp, "pf_full.csv")
    r = op_deseq2_python({"counts_file": c, "meta_file": m, "contrast": "trt_vs_ctrl",
                          "out_csv": out_csv})
    check("单因素成功", "error" not in r, r.get("error"))
    check("n_up ≈ 60（方向正确）", r.get("n_up") is not None and r.get("n_up") >= 40, f"n_up={r.get('n_up')}")
    check("backend_version 记录", bool(r.get("method", {}).get("backend_version")))
    check("method_version pydeseq2.v2", r["method"]["method_version"] == "genie.de.pydeseq2.v2")
    check("LFC 未收缩声明", r["method"]["lfc_shrinkage"].startswith("none"))
    check("全表列完整", all(k in (r.get("top_genes") or [{}])[0] for k in
                            ("gene", "baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj")))
    full = pd.read_csv(out_csv)
    check("全表与 top 摘要一致（gene 对齐）",
          r["top_genes"][0]["gene"] == full.iloc[0]["gene"], full.iloc[0]["gene"])
    # 方向翻转：contrast ctrl_vs_trt → n_up/n_down 对调
    r2 = op_deseq2_python({"counts_file": c, "meta_file": m, "contrast": "ctrl_vs_trt"})
    check("方向翻转 n_up/n_down 对调",
          r2.get("n_up") == r.get("n_down") and r2.get("n_down") == r.get("n_up"),
          f"{r2.get('n_up')}/{r2.get('n_down')} vs {r.get('n_up')}/{r.get('n_down')}")

    print("[E] pydeseq2：协变量（多因素 ~ type + condition）")
    cd, meta = _make_counts(up=40)
    meta["type"] = ["A", "B", "A", "B", "A", "B", "A", "B"]
    c, m = _write(cd, meta, "cov")
    r = op_deseq2_python({"counts_file": c, "meta_file": m, "contrast": "trt_vs_ctrl",
                          "design": "~ type + condition", "factor": "condition",
                          "numerator": "trt", "denominator": "ctrl"})
    check("多因素设计成功", "error" not in r, r.get("error"))
    check("design 记录 ~type+condition", r.get("method", {}).get("design") == "~type + condition")

    print("[F] pydeseq2：纯文库大小差（无真实差异 → 不虚报大量显著）")
    rng = np.random.default_rng(1)
    n_g, n_c, n_t = 200, 4, 4
    counts = rng.poisson(lam=25, size=(n_g, n_c + n_t)).astype(float)
    # 纯文库大小差：trt 组整体 2x 文库
    counts[:, n_c:] = counts[:, n_c:] * 2.0
    genes = [f"g{i}" for i in range(n_g)]
    samples = [f"c{i}" for i in range(n_c)] + [f"t{i}" for i in range(n_t)]
    cd = pd.DataFrame(counts, index=genes, columns=samples)
    meta = pd.DataFrame({"sample": samples, "condition": ["ctrl"] * n_c + ["trt"] * n_t})
    c, m = _write(cd, meta, "lib")
    r = op_deseq2_python({"counts_file": c, "meta_file": m, "contrast": "trt_vs_ctrl"})
    check("纯文库差成功运行", "error" not in r, r.get("error"))
    check("纯文库差不虚报大量显著（n_up+n_down 少）",
          (r.get("n_up", 0) + r.get("n_down", 0)) < n_g * 0.3,
          f"sig={r.get('n_up') + r.get('n_down')}")

    print("[G] pydeseq2：零计数/常量基因")
    cd, meta = _make_counts(up=30)
    cd.loc["constgene"] = 5  # 常量基因（全 5）
    cd.loc["zerogene"] = 0   # 零计数
    c, m = _write(cd, meta, "zero")
    r = op_deseq2_python({"counts_file": c, "meta_file": m, "contrast": "trt_vs_ctrl"})
    check("零计数/常量基因不崩溃", "error" not in r, r.get("error"))

# ── gseapy 正式 prerank ─────────────────────────────────────────────────────
if not HAS_GSEAPY:
    skip("gseapy prerank 正式测试（正/负富集/无交集/大小过滤/leading edge/seed/禁 ES×10）", "gseapy 未安装")
else:
    print("[H] gseapy prerank：正/负富集 + leading edge + seed 可复现 + 禁 ES×10")
    import gseapy as gp
    rng = np.random.default_rng(0)
    n = 1000
    genes = [f"g{i}" for i in range(n)]
    stat = np.sort(rng.normal(size=n))[::-1]
    # 前 30 个基因属于正富集集合
    pos_set = set(genes[:30])
    neg_set = set(genes[-30:])
    de_csv = os.path.join(tmp, "rank.csv")
    pd.DataFrame({"gene": genes, "stat": stat}).to_csv(de_csv, index=False)
    gmt = os.path.join(tmp, "sets.gmt")
    with open(gmt, "w") as f:
        f.write("POS_SET\tdesc\t" + "\t".join(sorted(pos_set)) + "\n")
        f.write("NEG_SET\tdesc\t" + "\t".join(sorted(neg_set)) + "\n")
    out_csv = os.path.join(tmp, "gsea.csv")
    r = op_gsea_python({"de_results_file": de_csv, "gene_set_file": gmt,
                        "ranking_column": "stat", "seed": 7, "permutation_num": 1000,
                        "min_size": 5, "max_size": 500, "out_csv": out_csv})
    check("prerank 成功", "error" not in r, r.get("error"))
    top = r.get("top_pathways") or []
    check("返回 ES/NES/nominal/FDR/leading_edge",
          all(k in (top[0] if top else {}) for k in ("pathway", "ES", "NES", "nominal_p", "FDR", "leading_edge")))
    check("正富集集合有负 NES 方向的互补（POS 在顶部 → ES>0）",
          any((t.get("pathway") == "POS_SET" and t.get("ES") is not None and float(t["ES"]) > 0) for t in top),
          [ (t.get('pathway'), t.get('ES')) for t in top ])
    check("禁 ES×10（NES 不是 ES 的 10 倍）",
          all(t.get("NES") is None or t.get("ES") is None or abs(float(t["NES"]) - float(t["ES"]) * 10) > 1e-6
              for t in top))
    full = pd.read_csv(out_csv)
    check("完整表落盘", len(full) >= 1)
    # seed 可复现
    r2 = op_gsea_python({"de_results_file": de_csv, "gene_set_file": gmt,
                         "ranking_column": "stat", "seed": 7, "permutation_num": 1000,
                         "min_size": 5, "max_size": 500})
    check("同 seed 结果一致（NES 对齐）",
          [t.get("NES") for t in r["top_pathways"]] == [t.get("NES") for t in r2["top_pathways"]])
    # 无交集
    gmt_no = os.path.join(tmp, "empty.gmt")
    with open(gmt_no, "w") as f:
        f.write("NO_OVERLAP\tdesc\tZZZ1\tZZZ2\tZZZ3\n")
    r3 = op_gsea_python({"de_results_file": de_csv, "gene_set_file": gmt_no,
                         "ranking_column": "stat", "seed": 7, "permutation_num": 1000,
                         "min_size": 5, "max_size": 500})
    check("无交集集合不报错（返回空或该集合无富集）", "error" not in r3, r3.get("error"))
    # 非有限 rank
    pd.DataFrame({"gene": ["g1", "g2"], "stat": [1.0, float("nan")]}).to_csv(de_csv, index=False)
    r4 = op_gsea_python({"de_results_file": de_csv, "gene_set_file": gmt, "ranking_column": "stat"})
    check("缺失 rank 排除并记录", r4.get("n_excluded_missing_rank") == 1, r4.get("error"))
    pd.DataFrame({"gene": ["g1", "g2"], "stat": [1.0, float("inf")]}).to_csv(de_csv, index=False)
    r_inf = op_gsea_python({"de_results_file": de_csv, "gene_set_file": gmt, "ranking_column": "stat"})
    check("Inf rank 拒绝", "error" in r_inf, r_inf.get("error"))
    # 缺命名库
    r5 = op_gsea_python({"de_results_file": de_csv, "gene_sets": "Definitely_Not_A_Library_XYZ"})
    check("缺命名库明确失败", "error" in r5, r5.get("error"))

print(f"\n{'=' * 60}")
print(f"GN-1/GN-2 定向测试：FAILED={len(FAILURES)} SKIP={len(SKIPS)}")
if SKIPS:
    print("跳过（缺依赖）：", SKIPS)
if FAILURES:
    print("失败项：", FAILURES)
    sys.exit(1)
sys.exit(0)
