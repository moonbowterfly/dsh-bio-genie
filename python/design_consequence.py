#!/usr/bin/env python
"""design_consequence.py — design_consequence 工具（v0 核心链；B1 六工具之四）

职责（v0.1 §6.4 + v0.2 §5/§6.4）：
  把已注册、哈希绑定的 coupling_profile@1 施加到固定 GEM 上，产出 consequence_run@1
  （逐 claim_target 的 direction 与数值后果）。无 mode 参数；唯一跨层入口 = coupling_profile。

门禁（逐条 fail-closed；v0.1 §6.4 + v0.2 §8.1）：
  - model_ref 缺失/哈希不符/card 缺失 → BLOCKED
  - baseline infeasible/unbounded → NOT_RUN（返回 solver status；禁旧值/0 向量/NaN）
  - coupling rule 未命中 gene/reaction → NOT_RUN（禁猜映射）
  - strain 不匹配 → BLOCKED
  - 无定量耦合（qualitative_direction）→ NOT_RUN: NO_QUANTITATIVE_COUPLING
  - 任一声明场景失败（infeasible/unbounded/timeout/non-optimal）→ 相关 claim INDETERMINATE（禁止挑选剩余场景）
  - 未登记/哈希不符的工件引用 → INVALID_INPUT

数值策略（numeric_policy@1 v0）：FVA fraction=0.9999 / tolerance=1e-7 / direction_epsilon=0.001
  / crossing_flags_indeterminate（区间跨零 → indeterminate）。

用法（bridge/ops 模式）：
  echo '{"op":"design_consequence","args":{...}}' | python design_consequence.py
输出（B1 收口接线后）：扁平 C4 信封 + ok（validate/export 同形态，供 TS 提取）
  {"status": ..., "reason_code": ..., "artifact_refs": [...], "detail": ..., "ok": true,
   "envelope": {...}, "consequence_run": {...}}
门禁拒绝（BLOCKED/NOT_RUN/INVALID_INPUT 等 TOOL_STATES）→ exit 0 + ok:false（不误判为崩溃）；
unknown op / 坏 JSON → exit 2 + INVALID_INPUT。
"""
import copy
import hashlib
import json
import os
import sys
import traceback

sys.dont_write_bytecode = True

# ---- numeric policy v0 默认（若 args.numeric_policy 给出则以给定为准）----
NP_DEFAULT = {
    "fva_fraction_of_optimum": 0.9999,
    "tolerance": 1e-07,
    "direction_epsilon": "0.001",
    "near_zero_rule": "abs(value) < direction_epsilon => near_zero; no direction signal",
    "interval_zero_crossing_rule": "crossing_flags_indeterminate",
}

TOOL_STATES = ("OK", "BLOCKED", "NOT_RUN", "OUT_OF_DOMAIN", "DEPENDENCY_UNAVAILABLE", "INVALID_INPUT", "EXECUTION_ERROR")


