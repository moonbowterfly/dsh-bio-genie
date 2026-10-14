#!/usr/bin/env python
"""lint_mutation_check.py — sabotage harness (v0.13): prove the gates kill violations.

Sections:
  BASELINES — pristine copy: packet_lint green, pattern_samples green (both sides),
              and the REGENERATION CHAIN closes byte-stably (make_meta ->
              make_schemas -> make_manifest -> lint; manifest hash unchanged).
  S — packet_lint sabotages (S1-S16): fresh copy, one violation injected, packet_lint
      must exit non-zero with the EXPECTED code.
  R — runner/matcher sabotages (R1-R7): regressions injected into the checkers
      themselves; the affected runner must go red.
        R1  Node wrapper -> bare .test()          (pattern_samples.mjs)
        R2  py max_len stripped                   (pattern_samples.py)
        R2b py fullmatch -> re.search             (pattern_samples.py)
        R3  py unicode gate stripped              (c14n corpus)
        R4  js unicode gate stripped              (c14n corpus)
        R5  unicode table whitespace tampered     (c14n corpus must fail REGISTRY_UNRESOLVED)
        R5b direct c14n.py CLI, same tamper       (must fail REGISTRY_UNRESOLVED)
        R5c direct c14n.mjs CLI, same tamper      (must fail REGISTRY_UNRESOLVED)
        R6  js matcher UTF-16 length regression   (schema corpus)
        R7  py matcher order regression           (schema corpus)

Requirements: node on PATH; AJV_WORKSPACE set (schema-corpus runs); child processes get
PYTHONUTF8/PYTHONIOENCODING/PYTHONDONTWRITEBYTECODE fixed internally (Windows ACP-safe).
Exit 0 only if every baseline passes and every sabotage is killed with its expected marker.
"""
import json
import os
import shutil
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
import tempfile

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from bundle_loader import bundle_root  # noqa: E402

PACKET = bundle_root()
CHILD_FIX = {"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"}


def child_env(extra=None):
    env = dict(os.environ)
    env.update(CHILD_FIX)
    if extra:
        env.update(extra)
    return env


