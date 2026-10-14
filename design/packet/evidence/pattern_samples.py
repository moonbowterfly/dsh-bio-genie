#!/usr/bin/env python
"""pattern_samples.py — I2/K3 evidence: dual-side matcher verdict samples (v0.13).

Matcher contract (identical twin: pattern_samples.mjs):
  - ASCII domain gate FIRST (any non-ASCII -> PATTERN_DOMAIN_VIOLATION);
  - max_len counted in Unicode scalar values (Python len == scalar count);
  - match_mode=full via explicit full-match wrapper (never bare search);
  - canonicalDecimal uses the DECIMAL_STRING scanner as its matcher.
Every case asserts the EXACT stable code (None == accept). Wrapper-contract cases
use synthetic (unanchored) literals so a regression to bare .test()/re.search is
detectable. Library loaded from meta/pattern-library.json via the loader. Read-only.
"""
import hashlib
import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "build"))
from bundle_loader import bundle_root, load_bundle  # noqa: E402

LF = chr(10)


def decimal_scan(s):
    if not isinstance(s, str):
        return False
    n = len(s)
    if n == 0:
        return False
    i = 0
    neg = False
    if s[0] == "-":
        neg = True
        i = 1
        if i >= n:
            return False
    if s[i] == "0":
        i += 1
        if i < n and "0" <= s[i] <= "9":
            return False
    elif "1" <= s[i] <= "9":
        i += 1
        while i < n and "0" <= s[i] <= "9":
            i += 1
    else:
        return False
    if i == n:
        if neg and s[1:i] == "0":
            return False
        return True
    if s[i] == ".":
        i += 1
        if i >= n:
            return False
        j = i
        while j < n and "0" <= s[j] <= "9":
            j += 1
        if j == i:
            return False
        if not ("1" <= s[j - 1] <= "9"):
            return False
        i = j
    return i == n


def fullmatch_wrapper(lit, s):
    """Explicit full-string semantics (K3): the ONLY legal hosted matcher."""
    import re as _re
    return _re.fullmatch(lit, s) is not None


def matcher(name, entry, s):
    """Returns None on accept, or the exact stable fault code."""
    if not s.isascii():
        return "PATTERN_DOMAIN_VIOLATION"
    if len(s) > entry["max_len"]:
        return "PATTERN_MAX_LEN"
    if name == "canonicalDecimal":
        if not decimal_scan(s):
            return "DECIMAL_STRING_NONCANONICAL"
        return None
    if not fullmatch_wrapper(entry["pattern"], s):
        return "PATTERN_MISMATCH"
    return None


def wrapper_code(lit, s):
    return None if fullmatch_wrapper(lit, s) else "PATTERN_MISMATCH"


