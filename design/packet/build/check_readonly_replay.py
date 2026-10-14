#!/usr/bin/env python
"""check_readonly_replay.py — prove normal replay does not modify the packet tree (v0.13 K5).

Fresh copy -> snapshot (ALL files, including bytecode caches) -> run the normal runners
-> re-snapshot -> require zero changes (created/modified/deleted). The runners are called with the inherited
PYTHONUTF8 / PYTHONIOENCODING / PYTHONDONTWRITEBYTECODE / PACKET_ROOT variables removed
(only PACKET_ROOT and AJV_WORKSPACE are set for the copy): they must defend themselves. Requires AJV_WORKSPACE (schema-corpus runs). Read-only w.r.t. the
original packet (everything happens in a temp copy).
"""
import hashlib
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


def snap(root):
    out = {}
    for cur, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != ".git"]
        for f in files:
            p = os.path.join(cur, f)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            with open(p, "rb") as fh:
                out[rel] = hashlib.sha256(fh.read()).hexdigest()
    return out


def main():
    ws = os.environ.get("AJV_WORKSPACE")
    if not ws:
        print("ERROR: AJV_WORKSPACE is not set (schema-corpus runs need the locked ajv workspace).")
        return 2

    workdir = tempfile.mkdtemp(prefix="packet-readonly-")
    copy_dir = os.path.join(workdir, "copy")
    shutil.copytree(PACKET, copy_dir, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    before = snap(copy_dir)

    commands = [
        ("packet_lint.py", [sys.executable, os.path.join(copy_dir, "build", "packet_lint.py")]),
        ("check_compile.py", [sys.executable, os.path.join(copy_dir, "build", "check_compile.py")]),
        ("run_corpus.py", [sys.executable, os.path.join(copy_dir, "corpus", "run_corpus.py")]),
        ("run_schema_corpus.py", [sys.executable, os.path.join(copy_dir, "schema-corpus", "run_schema_corpus.py")]),
        ("pattern_samples.py", [sys.executable, os.path.join(copy_dir, "evidence", "pattern_samples.py")]),
        ("meta_smoke.py", [sys.executable, os.path.join(copy_dir, "evidence", "meta_smoke.py")]),
        ("pattern_samples.mjs", ["node", os.path.join(copy_dir, "evidence", "pattern_samples.mjs")]),
        ("check_compile.mjs", ["node", os.path.join(copy_dir, "build", "check_compile.mjs")]),
        ("run_schema_corpus.mjs", ["node", os.path.join(copy_dir, "schema-corpus", "run_schema_corpus.mjs")]),
    ]

    STRIPPED_VARS = ("PACKET_ROOT", "PYTHONUTF8", "PYTHONIOENCODING", "PYTHONDONTWRITEBYTECODE")
    base_env = {k: v for k, v in os.environ.items() if k not in STRIPPED_VARS}

    fails = 0
    for name, cmd in commands:
        env = dict(base_env)
        env["PACKET_ROOT"] = copy_dir
        env["AJV_WORKSPACE"] = ws
        # deliberately NOT setting PYTHONDONTWRITEBYTECODE / PYTHONUTF8: runners must defend themselves
        proc = subprocess.run(
            cmd, cwd=copy_dir, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=600, env=env,
        )
        print("%-24s rc=%d" % (name, proc.returncode))
        if proc.returncode != 0:
            fails += 1
            print(proc.stdout[-300:])
            print(proc.stderr[-300:])

    after = snap(copy_dir)
    created = sorted(set(after) - set(before))
    modified = sorted(k for k in set(before) & set(after) if before[k] != after[k])
    deleted = sorted(set(before) - set(after))
    for rel in created[:20]:
        print("CREATED ", rel)
    for rel in modified[:20]:
        print("MODIFIED", rel)
    for rel in deleted[:20]:
        print("DELETED ", rel)
    changed = len(created) + len(modified) + len(deleted)
    ok = (changed == 0) and (fails == 0)
    print("READONLY_REPLAY:", "PASS (tree bit-identical incl. caches)" if ok else "FAIL (changes=%d cmdfails=%d)" % (changed, fails))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