class ToolError(Exception):
    def __init__(self, code, detail=""):
        super().__init__(code)
        self.code = code
        self.detail = detail


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _canonical_json(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_numeric_policy(path=None):
    if path:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
        return {
            "fva_fraction_of_optimum": doc.get("fva_fraction_of_optimum", NP_DEFAULT["fva_fraction_of_optimum"]),
            "tolerance": doc.get("tolerance", NP_DEFAULT["tolerance"]),
            "direction_epsilon": doc.get("direction_epsilon", NP_DEFAULT["direction_epsilon"]),
            "near_zero_rule": doc.get("near_zero_rule", NP_DEFAULT["near_zero_rule"]),
            "interval_zero_crossing_rule": doc.get("interval_zero_crossing_rule", NP_DEFAULT["interval_zero_crossing_rule"]),
            "policy_path": path,
        }
    return dict(NP_DEFAULT)


def load_model_ref(args):
    """读 SBML + 校验哈希 + card 检查。返回 (model, meta)。

    门禁：缺失/哈希不符/card 缺失 → BLOCKED。
    """
    import cobra

    sbml_path = args.get("sbml_path")
    expected = args.get("expected_sbml_sha256")
    card_path = args.get("card_path")
    if not sbml_path or not os.path.exists(sbml_path):
        raise ToolError("BLOCKED", "model_ref sbml 缺失：%s" % sbml_path)
    actual = _sha256_file(sbml_path)
    if expected and actual != expected:
        raise ToolError("INVALID_INPUT", "SBML 哈希不符：disk=%s expected=%s" % (actual[:16], str(expected)[:16]))
    if not card_path or not os.path.exists(card_path):
        raise ToolError("BLOCKED", "模型卡缺失（card_path 必需）：%s" % card_path)
    card_sha = _sha256_file(card_path)
    with open(card_path, encoding="utf-8") as fh:
        card = json.load(fh)
    model = cobra.io.read_sbml_model(sbml_path)
    # strain 匹配（v0：card 内声明的 model hash 与 SBML 比对，若给出）
    declared = None
    for key in ("model_sha256", "sbml_sha256", "model_hash"):
        if isinstance(card.get(key), str):
            declared = card.get(key)
            break
    strain_ok = True
    if declared and declared != actual:
        strain_ok = False
    meta = {
        "sbml_path": sbml_path,
        "sbml_sha256": actual,
        "card_path": card_path,
        "card_sha256": card_sha,
        "card_schema": card.get("schema_version") or card.get("schema") or "legacy_or_unknown",
        "declared_model_hash": declared,
        "strain_match": strain_ok,
        "solver_id": getattr(model, "solver", None).__class__.__name__ if getattr(model, "solver", None) is not None else None,
    }
    if not strain_ok:
        raise ToolError("BLOCKED", "strain 不匹配：card 声明 %s vs 实际 %s" % (str(declared)[:16], actual[:16]))
    return model, meta


def validate_coupling_profile(profile, model, host_ctx=None):
    """逐 rule 校验。返回 applied_rules（可直接施加的）或抛 ToolError。

    门禁：
      - profile 无 rules / 全部 rule 不可施加 → NO_QUANTITATIVE_COUPLING
      - rule 未命中 gene/reaction → 该 rule 记 problems（不猜映射）；全 miss → NOT_RUN
    """
    if not isinstance(profile, dict) or not isinstance(profile.get("rules"), list) or not profile["rules"]:
        raise ToolError("NOT_RUN", "NO_QUANTITATIVE_COUPLING: coupling_profile 无 rules")
    if profile.get("coupling_mode") == "qualitative_direction" or profile.get("mode") == "qualitative_direction":
        raise ToolError("NOT_RUN", "NO_QUANTITATIVE_COUPLING: qualitative_direction 不得驱动定量")
    applied = []
    problems = []
    reaction_ids = {r.id for r in model.reactions}
    gene_ids = {g.id for g in model.genes}
    for rule in profile["rules"]:
        rule_id = rule.get("rule_id") or "?"
        reaction_id = rule.get("reaction_id")
        if rule.get("reaction_direction") is not None and rule.get("operation") is None:
            problems.append({"rule_id": rule_id, "code": "RULE_SHAPE_INVALID"})
            continue
        if not reaction_id or reaction_id not in reaction_ids:
            problems.append({"rule_id": rule_id, "code": "REACTION_NOT_FOUND", "detail": reaction_id})
            continue
        # GPR proof 引用（v0：要求给出 gpr_proof_ref 或 source_gene_namespace 命中的 gene）
        src_gene = rule.get("source_gene_name")
        if src_gene and src_gene not in gene_ids:
            problems.append({"rule_id": rule_id, "code": "GENE_NOT_FOUND", "detail": src_gene})
            continue
        applied.append({
            "rule_id": rule_id,
            "reaction_id": reaction_id,
            "operation": rule.get("operation"),
            "baseline_bound": rule.get("baseline_bound"),
            "derived_bound": rule.get("derived_bound"),
            "unit": rule.get("unit"),
            "gpr_proof_ref": rule.get("gpr_proof_ref"),
        })
    if not applied:
        raise ToolError("NOT_RUN", "所有 coupling rule 均未命中（禁猜映射）：%s" % _canonical_json(problems)[:300])
    return applied, problems


def apply_rules(model, applied_rules):
    """深拷贝模型 → 施加 rules → 返回 (derived_model, canonical_diff, diff_hash)。不改原文件。"""
    derived = model.copy()
    changes = []
    for r in applied_rules:
        rid = r["reaction_id"]
        rxn = derived.reactions.get_by_id(rid)
        before = (rxn.lower_bound, rxn.upper_bound)
        op = r["operation"]
        if op == "set_upper_bound":
            rxn.upper_bound = float(r["derived_bound"])
        elif op == "set_lower_bound":
            rxn.lower_bound = float(r["derived_bound"])
        elif op == "scale_bound":
            factor = float(r["derived_bound"])
            rxn.lower_bound = rxn.lower_bound * factor
            rxn.upper_bound = rxn.upper_bound * factor
        else:
            raise ToolError("INVALID_INPUT", "未知 operation：%s" % op)
        changes.append({"reaction_id": rid, "lower_bound": rxn.lower_bound, "upper_bound": rxn.upper_bound,
                        "rule_id": r["rule_id"], "before": [before[0], before[1]]})
    changes.sort(key=lambda x: x["reaction_id"])
    canonical_diff = {"changes": changes}
    diff_hash = hashlib.sha256(_canonical_json(canonical_diff).encode("utf-8")).hexdigest()
    return derived, canonical_diff, diff_hash


def solve_baseline(model, medium, objective=None):
    """设置介质（显式 exchange bounds）→ FBA。返回 dict 或抛 ToolError(NOT_RUN)。"""
    for entry in medium or []:
        rid = entry.get("reaction_id")
        if rid not in {r.id for r in model.reactions}:
            raise ToolError("INVALID_INPUT", "medium 反应不存在：%s" % rid)
        rxn = model.reactions.get_by_id(rid)
        rxn.lower_bound = float(entry.get("lower_bound", rxn.lower_bound))
        rxn.upper_bound = float(entry.get("upper_bound", rxn.upper_bound))
    if objective:
        model.objective = objective
    sol = model.optimize()
    status = sol.status
    if status != "optimal":
        raise ToolError("NOT_RUN", "baseline solver status=%s（禁旧值/0 向量/NaN）" % status)
    return {
        "status": status,
        "objective_value": sol.objective_value,
        "objective_expression": str(model.objective.expression),
        "solver_id": type(model.solver).__name__,
    }


def fva_direction(model, reaction_ids, np_cfg):
    """FVA（fraction_of_optimum 来自 numeric policy）→ 区间与方向判定（近零/跨零规则）。"""
    from cobra.flux_analysis import flux_variability_analysis

    fva = flux_variability_analysis(
        model, reaction_list=reaction_ids,
        fraction_of_optimum=float(np_cfg["fva_fraction_of_optimum"]),
        processes=1,
    )
    eps = float(np_cfg["direction_epsilon"])
    out = {}
    for rid, row in fva.iterrows():
        lo, hi = float(row["minimum"]), float(row["maximum"])
        near_zero = abs(lo) < eps and abs(hi) < eps
        crossing = lo < 0 < hi
        if crossing:
            direction = "indeterminate" if np_cfg["interval_zero_crossing_rule"] == "crossing_flags_indeterminate" else "note"
        elif near_zero:
            direction = "near_zero"
        elif lo >= 0:
            direction = "increase"
        else:
            direction = "decrease"
        out[rid] = {"minimum": lo, "maximum": hi, "near_zero": near_zero, "zero_crossing": crossing, "direction": direction}
    return out


def op_design_consequence(args):
    """主入口（args 为 tool input）。返回 {'ok', 'envelope', 'consequence_run', ...}。"""
    np_cfg = load_numeric_policy(args.get("numeric_policy_path"))
    model, model_meta = load_model_ref(args)
    profile = args.get("coupling_profile")
    if not isinstance(profile, dict):
        raise ToolError("INVALID_INPUT", "coupling_profile 必须为对象（已注册工件值）")
    applied, problems = validate_coupling_profile(profile, model)
    baseline = solve_baseline(model, args.get("medium"), args.get("objective"))
    derived, canonical_diff, diff_hash = apply_rules(model, applied)

    scenarios = args.get("scenarios") or []
    if not scenarios:
        raise ToolError("INVALID_INPUT", "scenarios 不得为空（ROBUST_DIRECTION 需非空场景集）")
    scenario_results = []
    indeterminate_any = False
    for sc in scenarios:
        sc_id = sc.get("scenario_id") or "s0"
        sc_model = derived.copy()
        # 场景改动（v0：仅支持交换边界的显式修改，如 KO/OE 以边界表达）
        for entry in sc.get("modifications", []):
            rid = entry.get("reaction_id")
            if rid not in {r.id for r in sc_model.reactions}:
                scenario_results.append({"scenario_id": sc_id, "status": "INVALID_INPUT", "detail": "reaction %s" % rid})
                indeterminate_any = True
                continue
            rxn = sc_model.reactions.get_by_id(rid)
            if "lower_bound" in entry:
                rxn.lower_bound = float(entry["lower_bound"])
            if "upper_bound" in entry:
                rxn.upper_bound = float(entry["upper_bound"])
        try:
            sol = sc_model.optimize()
        except Exception as exc:  # noqa: BLE001
            scenario_results.append({"scenario_id": sc_id, "status": "EXECUTION_ERROR", "detail": str(exc)[:200]})
            indeterminate_any = True
            continue
        if sol.status != "optimal":
            scenario_results.append({"scenario_id": sc_id, "status": sol.status})
            indeterminate_any = True
            continue
        target = sc.get("target_reaction") or args.get("objective")
        fva = fva_direction(sc_model, [target], np_cfg) if target else {}
        scenario_results.append({
            "scenario_id": sc_id,
            "status": "optimal",
            "objective_value": sol.objective_value,
            "target_reaction": target,
            "target_fva": fva,
        })

    # claims（v0：单 claim_target = objective/growth）
    direction_status = "INDETERMINATE" if indeterminate_any else "SUPPORTED"
    consequence_run = {
        "artifact_type": "consequence_run@1",
        "model_meta": model_meta,
        "numeric_policy": {k: np_cfg[k] for k in ("fva_fraction_of_optimum", "tolerance", "direction_epsilon")},
        "baseline": baseline,
        "medium_applied": {
            "mode": "explicit" if args.get("medium") else "factory_default",
            "entries": len(args.get("medium") or []),
            "note": "factory_default = 未修改模型出厂 exchange 条件（非富培养基推断）" if not args.get("medium") else "explicit bounds 已应用",
        },
        "applied_rule_ids": [r["rule_id"] for r in applied],
        "rule_problems": problems,
        "canonical_model_diff": canonical_diff,
        "canonical_model_diff_hash": diff_hash,
        "scenarios": scenario_results,
        "claims": [{
            "claim_id": "consequence:objective",
            "classification": "INFERENCE",
            "status": direction_status,
            "claim_target": "growth",
            "limitations": ["v0 核心链：medium 由调用方显式给出；场景集与目标反应由声明给出"],
        }],
        "determinism_note": "canonical_model_diff 为改动集规范表示（v0）",
    }
    envelope = {
        "status": "OK" if not indeterminate_any else "NOT_RUN",
        "reason_code": None if not indeterminate_any else "SCENARIO_INDETERMINATE",
        "artifact_refs": [],
        "detail": None if not indeterminate_any else "部分场景非 optimal：相关 claim INDETERMINATE（禁止挑选剩余场景）",
    }
    return {"ok": True, "envelope": envelope, "consequence_run": consequence_run}


def _envelope(status, reason_code, detail, artifact_refs=None):
    """扁平 C4 信封（validate/export 同形态）：reason_code/detail 空值回落（照 design_host._envelope 约定）。"""
    return {
        "status": status,
        "reason_code": reason_code if reason_code else "OK",
        "artifact_refs": artifact_refs or [],
        "detail": detail or "",
    }


def _tool_error_envelope(exc):
    """ToolError → 扁平 C4 信封；reason_code 取 detail 前缀大写约定（照 design_host.main，B1P1）。"""
    status = exc.code if exc.code in TOOL_STATES else "EXECUTION_ERROR"
    detail = exc.detail or ""
    reason = status
    if detail:
        head, sep, tail = detail.partition(":")
        head = head.strip()
        if sep and head and all(ch.isupper() or ch == "_" for ch in head):
            reason = head
            detail = tail.strip()
    return _envelope(status, reason, detail)


def _stage_consequence_run(run):
    """consequence_run 落盘/引用（照 B1P1 artifacts 模式）：DSH_DESIGN_STAGING 非空时写
    <staging>/consequence_run.json 原始 JSON 字节 + sha256 引用（packet c14n/schema 适配留后续批次）。"""
    staging = os.environ.get("DSH_DESIGN_STAGING") or ""
    if not staging or not os.path.isdir(staging):
        return []
    raw = json.dumps(run, ensure_ascii=False).encode("utf-8")
    sha = hashlib.sha256(raw).hexdigest()
    with open(os.path.join(staging, "consequence_run.json"), "wb") as fh:
        fh.write(raw)
    return [{"artifact_id": sha, "expected_sha256": sha, "relative_path": "consequence_run.json"}]


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:  # noqa: BLE001
        env = _envelope("INVALID_INPUT", "BAD_REQUEST", "stdin JSON: %s" % exc)
        print(json.dumps(dict(env, ok=False), ensure_ascii=False))
        return 2
    op = payload.get("op")
    args = payload.get("args") or {}
    if op != "design_consequence":
        env = _envelope("INVALID_INPUT", "UNKNOWN_OP", "unknown op: %s" % op)
        print(json.dumps(dict(env, ok=False), ensure_ascii=False))
        return 2
    try:
        result = op_design_consequence(args)
        env = _envelope(result["envelope"]["status"], result["envelope"].get("reason_code"),
                        result["envelope"].get("detail"), _stage_consequence_run(result["consequence_run"]))
        # 扁平 C4 + ok 供 TS 提取（validate/export 同形态）；envelope 二级键保留（CLI 契约，test_cli_smoke）。
        out = dict(env, ok=bool(result.get("ok")), envelope=env, consequence_run=result["consequence_run"])
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except ToolError as exc:
        env = _tool_error_envelope(exc)
        print(json.dumps(dict(env, ok=False), ensure_ascii=False))
        return 0 if exc.code in TOOL_STATES else 1
    except Exception:  # noqa: BLE001
        env = _envelope("EXECUTION_ERROR", "WORKER_CRASH", traceback.format_exc()[-800:])
        print(json.dumps(dict(env, ok=False), ensure_ascii=False))
        return 0


if __name__ == "__main__":
    sys.exit(main())
