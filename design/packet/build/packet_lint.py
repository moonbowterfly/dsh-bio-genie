#!/usr/bin/env python
"""packet_lint.py — single executable authority for bundle/packet lint (v0.12).

Covers (stable codes):
  L1  FORMAT_FORBIDDEN                 no `format` keyword anywhere
  L2  UNEVALUATED_FORBIDDEN            no `unevaluatedProperties`
  L3  PATTERN_NOT_IN_LIBRARY           every `pattern` value is a library member (byte-equal)
  L4  PATTERN_LIBRARY_AMBIGUOUS        library literals pairwise distinct
  I2  LIBRARY_SHAPE_INVALID            entries exactly {pattern, match_mode, domain, max_len};
                                       match_mode=full, domain=ascii, max_len int>0;
                                       definitions-vs-library byte equality for shared names
  L5  ANNOTATION_VALUE_INVALID         x-canonical value in {set, seq}
  L6  DECIMAL_PAIRING_INVALID          x-decimal-string pairing (string + canonicalDecimal literal)
  L7  REF_FORM_INVALID                 $ref only absolute bundle:// or same-file #/ pointer
  L8  REF_UNRESOLVED / REF_ESCAPE      target must exist in bundle; no ../; no remote/meta-data targets
  L9  ID_MISMATCH                      bundle files: draft-07 $schema (schemas), $id == bundle://<path>
  L10 PATTERNS_KEYWORD_OUTSIDE_LIBRARY `patterns` key only in meta/pattern-library.json
  L12 ARRAY_ANNOTATION_MISSING         every non-fragment array carries x-canonical
  C7  OBJECT_ADDITIONAL_PROPS_MISSING  every non-fragment object carries additionalProperties
  L13 KEYWORD_REGISTRATION_INVALID     validator-init.json keyword_registrations == the two frozen keywords
  M*  loader/manifest problems (delegated to bundle_loader): MANIFEST_*/REGISTRY_UNRESOLVED
  IX  INDEX_MISMATCH                   HASHES / SHA256SUMS-packet.txt vs disk (when present)

Path handling: packet root = this file's parent's parent, or PACKET_ROOT env override.
Exit: 0 PASS | 1 violations | 2 internal error.
"""
import hashlib
import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from bundle_loader import bundle_root, load_bundle  # noqa: E402

DRAFT7 = "http://json-schema.org/draft-07/schema#"
EXPECTED_STEMS = [
    "genome_ref", "input_snapshot", "host_profile", "condition_card", "evidence_item",
    "circuit_design", "kinetic_crn_ref", "integration_candidate", "expression_scenario",
    "gem_card_raw", "metabolic_model_ref", "host_model_binding", "gpr_proof",
    "coupling_profile", "consequence_run", "tier_decision", "numeric_policy",
    "unit_vocabulary", "integration_ruleset", "provenance_dag", "claim",
    "tool_result", "case_manifest",
]
EXPECTED_META = ["common.defs.json", "x-canonical.meta.json", "pattern-library.json", "unicode-domain-table.json"]
LIBRARY_PATH = "meta/pattern-library.json"
FRAGMENT_KEYS = ("if", "then", "else", "not", "allOf", "anyOf", "oneOf")
FROZEN_KEYWORDS = {"x-canonical", "x-decimal-string"}


