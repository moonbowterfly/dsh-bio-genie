#!/usr/bin/env python
"""make_unicode_table.py — generate meta/unicode-domain-table.json (v0.12 K4).

Frozen Unicode normalization domain = the code points BOTH sides can normalize
identically: every code point assigned in UCD 15.0 (category != Cn, which also
includes private-use Co) PLUS the noncharacters (stable in every version).
Derived from CPython 3.12 unicodedata; shipped as a hash-bound data resource.
"""
import json
import os
import unicodedata
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
META = os.path.join(os.path.dirname(HERE), "meta")
OUT = os.path.join(META, "unicode-domain-table.json")


def is_noncharacter(cp):
    if 0xFDD0 <= cp <= 0xFDEF:
        return True
    return (cp & 0xFFFE) == 0xFFFE


def main():
    ranges = []
    start = None
    prev = None
    for cp in range(0x110000):
        ok = is_noncharacter(cp) or unicodedata.category(chr(cp)) != "Cn"
        if ok:
            if start is None:
                start = cp
            elif cp != prev + 1:
                ranges.append([start, prev])
                start = cp
            prev = cp
    if start is not None:
        ranges.append([start, prev])

    doc = {
        "$id": "bundle://meta/unicode-domain-table.json",
        "title": "frozen normalization domain (data resource; never compiled by any validator)",
        "unicode_version": "15.0.0",
        "source": "CPython 3.12 unicodedata; rule = assigned (category != Cn) + noncharacters",
        "ranges": ranges,
    }
    with open(OUT, "w", encoding="utf-8", newline=chr(10)) as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
        fh.write(chr(10))
    print("wrote", OUT, "| ranges:", len(ranges), "| bytes:", os.path.getsize(OUT))
    assert doc["ranges"] == sorted(doc["ranges"]), "ranges must be sorted"
    for s, e in ranges:
        assert s <= e
    print("check: sorted, non-overlapping-by-construction OK")


if __name__ == "__main__":
    main()
