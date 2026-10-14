#!/usr/bin/env python
"""run_corpus.py — dual-side comparator for synbio-c14n-corpus@1 (v0.13).

Loader gate (K2): before ANY semantic computation, the bundle is loaded and every
manifest file is hash-verified via build/bundle_loader; failure returns
REGISTRY_UNRESOLVED (exit 2, fail-closed). The unicode-domain table is consumed
ONLY as manifest-verified bytes: ranges are injected into the Python impl and
passed to the Node impl via a verifier-written temp file (--domain-json).

Read-only by default: node results go to a system temp file; --write-results /
--freeze write in place. No .pyc is written (sys.dont_write_bytecode + child env).
Prints a self-cert header with packet root, manifest hash and index hash.

Usage: python run_corpus.py [--freeze] [--write-results]
"""
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

sys.dont_write_bytecode = True

import hashlib
import json
import os
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "build"))
from bundle_loader import bundle_root, load_bundle  # noqa: E402


def main():
    freeze = "--freeze" in sys.argv
    write_results = freeze or ("--write-results" in sys.argv)

    root = bundle_root()
    mpath = os.path.join(root, "bundle.manifest.json")
    manifest_sha = hashlib.sha256(open(mpath, "rb").read()).hexdigest()[:16] if os.path.exists(mpath) else "MISSING"
    ip = os.path.join(root, "SHA256SUMS-packet.txt")
    index_sha = hashlib.sha256(open(ip, "rb").read()).hexdigest()[:16] if os.path.exists(ip) else "(none)"
    print("[run_corpus.py] packet_root=" + root + " manifest_sha=" + manifest_sha + " index_sha=" + index_sha
          + " read-only: no packet writes (results only with --freeze/--write-results)")

    docs, problems = load_bundle(root)
    if problems:
        print("REGISTRY_UNRESOLVED: bundle loader failed before any semantic computation:")
        for p in problems:
            print("  [LOADER] " + p)
        return 2

    table_ranges = docs["meta/unicode-domain-table.json"]["ranges"]

    sys.path.insert(0, os.path.join(root, "impl"))
    import c14n  # noqa: E402  (import after the loader gate)
    c14n.set_domain_ranges(table_ranges)

    cases_path = os.path.join(HERE, "c14n_cases.json")
    node_impl = os.path.join(root, "impl", "c14n.mjs")
    results_inplace = os.path.join(HERE, "results_node.json")
    tmp_out = results_inplace if write_results else os.path.join(tempfile.gettempdir(), "synbio_c14n_results_node.json")

    doc = json.load(open(cases_path, encoding="utf-8"))
    cases = doc["cases"]

    py_results = [c14n._result(entry) for entry in cases]

    fd, ranges_path = tempfile.mkstemp(prefix="synbio_c14n_ranges_", suffix=".json")
    os.close(fd)
    with open(ranges_path, "w", encoding="utf-8", newline=chr(10)) as fh:
        json.dump({"ranges": table_ranges}, fh)
        fh.write(chr(10))

    env = dict(os.environ)
    env["PACKET_ROOT"] = root
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    subprocess.run(
        ["node", node_impl, "--batch", cases_path, "--out", tmp_out, "--domain-json", ranges_path],
        check=True, env=env,
    )
    node_results = json.load(open(tmp_out, encoding="utf-8"))["results"]

    by_id_py = {r["id"]: r for r in py_results}
    by_id_js = {r["id"]: r for r in node_results}

    fails = []
    warns = []
    for entry in cases:
        cid = entry["id"]
        pr = by_id_py.get(cid)
        jr = by_id_js.get(cid)
        if pr is None or jr is None:
            fails.append((cid, "missing result", ""))
            continue
        if pr["status"] != entry["expect"]:
            fails.append((cid, "py expect mismatch", pr["status"]))
        if jr["status"] != entry["expect"]:
            fails.append((cid, "js expect mismatch", jr["status"]))
        if pr["status"] != jr["status"]:
            fails.append((cid, "cross verdict", pr["status"] + " vs " + jr["status"]))
        elif pr["status"] == "accept":
            if pr["canonical"] != jr["canonical"]:
                fails.append((cid, "canonical mismatch", pr["canonical"] + " != " + jr["canonical"]))
        else:
            if pr.get("code") != jr.get("code"):
                warns.append((cid, "code differs", str(pr.get("code")) + " vs " + str(jr.get("code"))))

    print("cases:", len(cases), "| fails:", len(fails), "| warns:", len(warns))
    for cid, what, detail in fails[:20]:
        print("  FAIL", cid, what, "|", str(detail)[:160])
    for cid, what, detail in warns[:10]:
        print("  WARN", cid, what, "|", detail)

    if freeze and not fails:
        for entry in cases:
            r = by_id_py[entry["id"]]
            if r["status"] == "accept":
                entry["canonical"] = r["canonical"]
                entry.pop("code", None)
            else:
                entry["code"] = r["code"]
                entry.pop("canonical", None)
        with open(cases_path, "w", encoding="utf-8", newline=chr(10)) as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=1)
            fh.write(chr(10))
        print("FROZEN: canonical/code written back into cases file")

    print("RESULT:", "ALL_PASS" if not fails else "HAS_FAILURES")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
