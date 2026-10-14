// pattern_samples.mjs — node twin of pattern_samples.py (v0.13). Must agree case-for-case.
// Contract: domain gate FIRST; max_len in Unicode scalar values; explicit full-match
// wrapper; scanner for canonicalDecimal. Exact stable codes asserted. Read-only.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "../build/bundle_loader.mjs";

const LF = String.fromCharCode(10);
const EACUTE = String.fromCharCode(0xE9);
const EMOJI = String.fromCodePoint(0x1F600);

function decimalScan(s) {
  if (typeof s !== "string") return false;
  const n = s.length;
  if (n === 0) return false;
  let i = 0;
  let neg = false;
  if (s[0] === "-") {
    neg = true;
    i = 1;
    if (i >= n) return false;
  }
  const c = s.charCodeAt(i);
  if (c === 48) {
    i += 1;
    if (i < n) {
      const d = s.charCodeAt(i);
      if (d >= 48 && d <= 57) return false;
    }
  } else if (c >= 49 && c <= 57) {
    i += 1;
    while (i < n) {
      const d = s.charCodeAt(i);
      if (d >= 48 && d <= 57) i += 1;
      else break;
    }
  } else {
    return false;
  }
  if (i === n) {
    if (neg && s.slice(1, i) === "0") return false;
    return true;
  }
  if (s[i] === ".") {
    i += 1;
    if (i >= n) return false;
    let j = i;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d >= 48 && d <= 57) j += 1;
      else break;
    }
    if (j === i) return false;
    const last = s.charCodeAt(j - 1);
    if (!(last >= 49 && last <= 57)) return false;
    i = j;
  }
  return i === n;
}

function isAscii(s) {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 127) return false;
  }
  return true;
}

const wrapCache = new Map();
function fullmatchWrapper(lit, s) {
  let re = wrapCache.get(lit);
  if (!re) {
    re = new RegExp("^(?:" + lit + ")$", "u");
    wrapCache.set(lit, re);
  }
  return re.test(s);
}

function matcher(name, entry, s) {
  if (!isAscii(s)) return "PATTERN_DOMAIN_VIOLATION";
  const scalarCount = [...s].length;
  if (scalarCount > entry.max_len) return "PATTERN_MAX_LEN";
  if (name === "canonicalDecimal") {
    if (!decimalScan(s)) return "DECIMAL_STRING_NONCANONICAL";
    return null;
  }
  if (!fullmatchWrapper(entry.pattern, s)) return "PATTERN_MISMATCH";
  return null;
}

function wrapperCode(lit, s) {
  return fullmatchWrapper(lit, s) ? null : "PATTERN_MISMATCH";
}

