#!/usr/bin/env python
"""run_schema_corpus.py — synbio-schema-corpus@1 dual-side verdict runner (v0.12).

Verdict per case = (pinned-engine schema validation, manifest-driven bundle)
                  AND (semantic layer):
                  - x-decimal-string nodes: DECIMAL_STRING scanner (I1) + entry max_len;
                  - other pattern nodes: explicit full-match wrapper + domain=ascii +
                    max_len, driven by the hit library entry (v0.12 K3).

Read-only: without --freeze nothing is written; the node side runs in place with
dependencies resolved via AJV_WORKSPACE (see locks/README.md; fail-closed if unset).
"""
import hashlib
import json
import os
import re
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "build"))
from bundle_loader import bundle_root, load_bundle  # noqa: E402

from jsonschema import Draft7Validator  # noqa: E402
from referencing import Registry, Resource  # noqa: E402
from referencing.jsonschema import DRAFT7  # noqa: E402

CASES = os.path.join(HERE, "schema_cases.json")
NODE_RUNNER = os.path.join(HERE, "run_schema_corpus.mjs")


# --- DECIMAL_STRING (identical to evidence/decimal_string_probe.py; I1 algorithm) ---
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
    """Explicit full-string semantics wrapper (v0.12 K3)."""
    return re.fullmatch(lit, s) is not None


def matcher(name, entry, s):
    """Combined matcher (v0.13, K3): ASCII domain gate FIRST, then max_len counted
    in Unicode scalar values, then matcher/scanner. Stable codes asserted cross-side."""
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


def fragment_guard(docs):
    frag_keys = ("allOf", "anyOf", "oneOf", "if", "then", "else", "not")
    bad = []

    def scan(node, in_frag, path):
        if isinstance(node, dict):
            for k, v in node.items():
                nf = in_frag or (k in frag_keys)
                if nf and k in ("pattern", "x-decimal-string"):
                    bad.append(path + "/" + k)
                scan(v, nf, path + "/" + k)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                scan(v, in_frag, path + "/" + str(i))

    for rel, doc in docs.items():
        if rel.startswith("schemas/"):
            scan(doc, False, rel)
    return bad


def resolve_ref(docs, node):
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
            return docs.get("schemas/" + t, node)
    return node


def sem_errors(docs, by_literal, stem, doc):
    errs = []

    def walk(s, v, path):
        s = resolve_ref(docs, s)
        if not isinstance(s, dict):
            return
        if isinstance(v, str):
            if s.get("x-decimal-string") is True:
                entry = by_literal.get(s.get("pattern"))
                if entry is None:
                    errs.append(("DECIMAL_PAIRING_INVALID", path))
                else:
                    code = matcher(entry[0], entry[1], v)
                    if code:
                        errs.append((code, path))
            else:
                pat = s.get("pattern")
                if isinstance(pat, str):
                    entry = by_literal.get(pat)
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

    walk(docs["schemas/" + stem + ".json"], doc, "")
    return errs


