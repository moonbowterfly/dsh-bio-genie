#!/usr/bin/env python
"""make_cases.py — generator for synbio-c14n-corpus@1 (zero-backslash source).

Builds corpus/c14n_cases.json (case inputs as raw JSON texts).
"""
import json
import os
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
BS = chr(92)
E_ACUTE = chr(0xE9)
COMB_ACUTE = chr(0x301)
LS = chr(0x2028)
PS = chr(0x2029)

cases = []


def add(cid, note, inp, ann, expect):
    cases.append({"id": cid, "note": note, "input": inp, "annotations": ann, "expect": expect})


def s(x):
    return chr(34) + x + chr(34)


# --- basics / structure ---
add("c001", "key sorting basic", '{"b":1,"a":2}', {}, "accept")
add("c002", "nested objects and seq array", '{"z":{"y":1},"a":[3,2]}', {"$/a": "seq"}, "accept")
add("c003", "seq keeps order", '{"x":["b","a"]}', {"$/x": "seq"}, "accept")
add("c004", "set sorts ascending", '{"x":["b","a"]}', {"$/x": "set"}, "accept")
add("c025", "empty object and empty seq array", '{"a":{},"b":[]}', {"$/b": "seq"}, "accept")
add("c036", "set and seq side by side", '{"s":["b","a"],"q":["b","a"]}', {"$/s": "set", "$/q": "seq"}, "accept")
add("c038", "true false null mix", '{"a":true,"b":false,"c":null}', {}, "accept")

# --- non-BMP adversarial ordering ---
add("c005", "set: U+FFFF vs U+10000 sorts by UTF-8 bytes (FFFF first)",
    '{"x":[' + s(chr(0xFFFF)) + ',' + s(chr(0x10000)) + ']}', {"$/x": "set"}, "accept")
add("c006", "keys: U+FFFF vs U+10000 sorts by UTF-16 units (10000 first)",
    '{"' + chr(0xFFFF) + '":1,"' + chr(0x10000) + '":2}', {}, "accept")

# --- unicode normalization ---
add("c007", "NFC normalize key and value", '{"' + 'e' + COMB_ACUTE + '":"' + 'e' + COMB_ACUTE + '"}', {}, "accept")
add("c008", "NFC key collision rejects", '{"' + E_ACUTE + '":1,"' + 'e' + COMB_ACUTE + '":2}', {}, "reject")
add("c037", "root string NFC", s('e' + COMB_ACUTE), {}, "accept")
add("c023", "U+2028/U+2029 raw kept", '{"s":' + s(LS + PS) + '}', {}, "accept")
add("c024", "DEL and C1 raw kept", '{"s":' + s(chr(0x7F) + chr(0x80)) + '}', {}, "accept")

# --- surrogates / dup keys / invalid ---
add("c009", "lone surrogate in value rejects", '{"s":' + s(BS + 'uD800') + '}', {}, "reject")
add("c010", "duplicate raw keys reject", '{"a":1,"a":2}', {}, "reject")
add("c029", "invalid json", '{', {}, "reject")
add("c030", "trailing garbage", '{"a":1} x', {}, "reject")

# --- numbers ---
add("c012", "exponent/float/negative-zero normalize", '[1e0,1.0,-0]', {"$": "seq"}, "accept")
add("c013", "safe integer max", '9007199254740991', {}, "accept")
add("c014", "2^53 out of range", '9007199254740992', {}, "reject")
add("c015", "1e21 out of range integer", '1e21', {}, "reject")
add("c016", "1e-7 scientific", '1e-7', {}, "accept")
add("c017", "1e-6 plain decimal", '1e-6', {}, "accept")
add("c018", "0.1", '0.1', {}, "accept")
add("c019", "5e-324 min subnormal", '5e-324', {}, "accept")
add("c020", "1.5e300 out of range", '1.5e300', {}, "reject")
add("c021", "1e20 out of range", '1e20', {}, "reject")
add("c031", "exponent forms", '[1E+2,2e-2]', {"$": "seq"}, "accept")
add("c032", "zero forms", '[0.0,0,-0.0]', {"$": "seq"}, "accept")
add("c033", "-1.5e-8", '-1.5e-8', {}, "accept")
add("c034", "long fraction shortest repr", '123456789.123456789', {}, "accept")
add("c035", "negative safe integer max", '-9007199254740991', {}, "accept")
add("c039", "-0", '-0', {}, "accept")
add("c040", "-0.0", '-0.0', {}, "accept")
add("c042", "1e-21", '1e-21', {}, "accept")
add("c043", "1.5", '1.5', {}, "accept")
add("c044", "-2", '-2', {}, "accept")

