#!/usr/bin/env python
"""make_schemas.py — orchestrate the 23-schema bundle generation + built-in checks.

Checks (first cut of the bundle lint; the full lint with manifest lands next):
  C1  exactly the 23 expected stems, F1.2 names
  C2  $id == bundle://schemas/<stem>.json ; $schema == draft-07
  C3  every $ref: absolute bundle://schemas|meta form (target must exist) or same-file #/ pointer
  C4  every `pattern` value byte-equal to a common.defs.json pattern literal
  C5  no `format` / `unevaluatedProperties` keywords
  C6  every array node carries x-canonical in {set, seq}; annotation only on arrays
  C7  every object node carries `additionalProperties`
  C8  x-decimal-string only on string nodes carrying the canonicalDecimal pattern
"""
import hashlib
import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from schema_helpers import DRAFT7, LIT, SCHEMAS_DIR  # noqa: E402
import schemas_a  # noqa: E402
import schemas_b  # noqa: E402
import schemas_c  # noqa: E402

EXPECTED = [
    "genome_ref", "input_snapshot", "host_profile", "condition_card", "evidence_item",
    "circuit_design", "kinetic_crn_ref", "integration_candidate", "expression_scenario",
    "gem_card_raw", "metabolic_model_ref", "host_model_binding", "gpr_proof",
    "coupling_profile", "consequence_run", "tier_decision", "numeric_policy",
    "unit_vocabulary", "integration_ruleset", "provenance_dag", "claim",
    "tool_result", "case_manifest",
]

META_FILES = {"common.defs.json", "x-canonical.meta.json"}


FRAGMENT_KEYS = ("if", "then", "else", "not", "allOf", "anyOf", "oneOf")


def walk_schemas(node, path, out, fragment=False):
    """Yield only schema-position nodes with a fragment flag.

    Fragments (if/then/else/not/allOf/anyOf/oneOf branches) are constraint
    fragments, not full schema nodes: instance-level requirements like
    `additionalProperties` and `x-canonical` must NOT be demanded there
    (adding them would corrupt the constraint semantics).
    """
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


def main():
    merged = {}
    for mod in (schemas_a, schemas_b, schemas_c):
        for stem, doc in mod.SCHEMAS.items():
            if stem in merged:
                raise SystemExit("duplicate stem: " + stem)
            merged[stem] = doc

    problems = []
    if sorted(merged.keys()) != sorted(EXPECTED):
        problems.append("C1 stems mismatch: missing=" + str(sorted(set(EXPECTED) - set(merged))) + " extra=" + str(sorted(set(merged) - set(EXPECTED))))

    os.makedirs(SCHEMAS_DIR, exist_ok=True)
    lits = set(LIT.values())
    total = 0
    for stem in EXPECTED:
        doc = merged[stem]
        if doc.get("$id") != "bundle://schemas/" + stem + ".json":
            problems.append("C2 bad $id: " + stem + " -> " + str(doc.get("$id")))
        if doc.get("$schema") != DRAFT7:
            problems.append("C2 bad $schema: " + stem)

        nodes = []
        walk_schemas(doc, stem, nodes)
        for node, path, fragment in nodes:
            if not isinstance(node, dict):
                continue
            ref = node.get("$ref")
            if isinstance(ref, str):
                if ref.startswith("#/"):
                    pass
                elif ref.startswith("bundle://schemas/"):
                    target = ref[len("bundle://schemas/"):].split("#")[0]
                    tstem = target[:-len(".json")] if target.endswith(".json") else target
                    if tstem not in EXPECTED:
                        problems.append("C3 unresolved schema ref: " + path + " -> " + ref)
                elif ref.startswith("bundle://meta/"):
                    target = ref[len("bundle://meta/"):].split("#")[0]
                    if target not in META_FILES:
                        problems.append("C3 unresolved meta ref: " + path + " -> " + ref)
                else:
                    problems.append("C3 illegal ref form: " + path + " -> " + ref)
            pat = node.get("pattern")
            if isinstance(pat, str) and pat not in lits:
                problems.append("C4 pattern not in library: " + path + " -> " + pat[:60])
            for bad in ("format", "unevaluatedProperties"):
                if bad in node:
                    problems.append("C5 forbidden keyword " + bad + ": " + path)
            if not fragment:
                if node.get("type") == "array":
                    if "x-canonical" not in node:
                        problems.append("C6 array without x-canonical: " + path)
                    elif node.get("x-canonical") not in ("set", "seq"):
                        problems.append("C6 bad x-canonical value: " + path)
                if "x-canonical" in node and node.get("type") != "array":
                    problems.append("C6 x-canonical on non-array: " + path)
                if node.get("type") == "object":
                    if "additionalProperties" not in node:
                        problems.append("C7 object without additionalProperties: " + path)
            else:
                if "x-canonical" in node and node.get("type") != "array":
                    problems.append("C6 x-canonical on non-array (fragment): " + path)
            if "x-decimal-string" in node:
                if node.get("x-decimal-string") is not True or node.get("type") != "string" or node.get("pattern") != LIT["canonicalDecimal"]:
                    problems.append("C8 bad decimal node: " + path)

        out = os.path.join(SCHEMAS_DIR, stem + ".json")
        with open(out, "w", encoding="utf-8", newline=chr(10)) as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=2)
            fh.write(chr(10))
        raw = open(out, "rb").read()
        total += len(raw)
        print("%-24s %7d B  sha256=%s" % (stem + ".json", len(raw), hashlib.sha256(raw).hexdigest()[:16]))

    print()
    print("files: %d / bytes: %d" % (len(EXPECTED), total))
    if problems:
        print("PROBLEMS (%d):" % len(problems))
        for p in problems:
            print("  -", p)
        return 1
    print("ALL CHECKS PASS (C1-C8)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
