# test_ml_pipeline.py — GN-3 ML 数据泄漏修复定向测试
# 运行：<genie-python> -I test/test_ml_pipeline.py
import sys
import os
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

import numpy as np
import pandas as pd

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILURES.append(name)


tmp = tempfile.mkdtemp(prefix="ml-leak-")
CSV = os.path.join(tmp, "data.csv")


def write_csv(n=200, n_feat=6, classification=True, with_group=False, group_size=10):
    rng = np.random.default_rng(0)
    X = rng.normal(size=(n, n_feat))
    X[:, 0] = np.arange(n)  # 首列 = 唯一行 id（仅用于边界探测）
    if classification:
        y = (X[:, 1] + rng.normal(scale=0.5, size=n) > 0).astype(int)
        # 制造一个只有 1 个样本的类别（用于小类别测试，可选）
    else:
        y = X[:, 1] * 2 + rng.normal(scale=0.5, size=n)
    df = pd.DataFrame(X, columns=[f"f{i}" for i in range(n_feat)])
    df["target"] = y
    if with_group:
        df["g"] = [f"grp{i // group_size}" for i in range(n)]
    df.to_csv(CSV, index=False)
    return df


def run(**kwargs):
    from ml_tools import op_ml_pipeline
    return op_ml_pipeline(dict(path=CSV, target="target", **kwargs))


# ── 1. 拟合数据边界：测试行绝不进入任何 fit（填补/标准化）───────────────────
print("[1] 训练/测试行边界：测试行不进入任何 fit（imputer/scaler）")
df = write_csv()
import sklearn.impute as si
import sklearn.preprocessing as spr
_orig = si.SimpleImputer
_orig_scaler = spr.StandardScaler
fit_snapshots = []
fit_medians = []
scaler_snapshots = []
scaler_means = []

class RecordingImputer(_orig):
    def fit(self, X, y=None):
        fit_snapshots.append(np.asarray(X).copy())
        result = super().fit(X, y)
        fit_medians.append(self.statistics_.copy())
        return result

class RecordingScaler(_orig_scaler):
    def fit(self, X, y=None, sample_weight=None):
        scaler_snapshots.append(np.asarray(X).copy())
        result = super().fit(X, y, sample_weight=sample_weight)
        scaler_means.append(self.mean_.copy())
        return result

si.SimpleImputer = RecordingImputer
spr.StandardScaler = RecordingScaler
try:
    res = run(seed=42)
finally:
    si.SimpleImputer = _orig
    spr.StandardScaler = _orig_scaler

check("返回成功", "error" not in res, res.get("error"))
check("split_policy 存在", "split_policy" in res)
check("policy_version v3", res.get("split_policy", {}).get("policy_version") == "genie.ml_pipeline.v3")

from sklearn.model_selection import train_test_split, StratifiedKFold
expected_train, expected_test = train_test_split(df.index.to_numpy(), test_size=0.2,
                                                 random_state=42, stratify=df['target'])
check("holdout 真实索引精确匹配", res['split_policy']['train_indices'] == expected_train.tolist()
      and res['split_policy']['test_indices'] == expected_test.tolist())
cv_expected = list(StratifiedKFold(n_splits=5, shuffle=True, random_state=42).split(
    expected_train, df.loc[expected_train, 'target']))
expected_fit = [set(expected_train[fit]) for fit, _ in cv_expected] + [set(expected_train)]
actual_fit = [{int(v) for v in s[:, 0]} for s in fit_snapshots]
check("每折/最终 imputer fit 索引精确匹配", actual_fit == expected_fit,
      f"actual={[len(s) for s in actual_fit]}")
check("每折 imputer 中位数只来自折内训练", all(
      np.allclose(fit_medians[i], np.nanmedian(df.loc[list(rows), [f'f{j}' for j in range(6)]], axis=0))
      for i, rows in enumerate(expected_fit)))
actual_scaler = [{int(v) for v in s[:, 0]} for s in scaler_snapshots]
check("每折/最终 scaler fit 索引精确匹配", actual_scaler == expected_fit)
check("每折 scaler 均值只来自对应折", all(
      np.allclose(scaler_means[i], scaler_snapshots[i].mean(axis=0))
      for i in range(len(expected_fit))))
check("各折验证与最终测试不进入 fit", all(
      actual_fit[i].isdisjoint(set(expected_train[val])) for i, (_, val) in enumerate(cv_expected))
      and set(expected_test).isdisjoint(set().union(*actual_fit)))

# 用固定 seed 重跑得到可复现的分割：验证 train/test 边界
print("[1b] 固定 seed 可复现 + 无泄漏（median 统计量来自训练集）")
res2 = run(seed=42)
res3 = run(seed=42)
res4 = run(seed=99)
check("同 seed 结果一致", res2["metrics"] == res3["metrics"],
      f"{res2['metrics']} vs {res3['metrics']}")
check("不同 seed 可能不同（或相同，不强制）", isinstance(res4["metrics"].get("accuracy", 0), float))

# ── 2. group_col：组不跨集合、group 列不进特征 ───────────────────────────────
print("[2] group_col：组隔离 + 不进特征")
write_csv(with_group=True, group_size=10)
res_g = run(seed=42, group_col="g")
check("group_col 成功", "error" not in res_g, res_g.get("error"))
sp = res_g["split_policy"]
check("split=group_shuffle", sp.get("split") == "group_shuffle", sp.get("split"))
check("train_groups + test_groups 记录", sp.get("train_groups") is not None and sp.get("test_groups") is not None)
check("组不跨集合（train+test 组数之和 = 总组数）",
      sp["train_groups"] + sp["test_groups"] == sp["n_groups"],
      f"{sp['train_groups']}+{sp['test_groups']} vs {sp['n_groups']}")
