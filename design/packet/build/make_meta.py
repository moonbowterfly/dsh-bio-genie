#!/usr/bin/env python
"""make_meta.py — generate meta/common.defs.json + meta/pattern-library.json (v0.12 K1).

- common.defs.json: pure draft-07 Schema ($schema/$id/title/definitions). NO root
  `patterns` key -> compiles under strict ajv with only the two frozen extension
  keywords; no third keyword registration anywhere.
- pattern-library.json: independent, hash-bound, NON-schema metadata resource carrying
  the pattern map. Must never be compiled by any validator (v0.12 K1).

Zero-backslash source (escaped dots built via chr(92)).
"""
import json
import os
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
META = os.path.join(os.path.dirname(HERE), "meta")
BS = chr(92)  # backslash
CARET = chr(94)
DOLLAR = chr(36)

DRAFT7 = "http://json-schema.org/draft-07/schema#"

LIT = {
    "canonicalDecimal": CARET + "(0|-?(0" + BS + ".[0-9]*[1-9]|[1-9][0-9]*(" + BS + ".[0-9]*[1-9])?))" + DOLLAR,
    "sha256Hex": CARET + "[0-9a-f]{64}" + DOLLAR,
    "jsonPointer": CARET + "(?:/(?:[^~/]|~0|~1)*)*" + DOLLAR,
    "bundlePath": CARET + "bundle://[A-Za-z0-9_./-]+" + DOLLAR,
    "isoTimestamp": CARET + "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z" + DOLLAR,
}

MAXLEN = {
    "canonicalDecimal": 320,
    "sha256Hex": 64,
    "jsonPointer": 2048,
    "bundlePath": 512,
    "isoTimestamp": 20,
}

def_name = {
    "canonicalDecimal": "canonicalDecimal",
    "sha256Hex": "sha256Hex",
    "jsonPointer": "jsonPointer",
    "bundlePath": "bundlePath",
    "isoTimestamp": "isoTimestamp",
}

definitions = {}
library = {}
for key in LIT:
    definitions[def_name[key]] = {
        "type": "string",
        "pattern": LIT[key],
        "maxLength": MAXLEN[key],
    }
    library[key] = {
        "pattern": LIT[key],
        "match_mode": "full",
        "domain": "ascii",
        "max_len": MAXLEN[key],
    }

definitions["artifactRef"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["artifact_id", "expected_sha256", "relative_path"],
    "properties": {
        "artifact_id": {"$ref": "#/definitions/sha256Hex"},
        "expected_sha256": {"$ref": "#/definitions/sha256Hex"},
        "relative_path": {"type": "string", "minLength": 1, "maxLength": 1024},
    },
}

definitions["checkResult"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["gate", "status"],
    "properties": {
        "gate": {"type": "string", "minLength": 1, "maxLength": 64},
        "status": {"enum": ["PASS", "FAIL", "SKIP"]},
        "detail": {"type": "string", "maxLength": 2048},
    },
}

common_doc = {
    "$schema": DRAFT7,
    "$id": "bundle://meta/common.defs.json",
    "title": "casefile common definitions (pure schema; pattern library is meta/pattern-library.json)",
    "definitions": definitions,
}

lib_doc = {
    "$id": "bundle://meta/pattern-library.json",
    "title": "pattern library (data resource; never compiled by any validator)",
    "patterns": library,
}

for name, doc in (("common.defs.json", common_doc), ("pattern-library.json", lib_doc)):
    out = os.path.join(META, name)
    with open(out, "w", encoding="utf-8", newline=chr(10)) as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write(chr(10))
    print("wrote", out)

# checks
assert "patterns" not in common_doc, "common.defs must not carry a root patterns key"
seen = {}
for key, entry in library.items():
    lit = entry["pattern"]
    assert definitions[def_name[key]]["pattern"] == lit, "defs-vs-library byte mismatch: " + key
    if lit in seen:
        raise SystemExit("PATTERN_LIBRARY_AMBIGUOUS: duplicate literal " + key + " vs " + seen[lit])
    seen[lit] = key
print("check: common.defs has no patterns key; defs<->library byte-equal; literals distinct:", len(seen))
