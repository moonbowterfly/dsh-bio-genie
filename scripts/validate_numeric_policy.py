#!/usr/bin/env python
"""validate_numeric_policy.py — numeric_policy@1 v0 自校验（G-LOOP-20261015-NP-001）

两层校验：
  1. schema 校验：调用既有 packet 校验管线（python/design_validate.py 的
     validate_artifact，等价于 CLI `design_validate.py --type numeric_policy
     --value <file>`）；import 失败时回退为 subprocess 运行该 CLI 并把输出纳入结果。
  2. 语义自测（本脚本实现）：
     - artifact_type == numeric_policy@1；
     - fva_fraction_of_optimum ∈ [0, 1]；
     - tolerance > 0（number）；
     - direction_epsilon 词法合法（冻结 canonicalDecimal 正则独立实现）
       + 数值上严格大于 tolerance（方向阈值须高于求解器容差，语义自洽）；
     - solver.id / solver.version 非空字符串；
     - near_zero_rule 非空且 <= 1024 字符；
     - interval_zero_crossing_rule ∈ 冻结枚举。

独立可复跑：无参数；输出 PASS/FAIL + 失败明细；FAIL 时 exit 非零。
"""
import json
import os
import re
import subprocess
import sys
from decimal import Decimal

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
sys.dont_write_bytecode = True

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARTIFACT = os.path.join(REPO_ROOT, "design", "numeric-policy", "numeric-policy-v0.json")
PACKET_PY = os.path.join(REPO_ROOT, "python")
ARTIFACT_TYPE = "numeric_policy"

# 冻结 schema 的 canonicalDecimal 词法（numeric_policy.json direction_epsilon，
# pattern 与 pattern-library.json canonicalDecimal 一致；独立实现于本脚本）
CANONICAL_DECIMAL_RE = re.compile(r"^(0|-?(0\.[0-9]*[1-9]|[1-9][0-9]*(\.[0-9]*[1-9])?))$")

# 冻结枚举（numeric_policy.json interval_zero_crossing_rule）
CROSSING_ENUM = frozenset({"crossing_flags_indeterminate", "crossing_allowed_with_note"})

NEAR_ZERO_MAX_LEN = 1024


def schema_check(doc):
    """调用既有 packet 校验管线；返回 (ok, 摘要 dict)。"""
    sys.path.insert(0, PACKET_PY)
    try:
        import design_validate  # noqa: F401 — 既有管线（python/design_validate.py）
    except Exception as exc:  # pragma: no cover
        # 回退：以子进程运行 CLI，把输出纳入结果
        py = sys.executable
        cmd = [py, os.path.join(PACKET_PY, "design_validate.py"),
               "--type", ARTIFACT_TYPE, "--value", ARTIFACT]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
        except Exception as exc2:
            return False, {"mode": "cli", "error": str(exc2)}
        try:
            res = json.loads(proc.stdout)
        except Exception:
            return False, {"mode": "cli", "rc": proc.returncode,
                           "error": "unparseable pipeline output",
                           "stderr": (proc.stderr or "")[:500]}
        return bool(res.get("ok")), {"mode": "cli", "ok": res.get("ok"),
                                     "engine": res.get("engine"),
                                     "sem": res.get("sem"), "c14n": res.get("c14n")}
    res = design_validate.validate_artifact(ARTIFACT_TYPE, doc)
    return bool(res.get("ok")), {"mode": "import", "ok": res.get("ok"),
                                 "engine": res.get("engine"),
                                 "engine_errors": res.get("engine_errors"),
                                 "sem": res.get("sem", []),
                                 "c14n": res.get("c14n", []),
                                 "errors": res.get("errors", [])[:5]}


