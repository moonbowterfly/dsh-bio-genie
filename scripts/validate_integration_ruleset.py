#!/usr/bin/env python
"""validate_integration_ruleset.py — integration_ruleset@1 v0 自校验（G-LOOP-20261015-IR-001）

两层校验：
  1. schema 校验：调用既有 packet 校验管线（python/design_validate.py 的
     validate_artifact，等价于 CLI `design_validate.py --type integration_ruleset
     --value <file>`）；import 失败时回退为 subprocess 运行该 CLI 并把输出纳入结果。
  2. 语义自测（本脚本实现）：
     - artifact_type == integration_ruleset@1；
     - ruleset_id / version 非空字符串；
     - rules 非空数组；
     - rule_id 唯一；
     - kind ∈ 冻结枚举 {feature_overlap, repeat, essentiality, neighborhood, motif, other}；
     - mandatory 为布尔；
     - params 为对象；
     - description（若有）为字符串且 ≤ 1024 字符。

独立可复跑：无参数；输出 PASS/FAIL + 明细；FAIL 时 exit 非零。
"""
import json
import os
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
sys.dont_write_bytecode = True

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARTIFACT = os.path.join(REPO_ROOT, "design", "integration-ruleset", "integration-ruleset-v0.json")
PACKET_PY = os.path.join(REPO_ROOT, "python")
ARTIFACT_TYPE = "integration_ruleset"
ARTIFACT_TYPE_LITERAL = "integration_ruleset@1"

# 冻结 schema kind 枚举（design/packet/schemas/integration_ruleset.json）
KINDS = frozenset({"feature_overlap", "repeat", "essentiality", "neighborhood", "motif", "other"})

DESCRIPTION_MAX_LEN = 1024


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
    if doc.get("artifact_type") != ARTIFACT_TYPE_LITERAL:
        errors.append("artifact_type = %r, expected %r" % (doc.get("artifact_type"), ARTIFACT_TYPE_LITERAL))

    # 2.2 ruleset_id / version 非空字符串
    for k in ("ruleset_id", "version"):
        v = doc.get(k)
        if not isinstance(v, str) or not v:
            errors.append("%s missing/empty: %r" % (k, v))
        else:
            print("[value] %s = %s" % (k, v))

    # 2.3 rules 非空数组
    rules = doc.get("rules")
    if not isinstance(rules, list) or not rules:
        errors.append("rules missing/empty/not-list: %r" % (rules,))
        rules = []
    else:
        print("[value] rules count = %d" % len(rules))

    # 2.4 逐 rule：rule_id 唯一 / kind 枚举 / mandatory 布尔 / params 对象 / description ≤1024
    seen_ids = set()
    for i, rule in enumerate(rules):
        path = "rules[%d]" % i
        if not isinstance(rule, dict):
            errors.append("%s not an object: %r" % (path, rule))
            continue
        rid = rule.get("rule_id")
        if not isinstance(rid, str) or not rid:
            errors.append("%s.rule_id missing/empty: %r" % (path, rid))
            rid = None
        elif rid in seen_ids:
            errors.append("%s.rule_id duplicate: %r" % (path, rid))
        else:
            seen_ids.add(rid)

        kind = rule.get("kind")
        if kind not in KINDS:
            errors.append("%s.kind = %r not in enum %s" % (path, kind, sorted(KINDS)))

        mandatory = rule.get("mandatory")
        if not isinstance(mandatory, bool):
            errors.append("%s.mandatory not a boolean: %r" % (path, mandatory))

        params = rule.get("params")
        if not isinstance(params, dict):
            errors.append("%s.params not an object: %r" % (path, params))

        desc = rule.get("description")
        if desc is not None:
            if not isinstance(desc, str):
                errors.append("%s.description not a string: %r" % (path, desc))
            elif len(desc) > DESCRIPTION_MAX_LEN:
                errors.append("%s.description too long: %d > %d" % (path, len(desc), DESCRIPTION_MAX_LEN))
            else:
                print("[rule] %s kind=%s mandatory=%s params=%s desc_len=%d"
                      % (path, kind, mandatory, isinstance(params, dict),
                         len(desc) if isinstance(desc, str) else -1))
        else:
            print("[rule] %s kind=%s mandatory=%s params=%s desc=absent"
                  % (path, kind, mandatory, isinstance(params, dict)))

    for e in errors:
        print("ERROR: %s" % e)

    ok = pipe_ok and not errors
    print("RESULT: %s" % ("PASS" if ok else "FAIL"))
    if not ok:
        print("failures: %d error(s)" % len(errors))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
