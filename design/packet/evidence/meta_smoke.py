#!/usr/bin/env python
"""meta_smoke.py — python-side smoke (v0.12): manifest-driven bundle; cross-doc $refs of
common.defs.json; decimal literal read from meta/pattern-library.json. Read-only.
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
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "build"))
from bundle_loader import bundle_root, load_bundle  # noqa: E402

from jsonschema import Draft7Validator  # noqa: E402
from referencing import Registry, Resource  # noqa: E402
from referencing.jsonschema import DRAFT7  # noqa: E402

LF = chr(10)


def main():
    root = bundle_root()
    mpath = os.path.join(root, "bundle.manifest.json")
    manifest_sha = hashlib.sha256(open(mpath, "rb").read()).hexdigest()[:16] if os.path.exists(mpath) else "MISSING"
    ipath = os.path.join(root, "SHA256SUMS-packet.txt")
    if os.path.exists(ipath):
        index_sha = "sums:" + hashlib.sha256(open(ipath, "rb").read()).hexdigest()[:12]
    else:
        hpath = os.path.join(root, "HASHES")
        index_sha = ("hashes:" + hashlib.sha256(open(hpath, "rb").read()).hexdigest()[:12]) if os.path.exists(hpath) else "(none)"
    print("[meta_smoke.py] packet_root=" + root + " manifest_sha=" + manifest_sha + " index_sha=" + index_sha + " read-only: no packet writes")
    docs, problems = load_bundle(root)
    if problems:
        print("BUNDLE LOAD FAILED:")
        for p in problems:
            print("  [LOADER] " + p)
        return 1

    common = docs["meta/common.defs.json"]
    DEC = docs["meta/pattern-library.json"]["patterns"]["canonicalDecimal"]["pattern"]

    reg = Registry().with_resources(
        [("bundle://meta/common.defs.json", Resource.from_contents(common, default_specification=DRAFT7))]
    )

    schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "$id": "bundle://schemas/_smoke.schema.json",
        "type": "object",
        "properties": {
            "hash": {"$ref": "bundle://meta/common.defs.json#/definitions/sha256Hex"},
            "dec": {"type": "string", "x-decimal-string": True, "pattern": DEC},
            "arr": {"type": "array", "x-canonical": "set", "items": {"type": "string"}},
        },
    }
    v = Draft7Validator(schema, registry=reg)

    fails = 0

    def check(name, data, expected_errs_zero):
        errs = list(v.iter_errors(data))
        ok = (len(errs) == 0) == expected_errs_zero
        if not ok:
            nonlocal fails
            fails += 1
        print(("PASS " if ok else "FAIL ") + name + " expected_zero_errs=" + str(expected_errs_zero) + " got_errs=" + str(len(errs)))

    H = "a" * 64
    check("good-hash-good-decimal", {"hash": H, "dec": "12.5", "arr": ["x"]}, True)
    check("bad-hash", {"hash": "zz", "dec": "12.5"}, False)
    check("zero-decimal", {"hash": H, "dec": "0"}, True)
    check("leading-zero-rejected", {"hash": H, "dec": "01"}, False)
    check("exp-form-rejected", {"hash": H, "dec": "1e-7"}, False)

    errs_lf = list(v.iter_errors({"hash": H, "dec": "0" + LF}))
    print("DIVERGENCE-EVIDENCE trailing-lf hosted-python-accepts:", len(errs_lf) == 0, "(js rejects; matcher layer will be truth)")

    print("smoke:", "ALL PASS (5 asserted + divergence evidence)" if fails == 0 else str(fails) + " FAILURES")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
