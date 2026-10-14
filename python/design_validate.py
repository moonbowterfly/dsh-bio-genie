#!/usr/bin/env python
"""design_validate.py — production validateDesignArtifact（Python 侧；v4 §A0.3）

管线：verified packet load（index 全量集合 + packet bundle_loader）→ draft-07 schema
（jsonschema==4.26.0 + referencing registry）→ pattern matcher（domain 先行 + Unicode
标量计数 + full-match wrapper）/ DECIMAL_STRING scanner → c14n 层（lone surrogate /
冻结域 / NFC 键碰撞 / 数值域）。

与 TS 孪生（src/design-validate.js）语义等价——由 99 例等价性套件对 packet 冻结结果
逐项核验（test/design-validation.mjs）。

CLI：
  python design_validate.py --batch cases.json --out results.json
  python design_validate.py --type <stem> --value <file.json>
"""
import hashlib
import json
import math
import os
import re
import sys
import unicodedata

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
PACKET_DIR = os.environ.get("DSH_DESIGN_PACKET") or os.path.join(
    os.path.dirname(HERE), "design", "packet"
)
INDEX_NAME = "SHA256SUMS-packet.txt"
MAX_SAFE = 9007199254740991


def _sha256_file(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def load_packet_context(packet_dir=None):
    """verified packet load：index 全量集合 + extras 扫描 + bundle_loader。

    返回 (ctx, errors)；ctx 含 docs/validators/by_literal/ranges。
    """
    root = packet_dir or PACKET_DIR
    errs = []
    index_path = os.path.join(root, INDEX_NAME)
    if not os.path.exists(index_path):
        return None, [{"code": "PACKET_UNVERIFIED", "path": "$", "detail": "packet index missing"}]
    listed = {}
    with open(index_path, encoding="utf-8") as fh:
        for ln in fh.read().split("\n"):
            if not ln:
                continue
            if ln[64:66] != "  " or not re.fullmatch(r"[0-9a-f]{64}", ln[:64]):
                return None, [{"code": "PACKET_UNVERIFIED", "path": "$", "detail": "index line malformed"}]
            listed[ln[66:]] = ln[:64]
    for rel, want in listed.items():
        p = os.path.join(root, rel)
        if not os.path.exists(p):
            return None, [{"code": "PACKET_UNVERIFIED", "path": "$", "detail": "listed file missing: " + rel}]
        if _sha256_file(p) != want:
            return None, [{"code": "PACKET_UNVERIFIED", "path": "$", "detail": "hash mismatch: " + rel}]
    allowed = set(listed) | {INDEX_NAME}
    for cur, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in files:
            if f.endswith(".pyc"):
                continue
            rel = os.path.relpath(os.path.join(cur, f), root).replace(os.sep, "/")
            if rel not in allowed:
                return None, [{"code": "PACKET_UNVERIFIED", "path": "$", "detail": "unregistered extra file: " + rel}]
    sys.path.insert(0, os.path.join(root, "build"))
    try:
        from bundle_loader import load_bundle  # noqa: E402
        docs, problems = load_bundle(root)
    except Exception as exc:  # noqa: BLE001
        return None, [{"code": "PACKET_UNVERIFIED", "path": "$", "detail": "loader: " + str(exc)[:120]}]
    if problems:
        return None, [{"code": "PACKET_UNVERIFIED", "path": "$", "detail": "loader: " + problems[0]}]
    try:
        from jsonschema import Draft7Validator  # noqa: E402
        from referencing import Registry, Resource  # noqa: E402
        from referencing.jsonschema import DRAFT7  # noqa: E402
    except Exception as exc:  # noqa: BLE001
        return None, [{"code": "VALIDATOR_UNAVAILABLE", "path": "$", "detail": "jsonschema: " + str(exc)[:120]}]
    schemas = {k[len("schemas/"):][: -len(".json")]: docs[k] for k in docs if k.startswith("schemas/")}
    reg = Registry().with_resources(
        [("bundle://meta/common.defs.json", Resource.from_contents(docs["meta/common.defs.json"], default_specification=DRAFT7))]
        + [("bundle://schemas/" + s + ".json", Resource.from_contents(d, default_specification=DRAFT7)) for s, d in schemas.items()]
    )
    validators = {s: Draft7Validator(d, registry=reg) for s, d in schemas.items()}
    library = docs["meta/pattern-library.json"]["patterns"]
    by_literal = {entry["pattern"]: (name, entry) for name, entry in library.items()}
    ranges = [tuple(r) for r in docs["meta/unicode-domain-table.json"]["ranges"]]
    return {"docs": docs, "schemas": schemas, "validators": validators, "by_literal": by_literal, "ranges": ranges}, []


# ── 语义层（与 packet 语料运行器逐字一致；I1/K3 冻结语义）──────────────
def decimal_scan(s):
    if not isinstance(s, str):
        return False
    n = len(s)
    if n == 0:
        return False
    i = 0
    neg = False
    if s[0] == "-":
        neg = True
        i = 1
        if i >= n:
            return False
    if s[i] == "0":
        i += 1
        if i < n and "0" <= s[i] <= "9":
            return False
    elif "1" <= s[i] <= "9":
        i += 1
        while i < n and "0" <= s[i] <= "9":
            i += 1
    else:
        return False
    if i == n:
        if neg and s[1:i] == "0":
            return False
        return True
    if s[i] == ".":
        i += 1
        if i >= n:
            return False
        j = i
        while j < n and "0" <= s[j] <= "9":
            j += 1
        if j == i:
            return False
        if not ("1" <= s[j - 1] <= "9"):
            return False
        i = j
    return i == n


def fullmatch_wrapper(lit, s):
    return re.fullmatch(lit, s) is not None


def matcher(name, entry, s):
    if not s.isascii():
        return "PATTERN_DOMAIN_VIOLATION"
    if len(s) > entry["max_len"]:
        return "PATTERN_MAX_LEN"
    if name == "canonicalDecimal":
        if not decimal_scan(s):
            return "DECIMAL_STRING_NONCANONICAL"
        return None
    if not fullmatch_wrapper(entry["pattern"], s):
        return "PATTERN_MISMATCH"
    return None


def resolve_ref(docs, schemas, node):
    if not isinstance(node, dict):
        return node
    r = node.get("$ref")
    if isinstance(r, str):
        pre = "bundle://meta/common.defs.json#/definitions/"
        if r.startswith(pre):
            return docs["meta/common.defs.json"]["definitions"].get(r[len(pre):], node)
        pre2 = "bundle://schemas/"
        if r.startswith(pre2):
            t = r[len(pre2):].split("#")[0]
            stem = t[: -len(".json")] if t.endswith(".json") else t
            return schemas.get(stem, node)
    return node


def sem_errors(ctx, stem, doc):
    errs = []

    def walk(s, v, path):
        s = resolve_ref(ctx["docs"], ctx["schemas"], s)
        if not isinstance(s, dict):
            return
        if isinstance(v, str):
            if s.get("x-decimal-string") is True:
                entry = ctx["by_literal"].get(s.get("pattern"))
                if entry is None:
                    errs.append(("DECIMAL_PAIRING_INVALID", path))
                else:
                    code = matcher(entry[0], entry[1], v)
                    if code:
                        errs.append((code, path))
            else:
                pat = s.get("pattern")
                if isinstance(pat, str):
                    entry = ctx["by_literal"].get(pat)
                    if entry is None:
                        errs.append(("PATTERN_NOT_IN_LIBRARY", path))
                    else:
                        code = matcher(entry[0], entry[1], v)
                        if code:
                            errs.append((code, path))
        if isinstance(v, dict):
            props = s.get("properties") or {}
            for k, val in v.items():
                if k in props:
                    walk(props[k], val, path + "/" + k)
            ap = s.get("additionalProperties")
            if isinstance(ap, dict):
                for k, val in v.items():
                    if k not in props:
                        walk(ap, val, path + "/" + k)
        elif isinstance(v, list):
            it = s.get("items")
            if isinstance(it, dict):
                for i, val in enumerate(v):
                    walk(it, val, path + "/" + str(i))

    walk(ctx["schemas"][stem], doc, "")
    return errs


# ── c14n 层（lone surrogate / 冻结域 / NFC 键碰撞 / 数值域）──────────────
def c14n_layer(ranges, value):
    errs = []

    def in_domain(cp):
        lo, hi = 0, len(ranges) - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            s, e = ranges[mid]
            if cp < s:
                hi = mid - 1
            elif cp > e:
                lo = mid + 1
            else:
                return True
        return False

    def check_str(s, path):
        i = 0
        n = len(s)
        while i < n:
            c = ord(s[i])
            if 0xD800 <= c <= 0xDBFF:
                if i + 1 < n and 0xDC00 <= ord(s[i + 1]) <= 0xDFFF:
                    i += 2
                    continue
                errs.append(("LONE_SURROGATE", path))
                return
            if 0xDC00 <= c <= 0xDFFF:
                errs.append(("LONE_SURROGATE", path))
                return
            i += 1
        for ch in s:
            cp = ord(ch)
            if not in_domain(cp):
                errs.append(("UNICODE_OUT_OF_FROZEN_DOMAIN", path + " U+" + format(cp, "04X")))

    def walk(v, path):
        if isinstance(v, str):
            check_str(v, path)
            return
        if isinstance(v, bool):
            return
        if isinstance(v, int):
            if abs(v) > MAX_SAFE:
                errs.append(("NUMBER_OUT_OF_RANGE", path))
            return
        if isinstance(v, float):
            if math.isnan(v) or math.isinf(v) or abs(v) > MAX_SAFE:
                errs.append(("NUMBER_OUT_OF_RANGE", path))
            return
        if isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, path + "/" + str(i))
            return
        if isinstance(v, dict):
            seen = set()
            for k, val in v.items():
                check_str(k, path)
                nk = unicodedata.normalize("NFC", k)
                if nk in seen:
                    errs.append(("NFC_KEY_COLLISION", path + "/" + nk))
                seen.add(nk)
                walk(val, path + "/" + k)

    walk(value, "")
    return errs