# --- strings / escapes ---
add("c022", "escape set round-trip", '{"s":"a' + BS + '"b' + BS + BS + 'c' + BS + 'u0001' + BS + 'n' + BS + 't"}', {}, "accept")
add("c045", "forward slash not escaped", '{"s":"a/b"}', {}, "accept")

# --- arrays: annotation rules ---
add("c011", "unannotated array rejects", '{"x":[1]}', {}, "reject")
add("c026", "set duplicate rejects", '[1,1]', {"$": "set"}, "reject")
add("c027", "set canonical-equivalent duplicate rejects", '[1.0,1]', {"$": "set"}, "reject")
add("c041", "set NFC-equivalent duplicate rejects",
    '[' + s(E_ACUTE) + ',' + s('e' + COMB_ACUTE) + ']', {"$": "set"}, "reject")

# --- extras ---
add("c046", "emoji non-BMP raw", '{"s":' + s(chr(0x1F600)) + '}', {}, "accept")
add("c047", "key sort ascii vs non-ascii", '{"z1":1,"' + chr(0x4E00) + '":2,"a2":3}', {}, "accept")
add("c048", "set mixed types sorted by canonical bytes",
    '["b",2,true,null,1,"a"]', {"$": "set"}, "accept")
add("c049", "set duplicate via 1e2 vs 100", '[1e2,100]', {"$": "set"}, "reject")
add("c050", "set of objects sorted by canonical text",
    '[{"b":1,"a":2},{"a":1}]', {"$": "set"}, "accept")
add("c051", "key lexicographic a10 vs a2", '{"a2":1,"a10":2}', {}, "accept")
add("c052", "empty string key and value", '{"":""}', {}, "accept")
add("c053", "string with only newline escape", '{"s":' + s(BS + 'n') + '}', {}, "accept")

# --- v0.12 K4: frozen unicode domain gate (pre-NFC) ---
add("c055", "gate: pre-15.0 combining mark ok", '{"s":' + s('A' + chr(0x0315)) + '}', {}, "accept")
add("c056", "gate: U+1ACF outside UCD 15.0 rejects", '{"s":' + s('A' + chr(0x0315) + chr(0x1ACF)) + '}', {}, "reject")
add("c057", "gate: noncharacter U+FDD0 allowed", '{"s":' + s(chr(0xFDD0)) + '}', {}, "accept")
add("c058", "gate: private use U+E000 allowed", '{"s":' + s(chr(0xE000)) + '}', {}, "accept")
add("c059", "gate: astral assigned U+20000 allowed", '{"s":' + s(chr(0x20000)) + '}', {}, "accept")

# --- deep nesting ---
deep = "1"
for i in range(20):
    deep = '{"k' + str(i) + '":' + deep + '}'
add("c028", "deep nesting 20", deep, {}, "accept")

doc = {
    "corpus": "synbio-c14n-corpus",
    "version": 1,
    "profile": "casefile-c14n@1 (rev2026-10-13)",
    "cases": cases,
}
out = os.path.join(HERE, "c14n_cases.json")
with open(out, "w", encoding="utf-8", newline=chr(10)) as fh:
    json.dump(doc, fh, ensure_ascii=False, indent=1, sort_keys=False)
    fh.write(chr(10))
print("wrote", out, "cases:", len(cases))