check("group 列不进特征", "g" not in res_g["features_used"], res_g["features_used"])
from sklearn.model_selection import GroupShuffleSplit, GroupKFold
df_g = pd.read_csv(CSV)
g_all = df_g['g'].to_numpy()
g_train, g_test = next(GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=42).split(
    df_g, df_g['target'], groups=g_all))
check("group holdout 索引精确匹配", sp['train_indices'] == g_train.tolist()
      and sp['test_indices'] == g_test.tolist())
g_folds = list(GroupKFold(n_splits=min(5, len(set(g_all[g_train])))).split(
    df_g.iloc[g_train], df_g['target'].iloc[g_train], groups=g_all[g_train]))
check("group CV 每折索引精确匹配", all(
      fold['train_indices'] == g_train[fi].tolist() and
      fold['validation_indices'] == g_train[vi].tolist()
      for fold, (fi, vi) in zip(res_g['cv']['folds'], g_folds)))
check("group CV 无跨组", all(set(g_all[fold['train_indices']]).isdisjoint(
      set(g_all[fold['validation_indices']])) for fold in res_g['cv']['folds']))

df_g['patient_id'] = np.arange(len(df_g))
df_g.to_csv(CSV, index=False)
res_ex = run(seed=42, group_col='g', exclude_cols=['patient_id'])
check("显式 ID 列不进入特征", 'patient_id' not in res_ex.get('features_used', []),
      res_ex.get('error'))

print("[2b] group 数不足 → 无法评估（不静默绕过）")
write_csv(with_group=True, group_size=1000)  # 2 组
# 强制只有 1 组
df1 = write_csv(n=50)
df1["g"] = "only"
df1.to_csv(CSV, index=False)
res_g1 = run(seed=42, group_col="g")
check("单组 → error（无法分组评估）", "error" in res_g1, res_g1.get("error"))
df_two = write_csv(n=20, with_group=True, group_size=10)
res_two = run(seed=42, group_col='g')
check("两组 holdout 后 CV 无法评估", res_two.get('code') == 'EVALUATION_UNAVAILABLE',
      res_two.get('error'))

# ── 3. 分类小类别 / 无有效特征 / 回归 ────────────────────────────────────────
print("[3] 分类小类别（某类 1 样本）→ 不可评估")
df_small = write_csv(n=50)
df_small.loc[0, "target"] = 2  # 制造 1 个样本的第 3 类
df_small.to_csv(CSV, index=False)
res_s = run(seed=42)
check("小类别拒绝普通随机降级", res_s.get("code") == "EVALUATION_UNAVAILABLE", res_s.get("error"))
res_s0 = run(seed=42, cv=0)
check("cv=0 时小类别仍不可评估", res_s0.get("code") == "EVALUATION_UNAVAILABLE", res_s0.get("error"))

print("[4] 回归路径")
write_csv(classification=False)
res_r = run(seed=42, task="regression", model="random_forest")
check("回归成功 + r2/rmse", "error" not in res_r and "r2" in res_r["metrics"], res_r.get("error"))
res_zero_cv = run(seed=42, task='regression', cv=0)
check("cv=0 明确关闭", res_zero_cv.get('cv', {}).get('cv') == 'disabled', res_zero_cv.get('error'))
df_one = write_csv(n=10, classification=False)
res_one = run(seed=42, task='regression', cv=0, test_size=0.1)
check("单行 holdout R2 为 null", res_one.get('metrics', {}).get('r2') is None
      and res_one.get('metrics', {}).get('r2_status') == 'not_estimable_single_test_row',
      res_one.get('error'))

print("[5] 无有效特征 → 明确错误")
df_bad = pd.DataFrame({"target": [0, 1, 0, 1]})
df_bad["note"] = ["a", "b", "c", "d"]  # 非数值列
df_bad.to_csv(CSV, index=False)
res_bad = run(seed=42)
check("无数值特征报错", "error" in res_bad, res_bad.get("error"))

with open(CSV, 'w', encoding='utf-8') as f:
    f.write('x,target,target\n1,0,1\n2,1,0\n')
res_dup = run(seed=42)
check("重复 target 物理表头拒绝", res_dup.get('code') == 'INPUT_INVALID', res_dup.get('error'))
df_missing = write_csv(n=50, with_group=True)
df_missing.loc[0, 'g'] = np.nan
df_missing.to_csv(CSV, index=False)
check("缺失 group 拒绝", run(group_col='g').get('code') == 'INPUT_INVALID')
df_missing = write_csv(n=50)
df_missing.loc[0, 'target'] = np.nan
df_missing.to_csv(CSV, index=False)
check("缺失 target 拒绝", run().get('code') == 'INPUT_INVALID')

print("[6] 全缺失特征在训练 Pipeline 内保留固定维度并记录")
df_m = write_csv(n=50)
df_m["f0"] = np.nan  # 全缺失
df_m.to_csv(CSV, index=False)
res_m = run(seed=42)
check("训练全缺失列明确记录且变换维度一致", "error" not in res_m
      and "f0" in res_m["split_policy"]["all_missing_in_train"]
      and res_m["n_transformed_features"] == len(res_m["features_used"]),
      res_m.get("error"))

print(f"\n{'=' * 60}")
print(f"GN-3 定向测试：{'ALL PASS' if not FAILURES else 'FAILED ' + str(len(FAILURES))}")
if FAILURES:
    print("失败项：", FAILURES)
    sys.exit(1)
sys.exit(0)
