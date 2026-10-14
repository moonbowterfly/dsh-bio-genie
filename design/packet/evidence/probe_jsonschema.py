#!/usr/bin/env python
"""probe_jsonschema.py v2 — fixed probes: $schema + default_specification paths."""
import jsonschema  # noqa: F401
from jsonschema import Draft7Validator

CARET = chr(94)
DOLLAR = chr(36)
LF = chr(10)
DRAFT7_URI = "http://json-schema.org/draft-07/schema#"


def banner(name, fn):
    try:
        out = fn()
        print(name, ": OK |", out if out is not None else "")
    except Exception as exc:  # noqa: BLE001
        print(name, ": ERR |", str(exc)[:260])


def t2a():
    from referencing import Registry, Resource

    common = {"$schema": DRAFT7_URI, "$id": "bundle://meta/common.defs.json", "definitions": {"d": {"type": "string"}}}
    reg = Registry().with_resources([("bundle://meta/common.defs.json", Resource.from_contents(common))])
    schema = {
        "$schema": DRAFT7_URI,
        "$id": "bundle://schemas/t.schema.json",
        "type": "object",
        "properties": {"s": {"$ref": "bundle://meta/common.defs.json#/definitions/d"}},
    }
    v = Draft7Validator(schema, registry=reg)
    a = len(list(v.iter_errors({"s": "ok"})))
    b = len(list(v.iter_errors({"s": 5})))
    return "with $schema: ok-errors=" + str(a) + " bad-errors=" + str(b)


banner("P2a registry with $schema present", t2a)


def t2b():
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT7

    common = {"$id": "bundle://meta/common.defs.json", "definitions": {"d": {"type": "string"}}}
    reg = Registry().with_resources([("bundle://meta/common.defs.json", Resource.from_contents(common, default_specification=DRAFT7))])
    schema = {"$id": "bundle://schemas/t.schema.json", "type": "object", "properties": {"s": {"$ref": "bundle://meta/common.defs.json#/definitions/d"}}}
    v = Draft7Validator(schema, registry=reg)
    a = len(list(v.iter_errors({"s": "ok"})))
    b = len(list(v.iter_errors({"s": 5})))
    return "default_specification=DRAFT7: ok-errors=" + str(a) + " bad-errors=" + str(b)


banner("P2b registry with default_specification", t2b)


def t4b():
    import re

    lit = CARET + "(?:[0-9]+)" + DOLLAR
    s = "0" + LF
    return "search=" + str(bool(re.search(lit, s))) + " fullmatch=" + str(bool(re.fullmatch(lit, s))) + " search-plain=" + str(bool(re.search(lit, "0")))


banner("P4b search vs fullmatch on trailing LF (matcher design evidence)", t4b)