def fresh_copy(workdir, n):
    dst = os.path.join(workdir, "copy_" + str(n))
    shutil.copytree(PACKET, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    return dst


def run_py(script, cwd, packet_root, extra_args=None):
    env = child_env({"PACKET_ROOT": packet_root})
    proc = subprocess.run(
        [sys.executable, script] + list(extra_args or []), cwd=cwd,
        capture_output=True, text=True, encoding="utf-8", timeout=300, env=env,
    )
    return proc.returncode, proc.stdout + proc.stderr


def run_node(script, cwd, packet_root, extra_args=None):
    env = child_env({"PACKET_ROOT": packet_root})
    proc = subprocess.run(
        ["node", script] + list(extra_args or []), cwd=cwd,
        capture_output=True, text=True, encoding="utf-8", timeout=300, env=env,
    )
    return proc.returncode, proc.stdout + proc.stderr


def run_lint(copy_dir):
    return run_py(os.path.join(copy_dir, "build", "packet_lint.py"), copy_dir, copy_dir)


def edit_file(path, old, new):
    with open(path, encoding="utf-8") as fh:
        s = fh.read()
    assert s.count(old) == 1, "anchor count %d in %s" % (s.count(old), path)
    s = s.replace(old, new)
    with open(path, "w", encoding="utf-8", newline=chr(10)) as fh:
        fh.write(s)


def edit_json(path, fn):
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    fn(doc)
    with open(path, "w", encoding="utf-8", newline=chr(10)) as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write(chr(10))


# ---------------- S section: lint sabotages ----------------

def s1_delete_file(c):
    os.remove(os.path.join(c, "schemas", "claim.json"))


def s2_corrupt_schema(c):
    with open(os.path.join(c, "schemas", "claim.json"), "a", encoding="utf-8") as fh:
        fh.write(" ")


def s3_corrupt_manifest(c):
    def flip(doc):
        for e in doc["files"]:
            if e["path"] == "schemas/genome_ref.json":
                e["sha256"] = ("0" if e["sha256"][0] != "0" else "1") + e["sha256"][1:]
    edit_json(os.path.join(c, "bundle.manifest.json"), flip)


def s4_duplicate_literal(c):
    def dup(doc):
        doc["patterns"]["sha256Hex"]["pattern"] = doc["patterns"]["bundlePath"]["pattern"]
    edit_json(os.path.join(c, "meta", "pattern-library.json"), dup)


def s5_nonmember_pattern(c):
    def add_pat(doc):
        doc["properties"]["claim_id"]["pattern"] = "^zz$"
    edit_json(os.path.join(c, "schemas", "claim.json"), add_pat)


def s6_format_keyword(c):
    def add_fmt(doc):
        doc["properties"]["claim_id"]["format"] = "email"
    edit_json(os.path.join(c, "schemas", "claim.json"), add_fmt)


def s7_missing_annotation(c):
    def strip(doc):
        stack = [doc]
        while stack:
            n = stack.pop()
            if isinstance(n, dict):
                if n.get("type") == "array" and "x-canonical" in n:
                    del n["x-canonical"]
                    return
                stack.extend(n.values())
            elif isinstance(n, list):
                stack.extend(n)
        raise AssertionError("no array annotation found to strip")
    edit_json(os.path.join(c, "schemas", "genome_ref.json"), strip)


def s7b_annotation_value(c):
    p = os.path.join(c, "schemas", "genome_ref.json")
    with open(p, encoding="utf-8") as fh:
        s = fh.read()
    old = '"x-canonical": "seq"'
    assert s.count(old) >= 1
    s = s.replace(old, '"x-canonical": "ordered"', 1)
    with open(p, "w", encoding="utf-8", newline=chr(10)) as fh:
        fh.write(s)


def s8_patterns_in_schema(c):
    def add_patterns(doc):
        doc["patterns"] = {}
    edit_json(os.path.join(c, "schemas", "claim.json"), add_patterns)


def s9_bad_id(c):
    def bad_id(doc):
        doc["$id"] = "bundle://schemas/not_claim.json"
    edit_json(os.path.join(c, "schemas", "claim.json"), bad_id)


def s10_remote_ref(c):
    def add_ref(doc):
        doc["properties"]["status"]["$ref"] = "http://example.com/x.json"
    edit_json(os.path.join(c, "schemas", "claim.json"), add_ref)


def s11_lib_defs_mismatch(c):
    def break_pair(doc):
        lit = doc["patterns"]["bundlePath"]["pattern"]
        doc["patterns"]["bundlePath"]["pattern"] = lit[:-1] + ("x" if not lit.endswith("x") else "y")
    edit_json(os.path.join(c, "meta", "pattern-library.json"), break_pair)


def s12_index_tamper(c):
    p = os.path.join(c, "HASHES")
    with open(p, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    done = False
    for i, l in enumerate(lines):
        if l.rstrip().endswith("README.md"):
            h = l.split()[0]
            lines[i] = ("0" if h[0] != "0" else "1") + h[1:] + l[len(h):]
            done = True
            break
    assert done, "no line to tamper"
    with open(p, "w", encoding="utf-8", newline=chr(10)) as fh:
        fh.write(chr(10).join(lines) + chr(10))


def s13_third_keyword(c):
    def add_kw(doc):
        doc["ts"]["keyword_registrations"].append({"keyword": "patterns", "schemaType": "object"})
    edit_json(os.path.join(c, "validator-init.json"), add_kw)


def s14_extra_file(c):
    p = os.path.join(c, "schemas", "zzz_extra.json")
    with open(p, "w", encoding="utf-8", newline=chr(10)) as fh:
        json.dump({"$schema": "http://json-schema.org/draft-07/schema#", "$id": "bundle://schemas/zzz_extra.json", "type": "object"}, fh)
        fh.write(chr(10))


def s15_missing_meta(c):
    os.remove(os.path.join(c, "meta", "x-canonical.meta.json"))


def s16_library_target_ref(c):
    def add_ref(doc):
        doc["properties"]["status"]["$ref"] = "bundle://meta/pattern-library.json#/patterns/canonicalDecimal"
    edit_json(os.path.join(c, "schemas", "claim.json"), add_ref)


S_JOBS = [
    ("S1_delete_file", s1_delete_file, "MANIFEST_MISSING_FILE"),
    ("S2_corrupt_schema", s2_corrupt_schema, "REGISTRY_UNRESOLVED"),
    ("S3_corrupt_manifest", s3_corrupt_manifest, "REGISTRY_UNRESOLVED"),
    ("S4_duplicate_literal", s4_duplicate_literal, "PATTERN_LIBRARY_AMBIGUOUS"),
    ("S5_nonmember_pattern", s5_nonmember_pattern, "PATTERN_NOT_IN_LIBRARY"),
    ("S6_format_keyword", s6_format_keyword, "FORMAT_FORBIDDEN"),
    ("S7_missing_annotation", s7_missing_annotation, "ARRAY_ANNOTATION_MISSING"),
    ("S7b_annotation_value", s7b_annotation_value, "ANNOTATION_VALUE_INVALID"),
    ("S8_patterns_in_schema", s8_patterns_in_schema, "PATTERNS_KEYWORD_OUTSIDE_LIBRARY"),
    ("S9_bad_id", s9_bad_id, "ID_MISMATCH"),
    ("S10_remote_ref", s10_remote_ref, "REF_FORM_INVALID"),
    ("S11_lib_defs_mismatch", s11_lib_defs_mismatch, "LIBRARY_SHAPE_INVALID"),
    ("S12_index_tamper", s12_index_tamper, "INDEX_MISMATCH"),
    ("S13_third_keyword", s13_third_keyword, "KEYWORD_REGISTRATION_INVALID"),
    ("S14_extra_file", s14_extra_file, "MANIFEST_EXTRA_FILE"),
    ("S15_missing_meta", s15_missing_meta, "MANIFEST_MISSING_FILE"),
    ("S16_library_target_ref", s16_library_target_ref, "REF_UNRESOLVED"),
]


# ---------------- R section: runner/matcher sabotages ----------------

def r1_node_bare_test(c):
    edit_file(os.path.join(c, "evidence", "pattern_samples.mjs"),
              're = new RegExp("^(?:" + lit + ")$", "u");',
              're = new RegExp(lit, "u");')


def r2_py_strip_maxlen(c):
    edit_file(os.path.join(c, "evidence", "pattern_samples.py"),
              'if len(s) > entry["max_len"]:',
              'if False:')


def r2b_py_search(c):
    edit_file(os.path.join(c, "evidence", "pattern_samples.py"),
              "return _re.fullmatch(lit, s) is not None",
              "return _re.search(lit, s) is not None")


def r3_py_gate_strip(c):
    edit_file(os.path.join(c, "impl", "c14n.py"),
              "if not _in_domain(cp):",
              "if False:")


def r4_js_gate_strip(c):
    edit_file(os.path.join(c, "impl", "c14n.mjs"),
              "if (!inDomain(cp)) {",
              "if (false) {")


def r5_table_tamper(c):
    p = os.path.join(c, "meta", "unicode-domain-table.json")
    with open(p, "a", encoding="utf-8") as fh:
        fh.write(" ")


def r6_js_order(c):
    edit_file(os.path.join(c, "schema-corpus", "run_schema_corpus.mjs"),
              '  if (!isAscii(s)) return "PATTERN_DOMAIN_VIOLATION";' + chr(10) + '  const scalarCount = [...s].length; // Unicode scalar values (astral-safe); equals s.length on the ASCII path' + chr(10) + '  if (scalarCount > entry.max_len) return "PATTERN_MAX_LEN";',
              '  const scalarCount = [...s].length; // Unicode scalar values (astral-safe); equals s.length on the ASCII path' + chr(10) + '  if (scalarCount > entry.max_len) return "PATTERN_MAX_LEN";' + chr(10) + '  if (!isAscii(s)) return "PATTERN_DOMAIN_VIOLATION";')


def r7_py_order(c):
    edit_file(os.path.join(c, "schema-corpus", "run_schema_corpus.py"),
              '    if not s.isascii():' + chr(10) + '        return "PATTERN_DOMAIN_VIOLATION"' + chr(10) + '    if len(s) > entry["max_len"]:' + chr(10) + '        return "PATTERN_MAX_LEN"',
              '    if len(s) > entry["max_len"]:' + chr(10) + '        return "PATTERN_MAX_LEN"' + chr(10) + '    if not s.isascii():' + chr(10) + '        return "PATTERN_DOMAIN_VIOLATION"')


# (name, fn, runner_rel_script, use_node, expected_marker_or_None, extra_args_or_None)
R_JOBS = [
    ("R1_node_bare_test", r1_node_bare_test, "evidence/pattern_samples.mjs", True, None, None),
    ("R2_py_strip_maxlen", r2_py_strip_maxlen, "evidence/pattern_samples.py", False, None, None),
    ("R2b_py_search", r2b_py_search, "evidence/pattern_samples.py", False, None, None),
    ("R3_py_gate_strip", r3_py_gate_strip, "corpus/run_corpus.py", False, None, None),
    ("R4_js_gate_strip", r4_js_gate_strip, "corpus/run_corpus.py", False, None, None),
    ("R5_table_tamper", r5_table_tamper, "corpus/run_corpus.py", False, "REGISTRY_UNRESOLVED", None),
    ("R5b_direct_py_cli", r5_table_tamper, "impl/c14n.py", False, "REGISTRY_UNRESOLVED", ["--batch", "corpus/c14n_cases.json", "--out", "cli_out_py.json"]),
    ("R5c_direct_js_cli", r5_table_tamper, "impl/c14n.mjs", True, "REGISTRY_UNRESOLVED", ["--batch", "corpus/c14n_cases.json", "--out", "cli_out_js.json"]),
    ("R6_js_order", r6_js_order, "schema-corpus/run_schema_corpus.py", False, "sem-code mismatch", None),
    ("R7_py_order", r7_py_order, "schema-corpus/run_schema_corpus.py", False, "sem-code mismatch", None),
]


def chain_check(workdir, n):
    """Regeneration chain must close byte-stably inside a fresh copy (K1/P0-1)."""
    copy_dir = fresh_copy(workdir, n)
    mpath = os.path.join(copy_dir, "bundle.manifest.json")
    with open(mpath, "rb") as fh:
        before = fh.read()
    import hashlib
    before_sha = hashlib.sha256(before).hexdigest()
    steps = [
        ("make_meta", os.path.join(copy_dir, "build", "make_meta.py")),
        ("make_schemas", os.path.join(copy_dir, "build", "make_schemas.py")),
        ("make_manifest", os.path.join(copy_dir, "build", "make_manifest.py")),
        ("make_index", os.path.join(copy_dir, "build", "make_index.py")),
    ]
    ok = True
    for name, script in steps:
        rc, out = run_py(script, copy_dir, copy_dir)
        if rc != 0:
            ok = False
            print("CHAIN FAIL: " + name + " rc=" + str(rc))
            print("  ", out[-400:].replace(chr(10), " | "))
    if ok:
        with open(mpath, "rb") as fh:
            after_sha = hashlib.sha256(fh.read()).hexdigest()
        if after_sha != before_sha:
            ok = False
            print("CHAIN FAIL: manifest hash changed by regeneration: %s -> %s" % (before_sha[:16], after_sha[:16]))
        else:
            rc, out = run_lint(copy_dir)
            if rc != 0:
                ok = False
                print("CHAIN FAIL: lint red after regeneration")
                print("  ", out[-400:].replace(chr(10), " | "))
            else:
                rc, out = run_py(os.path.join(copy_dir, "build", "check_compile.py"), copy_dir, copy_dir)
                if rc != 0:
                    ok = False
                    print("CHAIN FAIL: check_compile.py red after regeneration")
                    print("  ", out[-400:].replace(chr(10), " | "))
                rc, out = run_node(os.path.join(copy_dir, "build", "check_compile.mjs"), copy_dir, copy_dir)
                if rc != 0:
                    ok = False
                    print("CHAIN FAIL: check_compile.mjs red after regeneration")
                    print("  ", out[-400:].replace(chr(10), " | "))
    print("CHAIN regeneration (make_meta->make_schemas->make_manifest->lint): " + ("OK byte-stable" if ok else "FAILED"))
    return ok


def main():
    if not os.environ.get("AJV_WORKSPACE"):
        print("ERROR: AJV_WORKSPACE is not set (schema-corpus runs need the locked ajv workspace).")
        print("See locks/README.md; e.g. `npm ci` from locks/node and point AJV_WORKSPACE at that directory.")
        return 2
    print("sabotage harness against:", PACKET)
    workdir = tempfile.mkdtemp(prefix="packet-mutation-")
    fails = 0

    base = fresh_copy(workdir, 0)
    rc, out = run_lint(base)
    if rc == 0:
        print("BASELINE lint: PASS (green on pristine copy)")
    else:
        print("BASELINE lint: FAIL — pristine copy not green:")
        print(out)
        fails += 1
    rc, out = run_py(os.path.join(base, "evidence", "pattern_samples.py"), base, base)
    if rc == 0:
        print("BASELINE pattern_samples.py: PASS")
    else:
        print("BASELINE pattern_samples.py: FAIL")
        print(out[-800:])
        fails += 1
    rc, out = run_node(os.path.join(base, "evidence", "pattern_samples.mjs"), base, base)
    if rc == 0:
        print("BASELINE pattern_samples.mjs: PASS")
    else:
        print("BASELINE pattern_samples.mjs: FAIL")
        print(out[-800:])
        fails += 1
    rc, out = run_py(os.path.join(base, "impl", "c14n.py"), base, base, ["--batch", "corpus/c14n_cases.json", "--out", "cli_base_py.json"])
    if rc == 0:
        print("BASELINE direct CLI c14n.py: PASS")
    else:
        print("BASELINE direct CLI c14n.py: FAIL")
        print(out[-500:])
        fails += 1
    rc, out = run_node(os.path.join(base, "impl", "c14n.mjs"), base, base, ["--batch", "corpus/c14n_cases.json", "--out", "cli_base_js.json"])
    if rc == 0:
        print("BASELINE direct CLI c14n.mjs: PASS")
    else:
        print("BASELINE direct CLI c14n.mjs: FAIL")
        print(out[-500:])
        fails += 1
    if not chain_check(workdir, 99):
        fails += 1

    n = 100
    for name, fn, expect in S_JOBS:
        n += 1
        copy_dir = fresh_copy(workdir, n)
        fn(copy_dir)
        rc, out = run_lint(copy_dir)
        killed = (rc != 0) and (expect in out)
        if killed:
            print("KILLED  %-24s -> rc=%d code=%s" % (name, rc, expect))
        else:
            print("SURVIVED %-23s -> rc=%d expect=%s" % (name, rc, expect))
            print("  output:", out[:600].replace(chr(10), " | "))
            fails += 1

    for name, fn, script_rel, use_node, expect, extra_args in R_JOBS:
        n += 1
        copy_dir = fresh_copy(workdir, n)
        fn(copy_dir)
        script = os.path.join(copy_dir, script_rel)
        if use_node:
            rc, out = run_node(script, copy_dir, copy_dir, extra_args)
        else:
            rc, out = run_py(script, copy_dir, copy_dir, extra_args)
        killed = (rc != 0) and (expect is None or expect in out)
        if killed:
            print("KILLED  %-24s -> rc=%d %s" % (name, rc, ("marker=%s" % expect) if expect else "(mutated checker went red)"))
        else:
            print("SURVIVED %-23s -> rc=%d expect=%s" % (name, rc, expect))
            print("  output:", out[-400:].replace(chr(10), " | "))
            fails += 1

    total = len(S_JOBS) + len(R_JOBS)
    if fails == 0:
        print("MUTATION_SUITE: ALL KILLED (%d sabotages + chain + 5 baselines green)" % total)
    else:
        print("MUTATION_SUITE: %d FAILURES" % fails)
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
