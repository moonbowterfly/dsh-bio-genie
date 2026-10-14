#!/usr/bin/env python
"""c14n.py — casefile-c14n@1 reference implementation (Python side).

Zero-backslash source: all backslash characters are built via chr(92).
No regex engines are used for any normative decision.

API:
    canonicalize(json_text, annotations) -> str   (raises C14nError)
    annotations: dict mapping canonical path -> "set" | "seq"
                 root path "$"; child "$/key"; array item "$/key/2"
Batch CLI (for corpus runner; when ranges are not injected it self-verifies through
build/bundle_loader and otherwise fails REGISTRY_UNRESOLVED):
    python c14n.py --batch cases.json --out results.json
"""
import json
import os
import sys
import unicodedata

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

sys.dont_write_bytecode = True

BS = chr(92)
QUOTE = chr(34)

MAX_SAFE = 9007199254740991  # 2**53 - 1

_DOMAIN_RANGES = None


class RegistryUnresolved(Exception):
    pass


def _verified_domain_ranges():
    """Load the frozen-domain table through the manifest-verified bundle loader.

    The path table is never trusted directly (v0.13 K2 / rev4): ranges must come
    from set_domain_ranges() (a caller that already verified) or from this
    equivalent verified loader run inside the caller.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.environ.get("PACKET_ROOT") or os.path.dirname(here))
    sys.path.insert(0, os.path.join(root, "build"))
    try:
        import bundle_loader
        docs, problems = bundle_loader.load_bundle(root)
    except Exception as exc:  # noqa: BLE001
        raise RegistryUnresolved("loader unavailable: " + str(exc)[:160])
    if problems:
        raise RegistryUnresolved(problems[0])
    return [tuple(r) for r in docs["meta/unicode-domain-table.json"]["ranges"]]


def _domain_ranges():
    global _DOMAIN_RANGES
    if _DOMAIN_RANGES is None:
        raise RegistryUnresolved("domain ranges not injected (set_domain_ranges or batch-CLI self-verify required)")
    return _DOMAIN_RANGES


def set_domain_ranges(ranges):
    """Inject manifest-verified ranges (corpus loader gate; v0.13 K2 / rev4)."""
    global _DOMAIN_RANGES
    _DOMAIN_RANGES = [tuple(r) for r in ranges]


def _in_domain(cp):
    ranges = _domain_ranges()
    lo, hi = 0, len(ranges) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        s, e = ranges[mid]
        if cp < s:
            hi = mid - 1
        elif cp > e:
            lo = mid + 1
        else:
            return True
    return False


class C14nError(Exception):
    def __init__(self, code, detail=""):
        super().__init__(code)
        self.code = code
        self.detail = detail


class _DuplicateKey(Exception):
    pass


def _parse(text):
    def _bad_constant(name):
        raise C14nError("INVALID_JSON", "constant " + str(name))

    def _pairs(pairs):
        seen = set()
        for k, _v in pairs:
            if k in seen:
                raise _DuplicateKey(k)
            seen.add(k)
        return dict(pairs)

    try:
        return json.loads(text, object_pairs_hook=_pairs, parse_constant=_bad_constant)
    except _DuplicateKey as exc:
        raise C14nError("DUP_KEY", str(exc))
    except C14nError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise C14nError("INVALID_JSON", str(exc))


def _check_and_nfc(s, path):
    """Lone-surrogate check + NFC normalization for one string."""
    i = 0
    n = len(s)
    while i < n:
        c = ord(s[i])
        if 0xD800 <= c <= 0xDBFF:
            if i + 1 < n and 0xDC00 <= ord(s[i + 1]) <= 0xDFFF:
                i += 2
                continue
            raise C14nError("LONE_SURROGATE", path)
        if 0xDC00 <= c <= 0xDFFF:
            raise C14nError("LONE_SURROGATE", path)
        i += 1
    for i in range(len(s)):
        cp = ord(s[i])
        if not _in_domain(cp):
            raise C14nError("UNICODE_OUT_OF_FROZEN_DOMAIN", path + " U+" + format(cp, "04X"))
    return unicodedata.normalize("NFC", s)


def _normalize(v, path):
    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, str):
        return _check_and_nfc(v, path)
    if isinstance(v, int):
        if abs(v) > MAX_SAFE:
            raise C14nError("NUMBER_OUT_OF_RANGE", path)
        return v
    if isinstance(v, float):
        import math

        if math.isnan(v) or math.isinf(v):
            raise C14nError("NUMBER_OUT_OF_RANGE", path)
        if v == 0.0:
            return 0
        if float(v).is_integer():
            if abs(v) > MAX_SAFE:
                raise C14nError("NUMBER_OUT_OF_RANGE", path)
            return int(v)
        return v
    if isinstance(v, list):
        return [_normalize(item, path + "/" + str(i)) for i, item in enumerate(v)]
    if isinstance(v, dict):
        out = {}
        for key, val in v.items():
            nk = _check_and_nfc(key, path)
            if nk in out:
                raise C14nError("NFC_KEY_COLLISION", path + "/" + nk)
            out[nk] = _normalize(val, path + "/" + nk)
        return out
    raise C14nError("UNSUPPORTED_TYPE", path)


def _es_number_string(x):
    """ECMAScript Number::toString(10) semantics, built from Python repr digits."""
    if x == 0:
        return "0"
    neg = x < 0
    r = repr(abs(x))
    if "e" in r:
        mant, _, ex = r.partition("e")
        e10 = int(ex)
    else:
        mant, e10 = r, 0
    if "." in mant:
        ip, _, fp = mant.partition(".")
    else:
        ip, fp = mant, ""
    combined = ip + fp
    k0 = 0
    while k0 < len(combined) and combined[k0] == "0":
        k0 += 1
    digits = combined[k0:].rstrip("0")
    if digits == "":
        return "0"
    n = len(ip) - k0 + e10
    k = len(digits)
    if k <= n <= 21:
        s = digits + "0" * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * (-n) + digits
    elif k == 1:
        s = digits + "e" + ("+" if n - 1 >= 0 else "-") + str(abs(n - 1))
    else:
        s = digits[0] + "." + digits[1:] + "e" + ("+" if n - 1 >= 0 else "-") + str(abs(n - 1))
    return ("-" + s) if neg else s


def _esc(s):
    out = [QUOTE]
    for ch in s:
        o = ord(ch)
        if ch == QUOTE:
            out.append(BS + QUOTE)
        elif ch == BS:
            out.append(BS + BS)
        elif o == 8:
            out.append(BS + "b")
        elif o == 9:
            out.append(BS + "t")
        elif o == 10:
            out.append(BS + "n")
        elif o == 12:
            out.append(BS + "f")
        elif o == 13:
            out.append(BS + "r")
        elif o < 0x20:
            out.append(BS + "u" + format(o, "04x"))
        else:
            out.append(ch)
    out.append(QUOTE)
    return "".join(out)


def _serialize(v, path, annotations):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        return _esc(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return _es_number_string(v)
    if isinstance(v, list):
        kind = annotations.get(path)
        if kind is None:
            raise C14nError("UNANNOTATED_ARRAY", path)
        parts = [_serialize(item, path + "/" + str(i), annotations) for i, item in enumerate(v)]
        if kind == "set":
            parts.sort(key=lambda t: t.encode("utf-8"))
            for a, b in zip(parts, parts[1:]):
                if a == b:
                    raise C14nError("SET_DUPLICATE", path)
        elif kind != "seq":
            raise C14nError("BAD_ANNOTATION", path)
        return "[" + ",".join(parts) + "]"
    if isinstance(v, dict):
        items = sorted(v.items(), key=lambda kv: kv[0].encode("utf-16-be"))
        body = ",".join(_esc(k) + ":" + _serialize(val, path + "/" + k, annotations) for k, val in items)
        return "{" + body + "}"
    raise C14nError("UNSUPPORTED_TYPE", path)


def canonicalize(json_text, annotations=None):
    annotations = annotations or {}
    tree = _parse(json_text)
    tree = _normalize(tree, "$")
    return _serialize(tree, "$", annotations)


def _result(entry):
    try:
        canon = canonicalize(entry["input"], entry.get("annotations") or {})
        return {"id": entry["id"], "status": "accept", "canonical": canon}
    except C14nError as exc:
        return {"id": entry["id"], "status": "reject", "code": exc.code, "detail": exc.detail}


def _cli():
    args = sys.argv[1:]
    if "--batch" in args:
        cases_path = args[args.index("--batch") + 1]
        out_path = args[args.index("--out") + 1]
        if _DOMAIN_RANGES is None:
            try:
                set_domain_ranges(_verified_domain_ranges())
            except RegistryUnresolved as exc:
                sys.stderr.write("REGISTRY_UNRESOLVED: " + str(exc) + chr(10))
                return 2
        with open(cases_path, encoding="utf-8") as fh:
            doc = json.load(fh)
        results = [_result(entry) for entry in doc["cases"]]
        with open(out_path, "w", encoding="utf-8", newline=chr(10)) as fh:
            json.dump({"side": "python", "results": results}, fh, ensure_ascii=False, indent=1)
        return 0
    print("usage: python c14n.py --batch cases.json --out results.json")
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