// keep in sync with pattern_samples.py
const CASES = [
  ["lib", "canonicalDecimal", "0", null],
  ["lib", "canonicalDecimal", "12.5", null],
  ["lib", "canonicalDecimal", "-0", "DECIMAL_STRING_NONCANONICAL"],
  ["lib", "canonicalDecimal", "0" + LF, "DECIMAL_STRING_NONCANONICAL"],
  ["lib", "canonicalDecimal", "1e3", "DECIMAL_STRING_NONCANONICAL"],
  ["lib", "canonicalDecimal", "9".repeat(320), null],
  ["lib", "canonicalDecimal", "9".repeat(321), "PATTERN_MAX_LEN"],
  ["lib", "sha256Hex", "b".repeat(64), null],
  ["lib", "sha256Hex", "b".repeat(63), "PATTERN_MISMATCH"],
  ["lib", "sha256Hex", "B".repeat(64), "PATTERN_MISMATCH"],
  ["lib", "sha256Hex", "b".repeat(64) + LF, "PATTERN_MAX_LEN"],
  ["lib", "sha256Hex", "b".repeat(64) + " ", "PATTERN_MAX_LEN"],
  ["lib", "sha256Hex", "b".repeat(65), "PATTERN_MAX_LEN"],
  ["lib", "sha256Hex", EMOJI.repeat(64), "PATTERN_DOMAIN_VIOLATION"],
  ["lib", "sha256Hex", EMOJI.repeat(65), "PATTERN_DOMAIN_VIOLATION"],
  ["lib", "sha256Hex", EACUTE + "b".repeat(63), "PATTERN_DOMAIN_VIOLATION"],
  ["lib", "jsonPointer", "", null],
  ["lib", "jsonPointer", "/a/b", null],
  ["lib", "jsonPointer", "/a~0b~1c", null],
  ["lib", "jsonPointer", "/a" + LF, null],
  ["lib", "jsonPointer", "/~", "PATTERN_MISMATCH"],
  ["lib", "jsonPointer", "/a~2b", "PATTERN_MISMATCH"],
  ["lib", "jsonPointer", "a", "PATTERN_MISMATCH"],
  ["lib", "jsonPointer", EACUTE, "PATTERN_DOMAIN_VIOLATION"],
  ["lib", "jsonPointer", "/" + "a".repeat(2047), null],
  ["lib", "jsonPointer", "/" + "a".repeat(2048), "PATTERN_MAX_LEN"],
  ["lib", "bundlePath", "bundle://schemas/genome_ref.json", null],
  ["lib", "bundlePath", "bundle://", "PATTERN_MISMATCH"],
  ["lib", "bundlePath", "http://example.com", "PATTERN_MISMATCH"],
  ["lib", "bundlePath", "bundle://a b", "PATTERN_MISMATCH"],
  ["lib", "isoTimestamp", "2026-10-13T12:00:00Z", null],
  ["lib", "isoTimestamp", "2026-10-13T12:00:00Z" + LF, "PATTERN_MAX_LEN"],
  ["lib", "isoTimestamp", "2026-13-99T99:99:99Z", null],
  ["lib", "isoTimestamp", "2026-1-13T12:00:00Z", "PATTERN_MISMATCH"],
  ["wrap", "a", "a", null],
  ["wrap", "a", "xa", "PATTERN_MISMATCH"],
  ["wrap", "a|b", "a", null],
  ["wrap", "a|b", "b", null],
  ["wrap", "a|b", "xbx", "PATTERN_MISMATCH"],
  ["wrap", "a", "a" + LF, "PATTERN_MISMATCH"],
];

const { root, docs, problems } = loadBundle();
const mpath = join(root, "bundle.manifest.json");
let manifestSha = "MISSING";
try { manifestSha = createHash("sha256").update(readFileSync(mpath)).digest("hex").slice(0, 16); } catch (e) {}
const ipath = join(root, "SHA256SUMS-packet.txt");
let indexSha = "(none)";
try { indexSha = "sums:" + createHash("sha256").update(readFileSync(ipath)).digest("hex").slice(0, 12); } catch (e) { try { indexSha = "hashes:" + createHash("sha256").update(readFileSync(join(root, "HASHES"))).digest("hex").slice(0, 12); } catch (e2) {} }
console.log("[pattern_samples.mjs] packet_root=" + root + " manifest_sha=" + manifestSha + " index_sha=" + indexSha + " read-only: no packet writes");
if (problems.length) {
  console.log("BUNDLE LOAD FAILED:");
  for (const p of problems) console.log("  [LOADER] " + p);
  process.exit(1);
}
const library = docs["meta/pattern-library.json"].patterns;

let fails = 0;
for (const [kind, key, sample, want] of CASES) {
  const got = kind === "wrap" ? wrapperCode(key, sample) : matcher(key, library[key], sample);
  const ok = got === want;
  if (!ok) fails += 1;
  let shown = sample.replace(LF, "<LF>");
  if (shown.length > 34) shown = shown.slice(0, 14) + "..." + shown.slice(-8);
  console.log("JS | " + key.padEnd(16) + " | " + shown.padEnd(34) + " | want=" + String(want).padEnd(26) + " got=" + String(got).padEnd(26) + " " + (ok ? "OK" : "FAIL"));
}
console.log("JS_SAMPLES: cases=" + CASES.length + " fails=" + fails + " " + (fails === 0 ? "ALL_PASS" : "HAS_FAILURES"));
process.exit(fails === 0 ? 0 : 1);