def main():
    freeze = "--freeze" in sys.argv
    root = bundle_root()
    mpath = os.path.join(root, "bundle.manifest.json")
    manifest_sha = hashlib.sha256(open(mpath, "rb").read()).hexdigest()[:16] if os.path.exists(mpath) else "MISSING"
    ipath = os.path.join(root, "SHA256SUMS-packet.txt")
    if os.path.exists(ipath):
        index_sha = "sums:" + hashlib.sha256(open(ipath, "rb").read()).hexdigest()[:12]
    else:
        hpath = os.path.join(root, "HASHES")
        index_sha = ("hashes:" + hashlib.sha256(open(hpath, "rb").read()).hexdigest()[:12]) if os.path.exists(hpath) else "(none)"
    print("[run_schema_corpus.py] packet_root=" + root + " manifest_sha=" + manifest_sha + " index_sha=" + index_sha + " read-only: no packet writes (results only with --freeze)")

    docs, problems = load_bundle(root)
    if problems:
        print("BUNDLE LOAD FAILED:")
        for p in problems:
            print("  [LOADER] " + p)
        return 1

    bad = fragment_guard(docs)
    if bad:
        print("FRAGMENT GUARD VIOLATION (pattern/decimal inside logical fragments):")
        for b in bad:
            print("  -", b)
        return 1

    library = docs["meta/pattern-library.json"]["patterns"]
    by_literal = {entry["pattern"]: (name, entry) for name, entry in library.items()}

    schemas = {k[len("schemas/"):][: -len(".json")]: docs[k] for k in docs if k.startswith("schemas/")}
    reg = Registry().with_resources(
        [("bundle://meta/common.defs.json", Resource.from_contents(docs["meta/common.defs.json"], default_specification=DRAFT7))]
        + [("bundle://schemas/" + s + ".json", Resource.from_contents(d, default_specification=DRAFT7)) for s, d in schemas.items()]
    )
    validators = {s: Draft7Validator(d, registry=reg) for s, d in schemas.items()}

    cases = json.load(open(CASES, encoding="utf-8"))
    py_results = []
    for c in cases["cases"]:
        eng_errs = list(validators[c["schema"]].iter_errors(c["doc"]))
        sem = sem_errors(docs, by_literal, c["schema"], c["doc"])
        valid = (len(eng_errs) == 0) and (len(sem) == 0)
        py_results.append({
            "id": c["id"],
            "valid": valid,
            "engine_errors": len(eng_errs),
            "sem": [x[0] + "@" + x[1] for x in sem],
        })

    ws = os.environ.get("AJV_WORKSPACE")
    if not ws:
        print("ERROR: AJV_WORKSPACE is not set.")
        print("Point it at a directory where the locked node dependencies were installed (npm ci from locks/node); see locks/README.md.")
        return 2
    env = dict(os.environ)
    env["AJV_WORKSPACE"] = ws
    env["PACKET_ROOT"] = root
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(
        ["node", NODE_RUNNER],
        cwd=HERE, capture_output=True, text=True, encoding="utf-8", timeout=600, env=env,
    )
    if proc.returncode != 0:
        print("NODE RUNNER FAILED rc=" + str(proc.returncode))
        print(proc.stderr[-2000:])
        return 1
    node_results = json.loads(proc.stdout)["results"]
    node_by_id = {r["id"]: r for r in node_results}

    fails = 0
    for c, pr in zip(cases["cases"], py_results):
        nr = node_by_id.get(c["id"])
        want = c["expect"] == "valid"
        problems = []
        if nr is None:
            problems.append("node result missing")
        else:
            if pr["valid"] != nr["valid"]:
                problems.append("verdict py=%s node=%s" % (pr["valid"], nr["valid"]))
            if pr["sem"] != nr["sem"]:
                problems.append("sem-code mismatch py=%s node=%s" % (pr["sem"], nr["sem"]))
        if pr["valid"] != want:
            problems.append("expect mismatch py=%s want=%s" % (pr["valid"], want))
        if problems:
            fails += 1
            print("FAIL %-8s | %s" % (c["id"], " ;; ".join(problems)))
    print("cases=%d fails=%d %s" % (len(cases["cases"]), fails, "ALL_PASS" if fails == 0 else "HAS_FAILURES"))
    if fails:
        return 1

    if freeze:
        with open(os.path.join(HERE, "results_schema_python.json"), "w", encoding="utf-8", newline=chr(10)) as fh:
            json.dump({"corpus": "synbio-schema-corpus", "version": 1, "side": "python", "results": py_results}, fh, ensure_ascii=False, indent=1)
            fh.write(chr(10))
        with open(os.path.join(HERE, "results_schema_node.json"), "w", encoding="utf-8", newline=chr(10)) as fh:
            json.dump({"corpus": "synbio-schema-corpus", "version": 1, "side": "node", "results": node_results}, fh, ensure_ascii=False, indent=1)
            fh.write(chr(10))
        for c in cases["cases"]:
            c["frozen"] = {"verdict": c["expect"], "python": True, "node": True}
        with open(CASES, "w", encoding="utf-8", newline=chr(10)) as fh:
            json.dump(cases, fh, ensure_ascii=False, indent=1)
            fh.write(chr(10))
        print("FROZEN: results + per-case frozen verdicts written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
