#!/usr/bin/env python
"""make_manifest.py — emit bundle.manifest.json (bundle index; deterministic).

Bundle files = schemas/*.json (23) + meta/*.json (4: common.defs.json, x-canonical.meta.json,
pattern-library.json, unicode-domain-table.json).
Paths are bundle-relative and equal the `$id` suffix (bundle://<path>).
The manifest's own hash is intentionally NOT inside itself; it is recorded in
the packet-level ledger (see README / HASHES).
"""
import hashlib
import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

BUILD = os.path.dirname(os.path.abspath(__file__))
PACKET = os.path.dirname(BUILD)
SCHEMAS = os.path.join(PACKET, "schemas")
META = os.path.join(PACKET, "meta")
OUT = os.path.join(PACKET, "bundle.manifest.json")


def sha256_file(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def main():
    files = []
    for name in sorted(os.listdir(SCHEMAS)):
        if name.endswith(".json"):
            files.append("schemas/" + name)
    for name in ("common.defs.json", "x-canonical.meta.json", "pattern-library.json", "unicode-domain-table.json"):
        files.append("meta/" + name)
    files.sort()

    entries = [{"path": rel, "sha256": sha256_file(os.path.join(PACKET, rel))} for rel in files]
    doc = {"bundle": "synbio-schemas", "version": 1, "files": entries}

    with open(OUT, "w", encoding="utf-8", newline=chr(10)) as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.write(chr(10))

    with open(OUT, "rb") as fh:
        raw = fh.read()
    n_schemas = sum(1 for f in files if f.startswith("schemas/"))
    n_meta = len(files) - n_schemas
    print("bundle.manifest.json: %d files (schemas %d + meta %d), %d bytes" % (len(entries), n_schemas, n_meta, len(raw)))
    print("manifest sha256: %s" % hashlib.sha256(raw).hexdigest())
    if n_schemas != 23 or n_meta != 4 or len(entries) != 27:
        print("UNEXPECTED FILE COUNT")
        return 1
    for e in entries:
        if sha256_file(os.path.join(PACKET, e["path"])) != e["sha256"]:
            print("HASH MISMATCH: " + e["path"])
            return 1
    print("manifest self-check OK (%d entries verified)" % len(entries))
    return 0


if __name__ == "__main__":
    sys.exit(main())