def sha256_file(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def walk_schemas(node, path, out, fragment=False):
    out.append((node, path, fragment))
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "properties" and isinstance(v, dict):
                for pk, pv in v.items():
                    walk_schemas(pv, path + "/properties/" + pk, out, fragment)
            elif k in ("items", "additionalProperties", "contains") and isinstance(v, dict):
                walk_schemas(v, path + "/" + k, out, fragment)
            elif k in FRAGMENT_KEYS:
                if isinstance(v, dict):
                    walk_schemas(v, path + "/" + k, out, True)
                elif isinstance(v, list):
                    for i, sub in enumerate(v):
                        walk_schemas(sub, path + "/" + k + "/" + str(i), out, True)
            elif k in ("definitions", "patternProperties") and isinstance(v, dict):
                for dk, dv in v.items():
                    walk_schemas(dv, path + "/" + k + "/" + dk, out, fragment)


def lint(packet=None):
    root = bundle_root(packet)
    problems = []

    def add(code, detail):
        problems.append((code, detail))

    docs, loader_problems = load_bundle(root)
    for p in loader_problems:
        code = p.split(" ", 1)[0]
        add(code, p.split(" ", 1)[1] if " " in p else p)

    schema_keys = sorted(k for k in docs if k.startswith("schemas/"))
    stems = [k[len("schemas/"):][: -len(".json")] for k in schema_keys]
    if sorted(stems) != sorted(EXPECTED_STEMS):
        add("STEMS_MISMATCH", "missing=" + str(sorted(set(EXPECTED_STEMS) - set(stems))) + " extra=" + str(sorted(set(stems) - set(EXPECTED_STEMS))))
    meta_keys = sorted(k[len("meta/"):] for k in docs if k.startswith("meta/"))
    if meta_keys and meta_keys != sorted(EXPECTED_META):
        add("STEMS_MISMATCH", "meta set=" + str(meta_keys) + " expected=" + str(sorted(EXPECTED_META)))

    common = docs.get("meta/common.defs.json")
    lib_doc = docs.get(LIBRARY_PATH)
    if common is None or lib_doc is None:
        add("IO_ERROR", "meta/common.defs.json or meta/pattern-library.json missing/unloadable")
        return problems

    if "patterns" in common:
        add("PATTERNS_KEYWORD_OUTSIDE_LIBRARY", "meta/common.defs.json")

    lib = lib_doc.get("patterns", {})
    lits = {}
    defs = common.get("definitions", {})
    for name, entry in lib.items():
        if not isinstance(entry, dict) or sorted(entry.keys()) != ["domain", "match_mode", "max_len", "pattern"]:
            add("LIBRARY_SHAPE_INVALID", name + " entry keys=" + str(sorted(entry.keys()) if isinstance(entry, dict) else type(entry).__name__))
            continue
        if entry.get("match_mode") != "full" or entry.get("domain") != "ascii" or not isinstance(entry.get("max_len"), int) or entry["max_len"] <= 0:
            add("LIBRARY_SHAPE_INVALID", name + " metadata=" + json.dumps({k: entry.get(k) for k in ("match_mode", "domain", "max_len")}))
        lit = entry.get("pattern")
        if lit in lits:
            add("PATTERN_LIBRARY_AMBIGUOUS", "duplicate literal for " + name + " vs " + lits[lit])
        lits[lit] = name
    for name, d in defs.items():
        if isinstance(d, dict) and isinstance(d.get("pattern"), str):
            if name not in lib or lib[name].get("pattern") != d["pattern"]:
                add("LIBRARY_SHAPE_INVALID", "definitions." + name + " pattern not backed by same-name library entry")
    lit_set = set(lits.keys())

    for rel, doc in docs.items():
        if rel == LIBRARY_PATH:
            continue
        if rel.startswith("schemas/"):
            if doc.get("$schema") != DRAFT7:
                add("ID_MISMATCH", rel + " missing draft-07 $schema")
        if doc.get("$id") != "bundle://" + rel:
            add("ID_MISMATCH", rel + " $id=" + str(doc.get("$id")) + " expected=bundle://" + rel)

        nodes = []
        walk_schemas(doc, rel, nodes)
        for node, path, fragment in nodes:
            if not isinstance(node, dict):
                continue
            for bad, code in (("format", "FORMAT_FORBIDDEN"), ("unevaluatedProperties", "UNEVALUATED_FORBIDDEN")):
                if bad in node:
                    add(code, path)
            if "patterns" in node and rel != LIBRARY_PATH:
                add("PATTERNS_KEYWORD_OUTSIDE_LIBRARY", path)
            ref = node.get("$ref")
            if isinstance(ref, str):
                if ref.startswith("#/"):
                    pass
                elif ref.startswith("bundle://"):
                    target = ref[len("bundle://"):].split("#")[0]
                    if ".." in target or "\\" in target:
                        add("REF_ESCAPE", path + " -> " + ref)
                    elif target.startswith("schemas/"):
                        tstem = target[len("schemas/"):]
                        tstem = tstem[: -len(".json")] if tstem.endswith(".json") else tstem
                        if tstem not in EXPECTED_STEMS:
                            add("REF_UNRESOLVED", path + " -> " + ref)
                    elif target == "meta/common.defs.json":
                        pass
                    else:
                        add("REF_UNRESOLVED", path + " -> " + ref + " (only meta/common.defs.json is a legal meta $ref target)")
                else:
                    add("REF_FORM_INVALID", path + " -> " + ref[:80])
            pat = node.get("pattern")
            if isinstance(pat, str) and pat not in lit_set:
                add("PATTERN_NOT_IN_LIBRARY", path + " -> " + pat[:60])
            if "x-decimal-string" in node:
                ok = (node.get("x-decimal-string") is True and node.get("type") == "string"
                      and node.get("pattern") == lib.get("canonicalDecimal", {}).get("pattern"))
                if not ok:
                    add("DECIMAL_PAIRING_INVALID", path)
            if not fragment:
                if node.get("type") == "array":
                    if "x-canonical" not in node:
                        add("ARRAY_ANNOTATION_MISSING", path)
                    elif node.get("x-canonical") not in ("set", "seq"):
                        add("ANNOTATION_VALUE_INVALID", path)
                if "x-canonical" in node and node.get("type") != "array":
                    add("ANNOTATION_VALUE_INVALID", path + " (x-canonical on non-array)")
                if node.get("type") == "object" and "additionalProperties" not in node:
                    add("OBJECT_ADDITIONAL_PROPS_MISSING", path)

    # L13: keyword registrations == the two frozen keywords (packet-level doc; soft requirement)
    vi_path = os.path.join(root, "validator-init.json")
    if os.path.exists(vi_path):
        try:
            vi = json.load(open(vi_path, encoding="utf-8"))
            regs = vi.get("ts", {}).get("keyword_registrations", [])
            names = sorted(r.get("keyword") for r in regs if isinstance(r, dict))
            if names != sorted(FROZEN_KEYWORDS):
                add("KEYWORD_REGISTRATION_INVALID", "keyword_registrations=" + str(names) + " expected=" + str(sorted(FROZEN_KEYWORDS)))
        except Exception as exc:  # noqa: BLE001
            add("IO_ERROR", "validator-init.json unparseable: " + str(exc)[:120])

    # index verification (HASHES / SHA256SUMS-packet.txt when present)
    exclude_names = {"HASHES", "SHA256SUMS-packet.txt"}
    disk_files = []
    for cur, dirs, fnames in os.walk(root):
        dirs[:] = [d for d in dirs if d != "__pycache__" and d != ".git"]
        for f in fnames:
            if f.endswith(".pyc") or f in exclude_names:
                continue
            disk_files.append(os.path.relpath(os.path.join(cur, f), root).replace(os.sep, "/"))
    disk_set = set(disk_files)
    for index_name in ("HASHES", "SHA256SUMS-packet.txt"):
        ip = os.path.join(root, index_name)
        if not os.path.exists(ip):
            continue
        entries = {}
        for line in open(ip, encoding="utf-8").read().splitlines():
            parts = line.strip().split(None, 1)
            if len(parts) == 2:
                rel = parts[1].lstrip("*").strip()
                if rel in exclude_names:
                    continue  # index files are self-instrumentation: excluded from set-equality, verified by their own self-hash/acceptance chain
                entries[rel] = parts[0]
        for rel in sorted(disk_set - set(entries.keys())):
            add("INDEX_MISMATCH", index_name + ": file not listed: " + rel)
        for rel in sorted(set(entries.keys()) - disk_set):
            add("INDEX_MISMATCH", index_name + ": listed but absent: " + rel)
        for rel, h in entries.items():
            p = os.path.join(root, rel)
            if os.path.exists(p) and sha256_file(p) != h:
                add("INDEX_MISMATCH", index_name + ": hash mismatch: " + rel)
    return problems


def main():
    root = bundle_root()
    mpath = os.path.join(root, "bundle.manifest.json")
    manifest_sha = sha256_file(mpath)[:16] if os.path.exists(mpath) else "MISSING"
    ipath = os.path.join(root, "SHA256SUMS-packet.txt")
    if os.path.exists(ipath):
        index_sha = "sums:" + sha256_file(ipath)[:12]
    else:
        hpath = os.path.join(root, "HASHES")
        index_sha = ("hashes:" + sha256_file(hpath)[:12]) if os.path.exists(hpath) else "(none)"
    print("[packet_lint] packet_root=" + root + " manifest_sha=" + manifest_sha + " index_sha=" + index_sha + " read-only: no packet writes")
    problems = lint(root)
    if not problems:
        print("PACKET_LINT: PASS (" + root + ")")
        return 0
    print("PACKET_LINT: FAIL (" + str(len(problems)) + " violations, " + root + ")")
    for code, detail in problems:
        print("  [" + code + "] " + detail)
    return 1


if __name__ == "__main__":
    sys.exit(main())