# (kind, key, sample, want)  want: None == accept, else exact code
CASES = [
    ("lib", "canonicalDecimal", "0", None),
    ("lib", "canonicalDecimal", "12.5", None),
    ("lib", "canonicalDecimal", "-0", "DECIMAL_STRING_NONCANONICAL"),
    ("lib", "canonicalDecimal", "0" + LF, "DECIMAL_STRING_NONCANONICAL"),
    ("lib", "canonicalDecimal", "1e3", "DECIMAL_STRING_NONCANONICAL"),
    ("lib", "canonicalDecimal", "9" * 320, None),
    ("lib", "canonicalDecimal", "9" * 321, "PATTERN_MAX_LEN"),
    ("lib", "sha256Hex", "b" * 64, None),
    ("lib", "sha256Hex", "b" * 63, "PATTERN_MISMATCH"),
    ("lib", "sha256Hex", "B" * 64, "PATTERN_MISMATCH"),
    ("lib", "sha256Hex", "b" * 64 + LF, "PATTERN_MAX_LEN"),
    ("lib", "sha256Hex", "b" * 64 + " ", "PATTERN_MAX_LEN"),
    ("lib", "sha256Hex", "b" * 65, "PATTERN_MAX_LEN"),
    ("lib", "sha256Hex", chr(0x1F600) * 64, "PATTERN_DOMAIN_VIOLATION"),
    ("lib", "sha256Hex", chr(0x1F600) * 65, "PATTERN_DOMAIN_VIOLATION"),
    ("lib", "sha256Hex", chr(0xE9) + "b" * 63, "PATTERN_DOMAIN_VIOLATION"),
    ("lib", "jsonPointer", "", None),
    ("lib", "jsonPointer", "/a/b", None),
    ("lib", "jsonPointer", "/a~0b~1c", None),
    ("lib", "jsonPointer", "/a" + LF, None),
    ("lib", "jsonPointer", "/~", "PATTERN_MISMATCH"),
    ("lib", "jsonPointer", "/a~2b", "PATTERN_MISMATCH"),
    ("lib", "jsonPointer", "a", "PATTERN_MISMATCH"),
    ("lib", "jsonPointer", chr(0xE9), "PATTERN_DOMAIN_VIOLATION"),
    ("lib", "jsonPointer", "/" + "a" * 2047, None),
    ("lib", "jsonPointer", "/" + "a" * 2048, "PATTERN_MAX_LEN"),
    ("lib", "bundlePath", "bundle://schemas/genome_ref.json", None),
    ("lib", "bundlePath", "bundle://", "PATTERN_MISMATCH"),
    ("lib", "bundlePath", "http://example.com", "PATTERN_MISMATCH"),
    ("lib", "bundlePath", "bundle://a b", "PATTERN_MISMATCH"),
    ("lib", "isoTimestamp", "2026-10-13T12:00:00Z", None),
    ("lib", "isoTimestamp", "2026-10-13T12:00:00Z" + LF, "PATTERN_MAX_LEN"),
    ("lib", "isoTimestamp", "2026-13-99T99:99:99Z", None),
    ("lib", "isoTimestamp", "2026-1-13T12:00:00Z", "PATTERN_MISMATCH"),
    ("wrap", "a", "a", None),
    ("wrap", "a", "xa", "PATTERN_MISMATCH"),
    ("wrap", "a|b", "a", None),
    ("wrap", "a|b", "b", None),
    ("wrap", "a|b", "xbx", "PATTERN_MISMATCH"),
    ("wrap", "a", "a" + LF, "PATTERN_MISMATCH"),
]


def main():
    root = bundle_root()
    mpath = os.path.join(root, "bundle.manifest.json")
    manifest_sha = hashlib.sha256(open(mpath, "rb").read()).hexdigest()[:16] if os.path.exists(mpath) else "MISSING"
    ipath = os.path.join(root, "SHA256SUMS-packet.txt")
    if os.path.exists(ipath):
        index_sha = "sums:" + hashlib.sha256(open(ipath, "rb").read()).hexdigest()[:12]
    else:
        hpath = os.path.join(root, "HASHES")
        index_sha = ("hashes:" + hashlib.sha256(open(hpath, "rb").read()).hexdigest()[:12]) if os.path.exists(hpath) else "(none)"
    print("[pattern_samples.py] packet_root=" + root + " manifest_sha=" + manifest_sha + " index_sha=" + index_sha + " read-only: no packet writes")
    docs, problems = load_bundle(root)
    if problems:
        print("BUNDLE LOAD FAILED:")
        for p in problems:
            print("  [LOADER] " + p)
        return 1
    library = docs["meta/pattern-library.json"]["patterns"]

    fails = 0
    for kind, key, sample, want in CASES:
        got = wrapper_code(key, sample) if kind == "wrap" else matcher(key, library[key], sample)
        ok = got == want
        if not ok:
            fails += 1
        shown = sample.replace(LF, "<LF>")
        if len(shown) > 34:
            shown = shown[:14] + "..." + shown[-8:]
        print("PY | %-16s | %-34s | want=%-26s got=%-26s %s" % (key, shown, str(want), str(got), "OK" if ok else "FAIL"))
    print("PY_SAMPLES: cases=%d fails=%d %s" % (len(CASES), fails, "ALL_PASS" if fails == 0 else "HAS_FAILURES"))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
