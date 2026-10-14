#!/usr/bin/env python
"""validate_unit_vocabulary.py — unit_vocabulary@1 v0 自校验（G-LOOP-20261015-UV-001）

两层校验：
  1. schema 校验：调用既有 packet 校验管线（python/design_validate.py 的
     validate_artifact，等价于 CLI `design_validate.py --type unit_vocabulary
     --value <file>`）；import 失败时回退为 subprocess 运行该 CLI 并把输出纳入结果。
  2. 一致性自测（本脚本实现）：
     - 所有 from/to/a/b 引用的 unit_id 必须存在于 units；
     - 每条 conversion 的 from/to 维度向量相等（多重集比较）；
     - factor 词法合法（冻结 canonicalDecimal 正则）+ 非零 + 无自转换；
     - 链式一致性抽查（Decimal 精确乘积核对，见 TRIANGLES）；
     - forbidden_mixes 与可换算性不矛盾（存在换算却列入禁止 → warning）；
     - unit_id / (from,to) / 禁止对唯一性，a != b，规模建议值核对。

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
ARTIFACT = os.path.join(REPO_ROOT, "design", "unit-vocabulary", "unit-vocabulary-v0.json")
PACKET_PY = os.path.join(REPO_ROOT, "python")
ARTIFACT_TYPE = "unit_vocabulary"

# 冻结 schema 的 canonicalDecimal 词法（pattern-library.json / unit_vocabulary.json）
FACTOR_RE = re.compile(r"^(0|-?(0\.[0-9]*[1-9]|[1-9][0-9]*(\.[0-9]*[1-9])?))$")

# 链式一致性抽查：factor[X] == factor[Y] * factor[Z]（键为 "<from>-><to>"）
TRIANGLES = [
    ("h->s", "h->min", "min->s"),
    ("d->s", "d->h", "h->s"),
    ("d->min", "d->h", "h->min"),
    ("ug->g", "ug->mg", "mg->g"),
    ("ug->kg", "ug->g", "g->kg"),
    ("mg->kg", "mg->g", "g->kg"),
    ("umol->mol", "umol->mmol", "mmol->mol"),
    ("nmol->mol", "nmol->umol", "umol->mol"),
    ("uL->L", "uL->mL", "mL->L"),
    ("L->uL", "L->mL", "mL->uL"),
    ("uM->M", "uM->mM", "mM->M"),
    ("nM->M", "nM->uM", "uM->M"),
    ("bp->Mb", "bp->kb", "kb->Mb"),
    ("Mb->bp", "Mb->kb", "kb->bp"),
    ("kDa->g", "kDa->Da", "Da->g"),
]

TARGETS = {"units": 35, "conversions": 40, "forbidden_mixes": 12}


def dim_of(unit):
    return sorted((d["base"], d["exponent"]) for d in unit["dimension"])


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
    errors, warnings = [], []

    try:
        with open(ARTIFACT, encoding="utf-8") as fh:
            doc = json.load(fh)
    except Exception as exc:
        print("FAIL")
        print("load error:", exc)
        return 1

    units = {u["unit_id"]: u for u in doc.get("units", [])}
    conversions = doc.get("conversions", [])
    forbidden = doc.get("forbidden_mixes", [])

    # ── 1) 既有 packet 校验管线 ──────────────────────────────────────────
    pipe_ok, summary = schema_check(doc)
    print("[schema] pipeline=%s ok=%s" % (summary.get("mode"), summary.get("ok")))
    if not pipe_ok:
        for k in ("engine_errors", "sem", "c14n", "errors", "error"):
            v = summary.get(k)
            if v:
                print("  pipeline detail (%s): %s" % (k, json.dumps(v, ensure_ascii=False)[:400]))
        errors.append("packet pipeline rejected artifact")

    # ── 2) 引用完整性 ────────────────────────────────────────────────────
    for c in conversions:
        if c["from"] not in units:
            errors.append("conversion %s->%s: unknown from unit '%s'" % (c["from"], c["to"], c["from"]))
        if c["to"] not in units:
            errors.append("conversion %s->%s: unknown to unit '%s'" % (c["from"], c["to"], c["to"]))
    for m in forbidden:
        if m["a"] not in units:
            errors.append("forbidden %s<->%s: unknown unit '%s'" % (m["a"], m["b"], m["a"]))
        if m["b"] not in units:
            errors.append("forbidden %s<->%s: unknown unit '%s'" % (m["a"], m["b"], m["b"]))

    # ── 3) 维度一致性 ────────────────────────────────────────────────────
    for c in conversions:
        if c["from"] in units and c["to"] in units:
            if dim_of(units[c["from"]]) != dim_of(units[c["to"]]):
                errors.append("dimension mismatch: %s->%s (%s != %s)"
                              % (c["from"], c["to"], dim_of(units[c["from"]]), dim_of(units[c["to"]])))

    # ── 4) factor 词法 + 非零 + 无自转换 ─────────────────────────────────
    conv_by_key = {}
    for c in conversions:
        f = c.get("factor")
        if not isinstance(f, str) or not FACTOR_RE.fullmatch(f):
            errors.append("factor lexical: %s->%s factor=%r" % (c["from"], c["to"], f))
            continue
        if Decimal(f) == 0:
            errors.append("factor zero: %s->%s" % (c["from"], c["to"]))
        if c["from"] == c["to"]:
            errors.append("self conversion: %s->%s" % (c["from"], c["to"]))
        if not c.get("note"):
            warnings.append("conversion %s->%s missing note (来源)" % (c["from"], c["to"]))
        key = "%s->%s" % (c["from"], c["to"])
        if key in conv_by_key:
            errors.append("duplicate conversion: %s" % key)
        conv_by_key[key] = Decimal(f)

    # ── 5) 链式三角核对 ──────────────────────────────────────────────────
    for target, leg1, leg2 in TRIANGLES:
        if target not in conv_by_key:
            warnings.append("triangle missing target: %s" % target)
            continue
        if leg1 not in conv_by_key or leg2 not in conv_by_key:
            warnings.append("triangle missing leg for %s" % target)
            continue
        want = conv_by_key[leg1] * conv_by_key[leg2]
        if conv_by_key[target] != want:
            errors.append("triangle mismatch: %s == %s != %s * %s (=%s)"
                          % (target, conv_by_key[target], leg1, leg2, want))

    # ── 6) forbidden_mixes 与可换算性不矛盾 ──────────────────────────────
    seen_pairs = set()
    for m in forbidden:
        if m["a"] == m["b"]:
            errors.append("forbidden self pair: %s" % m["a"])
        pair = frozenset((m["a"], m["b"]))
        if pair in seen_pairs:
            errors.append("duplicate forbidden pair: %s<->%s" % (m["a"], m["b"]))
        seen_pairs.add(pair)
        if m["a"] in units and m["b"] in units:
            convertible = ("%s->%s" % (m["a"], m["b"]) in conv_by_key
                           or "%s->%s" % (m["b"], m["a"]) in conv_by_key)
            if convertible:
                warnings.append("forbidden pair has an existing conversion (%s<->%s) — reason must "
                                "explain the conflict explicitly" % (m["a"], m["b"]))

    # ── 7) 唯一性与规模 ──────────────────────────────────────────────────
    if len(units) != len(doc.get("units", [])):
        errors.append("duplicate unit_id")
    for name, got in (("units", len(doc.get("units", []))),
                      ("conversions", len(conversions)),
                      ("forbidden_mixes", len(forbidden))):
        print("[count] %s = %d (target >= %d)" % (name, got, TARGETS[name]))
        if got < TARGETS[name]:
            warnings.append("%s below suggested target (%d < %d)" % (name, got, TARGETS[name]))

    for w in warnings:
        print("WARNING: %s" % w)
    for e in errors:
        print("ERROR: %s" % e)

    ok = pipe_ok and not errors
    print("RESULT: %s" % ("PASS" if ok else "FAIL"))
    if not ok:
        print("failures: %d error(s), %d warning(s)" % (len(errors), len(warnings)))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
