#!/usr/bin/env python
"""schema_helpers.py — shared helpers for the 23-schema generator.

Loads pattern literals from meta/pattern-library.json (single source of truth)
so that every inline `pattern` value in the generated schemas is byte-equal
to a library member (per spec v0.11 J1 / v0.9 H3).
"""
import json
import os

BUILD_DIR = os.path.dirname(os.path.abspath(__file__))
PACKET_DIR = os.path.dirname(BUILD_DIR)
META_DIR = os.path.join(PACKET_DIR, "meta")
SCHEMAS_DIR = os.path.join(PACKET_DIR, "schemas")

DRAFT7 = "http://json-schema.org/draft-07/schema#"

with open(os.path.join(META_DIR, "pattern-library.json"), encoding="utf-8") as _fh:
    _LIB = json.load(_fh)

LIT = {k: v["pattern"] for k, v in _LIB["patterns"].items()}
MAXLEN = {k: v["max_len"] for k, v in _LIB["patterns"].items()}


def cdef(name):
    """$ref into common.defs.json definitions (absolute bundle form)."""
    return {"$ref": "bundle://meta/common.defs.json#/definitions/" + name}


def sref(stem):
    """$ref to another schema file (absolute bundle form)."""
    return {"$ref": "bundle://schemas/" + stem + ".json"}


def sha():
    return cdef("sha256Hex")


def ts_():
    return cdef("isoTimestamp")


def ptr():
    return cdef("jsonPointer")


def aref():
    return cdef("artifactRef")


def check():
    return cdef("checkResult")


def dec():
    """A decimal-string node: inline annotation + library-literal pattern."""
    return {
        "type": "string",
        "x-decimal-string": True,
        "pattern": LIT["canonicalDecimal"],
        "maxLength": MAXLEN["canonicalDecimal"],
    }


def arr(kind, items):
    """Annotated array node (every array must carry x-canonical for c14n)."""
    return {"type": "array", "x-canonical": kind, "items": items}


def obj(props, required, extra=False):
    node = {
        "type": "object",
        "additionalProperties": bool(extra),
        "properties": props,
    }
    if required:
        node["required"] = list(required)
    return node


def schema(stem, title, body):
    doc = {"$schema": DRAFT7, "$id": "bundle://schemas/" + stem + ".json", "title": title}
    doc.update(body)
    return doc
