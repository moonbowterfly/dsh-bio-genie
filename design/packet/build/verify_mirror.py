#!/usr/bin/env python
"""verify_mirror.py — byte-for-byte verification of a packet mirror (v0.12 K5).

Usage: python verify_mirror.py <root_a> <root_b>
Compares the INDEXED file set of two packet trees: every file present in both must be
byte-identical; files missing on either side are reported; __pycache__/*.pyc/.git are
excluded and reported as such (explicit policy: packages claim index-set byte equality,
not tree equality).
Exit 0 iff the indexed sets are equal and all shared files are byte-identical.
"""
import hashlib
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

EXCLUDE_DIRS = {"__pycache__", ".git"}
INDEX_FILES = {"SHA256SUMS-packet.txt", "HASHES"}  # index artifacts are side-specific; integrity via own self-hash + per-side lint INDEX check


def walk(root):
    files = []
    for cur, dirs, fnames in os.walk(root):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for f in fnames:
            if f.endswith(".pyc") or f in INDEX_FILES:
                continue
            p = os.path.join(cur, f)
            files.append(os.path.relpath(p, root).replace(os.sep, "/"))
    return sorted(files)


def sha256_file(p):
    with open(p, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def count_excluded(root):
    n = 0
    for cur, dirs, fnames in os.walk(root):
        if os.path.basename(cur) == "__pycache__":
            n += len(fnames)
        for f in fnames:
            if f.endswith(".pyc"):
                n += 1
    return n


def main():
    if len(sys.argv) < 3:
        print("usage: python verify_mirror.py <root_a> <root_b>")
        return 2
    a, b = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    for name in sorted(INDEX_FILES):
        ha = sha256_file(os.path.join(a, name))[:16] if os.path.exists(os.path.join(a, name)) else "(absent)"
        hb = sha256_file(os.path.join(b, name))[:16] if os.path.exists(os.path.join(b, name)) else "(absent)"
        print("INDEX %s: a=%s b=%s" % (name, ha, hb))
    fa, fb = set(walk(a)), set(walk(b))
    fails = 0
    for rel in sorted(fa - fb):
        print("MISSING_IN_B " + rel)
        fails += 1
    for rel in sorted(fb - fa):
        print("MISSING_IN_A " + rel)
        fails += 1
    for rel in sorted(fa & fb):
        if sha256_file(os.path.join(a, rel)) != sha256_file(os.path.join(b, rel)):
            print("BYTE_DIFF " + rel)
            fails += 1
    print("files: a=%d b=%d common=%d | excluded(pyc): a=%d b=%d | mismatches=%d"
          % (len(fa), len(fb), len(fa & fb), count_excluded(a), count_excluded(b), fails))
    print("MIRROR:", "OK (index-set byte-for-byte identical)" if fails == 0 else "MISMATCH")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
