#!/usr/bin/env python
"""bundle_loader.py — manifest-driven bundle loader (spec v0.12 K2).

Reads bundle.manifest.json from the packet root, verifies the exact file set
(entry shape, duplicates, existence, extra files, per-entry sha256, $id), and
returns the documents keyed by manifest path. NO directory scanning, NO dynamic
retrieval, NO network.

Packet root: explicit arg > PACKET_ROOT env > parent of this file's directory.
Callers must treat any problem as fail-closed (REGISTRY_UNRESOLVED class).
"""
import hashlib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def bundle_root(packet_root=None):
    return os.path.abspath(packet_root or os.environ.get("PACKET_ROOT") or os.path.dirname(HERE))


def _sha256_file(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def load_bundle(packet_root=None):
    """Returns (docs_by_manifest_path, problems). Empty problems == clean load."""
    root = bundle_root(packet_root)
    problems = []
    docs = {}

    manifest_path = os.path.join(root, "bundle.manifest.json")
    if not os.path.exists(manifest_path):
        return docs, ["MANIFEST_MISSING_FILE bundle.manifest.json under " + root]

    try:
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        return docs, ["MANIFEST_UNPARSEABLE " + str(exc)[:160]]

    files = manifest.get("files")
    if not isinstance(files, list):
        return docs, ["MANIFEST_SHAPE_INVALID files is not a list"]
    listed = []
    for e in files:
        if not isinstance(e, dict) or not isinstance(e.get("path"), str) or not isinstance(e.get("sha256"), str):
            problems.append("MANIFEST_SHAPE_INVALID " + json.dumps(e)[:120])
            continue
        listed.append(e["path"])
    if len(set(listed)) != len(listed):
        problems.append("MANIFEST_DUPLICATE_PATH " + str(listed))

    # exact-set comparison against the bundle directories (no scanning for registration,
    # scanning is used ONLY to detect unregistered/extra files -> fail closed)
    on_disk = []
    for sub in ("schemas", "meta"):
        d = os.path.join(root, sub)
        if os.path.isdir(d):
            for f in sorted(os.listdir(d)):
                if f.endswith(".json"):
                    on_disk.append(sub + "/" + f)
    on_disk = sorted(on_disk)
    for rel in on_disk:
        if rel not in listed:
            problems.append("MANIFEST_EXTRA_FILE " + rel + " on disk but not listed")
    for rel in listed:
        if rel not in on_disk:
            problems.append("MANIFEST_MISSING_FILE " + rel + " listed but absent on disk")

    for e in files:
        if not isinstance(e, dict) or "path" not in e or "sha256" not in e:
            continue
        p = os.path.join(root, e["path"])
        if not os.path.exists(p):
            continue  # already reported
        h = _sha256_file(p)
        if h != e["sha256"]:
            problems.append("REGISTRY_UNRESOLVED hash mismatch " + e["path"] + " disk=" + h[:16] + " listed=" + e["sha256"][:16])
        try:
            with open(p, encoding="utf-8") as fh:
                doc = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            problems.append("MANIFEST_UNPARSEABLE " + e["path"] + " " + str(exc)[:120])
            continue
        if doc.get("$id") != "bundle://" + e["path"]:
            problems.append("MANIFEST_ID_MISMATCH " + e["path"] + " $id=" + str(doc.get("$id")))
        docs[e["path"]] = doc

    return docs, problems
