#!/usr/bin/env python
"""make_index.py — regenerate HASHES (the working index) from the packet tree (v0.13).

Excluded by policy: HASHES itself, SHA256SUMS-packet.txt (side-specific indexes),
__pycache__/ and *.pyc (regenerable bytecode caches). Run AFTER any generation/freeze
step, BEFORE lint (lint verifies the index against disk).
"""
import hashlib
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
PACKET = os.path.abspath(os.environ.get("PACKET_ROOT") or os.path.dirname(HERE))
EXCLUDE = {"HASHES", "SHA256SUMS-packet.txt"}


def main():
    rows = []
    for cur, dirs, files in os.walk(PACKET):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", ".git")]
        for f in files:
            if f.endswith(".pyc") or f in EXCLUDE:
                continue
            p = os.path.join(cur, f)
            rel = os.path.relpath(p, PACKET).replace(os.sep, "/")
            with open(p, "rb") as fh:
                rows.append((rel, hashlib.sha256(fh.read()).hexdigest()))
    rows.sort()
    out = os.path.join(PACKET, "HASHES")
    with open(out, "w", encoding="utf-8", newline=chr(10)) as fh:
        for rel, h in rows:
            fh.write(h + "  " + rel + chr(10))
    print("HASHES regenerated:", len(rows), "entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