def validate_artifact(artifact_type, value, packet_dir=None):
    """校验一个 design 工件。返回 dict（ok/engine/engine_errors/sem/c14n/errors）。"""
    ctx, errs0 = load_packet_context(packet_dir)
    if ctx is None:
        return {"ok": False, "artifact_type": artifact_type, "engine": False, "engine_errors": 0, "sem": [], "c14n": [], "errors": errs0}
    v = ctx["validators"].get(artifact_type)
    if v is None:
        return {"ok": False, "artifact_type": artifact_type, "engine": False, "engine_errors": 0, "sem": [], "c14n": [],
                "errors": [{"code": "UNKNOWN_ARTIFACT_TYPE", "path": "$", "detail": str(artifact_type)}]}
    eng_errs = list(v.iter_errors(value))
    engine_ok = len(eng_errs) == 0
    engine_errors = []
    if not engine_ok:
        for e in eng_errs[:20]:
            engine_errors.append({"code": "SCHEMA_VIOLATION", "path": "/" + "/".join(str(p) for p in e.path) if e.path else "$",
                                  "detail": str(e.validator)[:60]})
    sem = sem_errors(ctx, artifact_type, value)
    c14n = c14n_layer(ctx["ranges"], value)
    ok = engine_ok and len(sem) == 0 and len(c14n) == 0
    return {
        "ok": ok,
        "artifact_type": artifact_type,
        "engine": engine_ok,
        "engine_errors": len(eng_errs),
        "sem": [c + "@" + p for c, p in sem],
        "c14n": [c + "@" + p for c, p in c14n],
        "errors": engine_errors + [{"code": c, "path": p} for c, p in sem] + [{"code": c, "path": p} for c, p in c14n],
    }


def main():
    args = sys.argv[1:]
    if "--batch" in args:
        cases_path = args[args.index("--batch") + 1]
        out_path = args[args.index("--out") + 1]
        cases = json.load(open(cases_path, encoding="utf-8"))
        results = []
        for c in cases["cases"]:
            r = validate_artifact(c["schema"], c["doc"])
            results.append({
                "id": c["id"],
                "valid": r["ok"],
                "core_valid": r["engine"] and len(r["sem"]) == 0,
                "engine": r["engine"],
                "engine_errors": r["engine_errors"],
                "sem": r["sem"],
                "c14n": r["c14n"],
            })
        with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump({"side": "py-prod", "results": results}, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
        print("py-prod cases: %d" % len(results))
        return 0
    if "--type" in args:
        t = args[args.index("--type") + 1]
        f = args[args.index("--value") + 1]
        value = json.load(open(f, encoding="utf-8"))
        r = validate_artifact(t, value)
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return 0 if r["ok"] else 1
    print("usage: python design_validate.py --batch cases.json --out results.json | --type <stem> --value <file.json>")
    return 2


if __name__ == "__main__":
    sys.exit(main())
