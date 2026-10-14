#!/usr/bin/env python
"""check_compile.py — python-side schema sanity (v0.12).

Manifest-driven: all documents come from build/bundle_loader (exact manifest/hash set;
no directory scanning). Registration covers the $ref-eligible documents
(23 schemas + meta/common.defs.json). Read-only: prints a self-cert header and never
writes into the packet.
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

from jsonschema import Draft7Validator  # noqa: E402
from referencing import Registry, Resource  # noqa: E402
from referencing.jsonschema import DRAFT7  # noqa: E402


def collect_refs(node, out):
    if isinstance(node, dict):
        if isinstance(node.get("$ref"), str):
            out.append(node["$ref"])
        for v in node.values():
            collect_refs(v, out)
    elif isinstance(node, list):
        for v in node:
            collect_refs(v, out)


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
    print("[check_compile.py] packet_root=" + root + " manifest_sha=" + manifest_sha + " index_sha=" + index_sha + " read-only: no packet writes")

    docs, problems = load_bundle(root)
    if problems:
        print("BUNDLE LOAD FAILED:")
        for p in problems:
            print("  [LOADER] " + p)
        return 1

    schem_files = sorted(k[len("schemas/"):] for k in docs if k.startswith("schemas/"))
    ref_eligible = ["meta/common.defs.json"] + ["schemas/" + f for f in schem_files]
    reg = Registry().with_resources(
        [("bundle://" + p, Resource.from_contents(docs[p], default_specification=DRAFT7)) for p in ref_eligible]
    )
    resolver = reg.resolver()

    fail = 0
    for f in schem_files:
        doc = docs["schemas/" + f]
        try:
            Draft7Validator.check_schema(doc)
        except Exception as exc:  # noqa: BLE001
            fail += 1
            print("CHECKSCHEMA_FAIL " + f + " :: " + str(exc)[:200])
            continue
        refs = []
        collect_refs(doc, refs)
        prob = 0
        for r in refs:
            if r.startswith("#"):
                continue
            try:
                resolver.lookup(r)
            except Exception as exc:  # noqa: BLE001
                prob += 1
                print("REF_FAIL " + f + " " + r + " :: " + str(exc)[:160])
        if prob == 0:
            print("PY_OK " + f + " (" + str(len(refs)) + " refs resolved)")
        else:
            fail += 1
    print("PY_COMPILE: " + ("ALL OK (" + str(len(schem_files)) + " files)" if fail == 0 else str(fail) + " FAILURES"))
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
