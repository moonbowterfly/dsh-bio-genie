#!/usr/bin/env python
"""decimal-string probe — I1 shared full-string algorithm (Python side).

Implements the DECIMAL_STRING char-scan algorithm per spec v0.10 §I1.
No regex, no backslash escape sequences in source (uses chr() constants).
Prints one line per corpus case and a summary; exit 0 iff all match expected.
"""
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

LF = chr(10)
CR = chr(13)
LS = chr(0x2028)
PS = chr(0x2029)


def decimal_string(s):
    """Return True iff s is a canonical decimal-string per I1 (full-string scan)."""
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
    if i == n:
        return True
    return False


CASES = [
    ("0", True),
    ("12", True),
    ("-12", True),
    ("0.5", True),
    ("-0.5", True),
    ("12.34", True),
    ("10.01", True),
    ("0.001", True),
    ("0.0001", True),
    ("-0.0001", True),
    ("9999999999999", True),
    ("-0", False),
    ("0.0", False),
    ("1.0", False),
    ("1.00", False),
    ("1e3", False),
    ("00.1", False),
    ("+1", False),
    ("1.", False),
    ("01.2", False),
    ("0" + LF, False),
    ("0" + CR, False),
    ("0" + CR + LF, False),
    ("0" + LS, False),
    ("0" + PS, False),
    ("-0.0", False),
    ("", False),
    (" 0", False),
    ("0 ", False),
    ("1e0", False),
    (".5", False),
    ("-.5", False),
    ("000", False),
    ("9.", False),
    ("0" + chr(0xA0), False),
    ("-", False),
    ("--", False),
    ("-.", False),
]


def main():
    fails = 0
    for label, want in CASES:
        got = decimal_string(label)
        ok = got == want
        if not ok:
            fails += 1
        shown = label.replace(LF, "<LF>").replace(CR, "<CR>").replace(LS, "<LS>").replace(PS, "<PS>").replace(chr(0xA0), "<NBSP>")
        print("PY | %-12s | want=%-5s got=%-5s %s" % (shown if shown else "<empty>", want, got, "OK" if ok else "FAIL"))
    print("PY_SUMMARY: cases=%d fails=%d %s" % (len(CASES), fails, "ALL_PASS" if fails == 0 else "HAS_FAILURES"))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