def main():
    errors = []

    try:
        with open(ARTIFACT, encoding="utf-8") as fh:
            doc = json.load(fh)
    except Exception as exc:
        print("FAIL")
        print("load error:", exc)
        return 1

    # ── 1) 既有 packet 校验管线 ──────────────────────────────────────────
    pipe_ok, summary = schema_check(doc)
    print("[schema] pipeline=%s ok=%s" % (summary.get("mode"), summary.get("ok")))
    if not pipe_ok:
        for k in ("engine_errors", "sem", "c14n", "errors", "error"):
            v = summary.get(k)
            if v:
                print("  pipeline detail (%s): %s" % (k, json.dumps(v, ensure_ascii=False)[:400]))
        errors.append("packet pipeline rejected artifact")

    # ── 2) 语义自测 ──────────────────────────────────────────────────────
    # 2.1 artifact_type 常量
    if doc.get("artifact_type") != "numeric_policy@1":
        errors.append("artifact_type = %r, expected 'numeric_policy@1'" % doc.get("artifact_type"))

    # 2.2 fva_fraction_of_optimum ∈ [0, 1]
    frac = doc.get("fva_fraction_of_optimum")
    if not isinstance(frac, (int, float)) or isinstance(frac, bool):
        errors.append("fva_fraction_of_optimum not a number: %r" % (frac,))
    else:
        if not (0.0 <= float(frac) <= 1.0):
            errors.append("fva_fraction_of_optimum out of [0,1]: %r" % (frac,))
        print("[value] fva_fraction_of_optimum = %s" % (frac,))

    # 2.3 tolerance > 0
    tol = doc.get("tolerance")
    if not isinstance(tol, (int, float)) or isinstance(tol, bool):
        errors.append("tolerance not a number: %r" % (tol,))
    else:
        if not float(tol) > 0.0:
            errors.append("tolerance <= 0: %r" % (tol,))
        print("[value] tolerance = %s" % (tol,))

    # 2.4 direction_epsilon 词法（canonicalDecimal 独立实现）+ 数值 > tolerance
    deps = doc.get("direction_epsilon")
    if not isinstance(deps, str):
        errors.append("direction_epsilon not a string: %r" % (deps,))
    else:
        if not CANONICAL_DECIMAL_RE.fullmatch(deps):
            errors.append("direction_epsilon lexical: %r fails canonicalDecimal" % (deps,))
        else:
            deps_dec = Decimal(deps)
            if deps_dec <= 0:
                errors.append("direction_epsilon <= 0: %r" % (deps,))
            elif isinstance(tol, (int, float)) and not isinstance(tol, bool):
                # 语义自洽：方向阈值必须严格大于求解器容差
                if deps_dec <= Decimal(str(float(tol))):
                    errors.append("direction_epsilon %s <= tolerance %s (方向阈值须高于容差)"
                                  % (deps, tol))
        print("[value] direction_epsilon = %s" % (deps,))

    # 2.5 solver.id / solver.version 非空
    solver = doc.get("solver")
    if not isinstance(solver, dict):
        errors.append("solver not an object: %r" % (solver,))
    else:
        for k in ("id", "version"):
            v = solver.get(k)
            if not isinstance(v, str) or not v:
                errors.append("solver.%s missing/empty: %r" % (k, v))
            else:
                print("[value] solver.%s = %s" % (k, v))

    # 2.6 near_zero_rule 非空且 <= 1024
    nz = doc.get("near_zero_rule")
    if not isinstance(nz, str) or not nz:
        errors.append("near_zero_rule missing/empty: %r" % (nz,))
    else:
        if len(nz) > NEAR_ZERO_MAX_LEN:
            errors.append("near_zero_rule too long: %d > %d" % (len(nz), NEAR_ZERO_MAX_LEN))
        print("[value] near_zero_rule len = %d (<= %d)" % (len(nz), NEAR_ZERO_MAX_LEN))

    # 2.7 interval_zero_crossing_rule 枚举
    rule = doc.get("interval_zero_crossing_rule")
    if rule not in CROSSING_ENUM:
        errors.append("interval_zero_crossing_rule = %r not in enum %s"
                      % (rule, sorted(CROSSING_ENUM)))
    else:
        print("[value] interval_zero_crossing_rule = %s" % (rule,))

    for e in errors:
        print("ERROR: %s" % e)

    ok = pipe_ok and not errors
    print("RESULT: %s" % ("PASS" if ok else "FAIL"))
    if not ok:
        print("failures: %d error(s)" % len(errors))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
