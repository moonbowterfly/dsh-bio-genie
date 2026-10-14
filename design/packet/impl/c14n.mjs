#!/usr/bin/env node
// c14n.mjs — casefile-c14n@1 reference implementation (Node side).
// Zero-backslash source: backslash chars via String.fromCharCode(92).
// Includes a hand-written JSON scanner (dup keys / number-domain checks; no regex).
//
// CLI (for corpus runner; self-verifies via ../build/bundle_loader.mjs when ranges
// are not injected with --domain-json; otherwise fails REGISTRY_UNRESOLVED):
//   node c14n.mjs --batch cases.json --out results.json
"use strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "../build/bundle_loader.mjs";

const BS = String.fromCharCode(92);
const MAX_SAFE = 9007199254740991; // 2**53 - 1

const HERE_DIR = dirname(fileURLToPath(import.meta.url));
let DOMAIN_RANGES = null;

function setDomainRanges(ranges) {
  DOMAIN_RANGES = ranges;
}

function verifiedDomainRanges() {
  // The path table is never trusted directly (v0.13 K2 / rev4): the CLI must run
  // the equivalent manifest-verified loader, or ranges must be injected
  // (--domain-json by a verifier, or setDomainRanges by an equivalent caller).
  const root = process.env.PACKET_ROOT || join(HERE_DIR, "..");
  let res;
  try {
    res = loadBundle(root);
  } catch (exc) {
    throw new Error("loader unavailable: " + String((exc && exc.message) || exc).slice(0, 160));
  }
  if (res.problems.length) throw new Error(res.problems[0]);
  return res.docs["meta/unicode-domain-table.json"].ranges;
}

function domainRanges() {
  if (DOMAIN_RANGES === null) {
    throw new Error("REGISTRY_UNRESOLVED: domain ranges not injected (batch CLI self-verifies; library callers must setDomainRanges)");
  }
  return DOMAIN_RANGES;
}

function inDomain(cp) {
  const ranges = domainRanges();
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = ranges[mid];
    if (cp < seg[0]) hi = mid - 1;
    else if (cp > seg[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

class C14nError extends Error {
  constructor(code, detail = "") {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

// ---------- hand-written JSON scanner (dup keys + strict grammar) ----------
class Scanner {
  constructor(text) {
    this.t = text;
    this.p = 0;
  }
  ws() {
    while (this.p < this.t.length) {
      const c = this.t[this.p];
      if (c === " " || c === String.fromCharCode(9) || c === String.fromCharCode(10) || c === String.fromCharCode(13)) this.p += 1;
      else break;
    }
  }
  err(msg) {
    throw new C14nError("INVALID_JSON", msg + " at " + String(this.p));
  }
  parse() {
    this.ws();
    const v = this.value();
    this.ws();
    if (this.p !== this.t.length) this.err("trailing");
    return v;
  }
  value() {
    const c = this.t[this.p];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === String.fromCharCode(34)) return this.string();
    if (c === "t") { this.lit("true"); return true; }
    if (c === "f") { this.lit("false"); return false; }
    if (c === "n") { this.lit("null"); return null; }
    if (c === "-" || (c >= "0" && c <= "9")) return this.number();
    this.err("bad value");
  }
  lit(word) {
    if (this.t.slice(this.p, this.p + word.length) !== word) this.err("bad literal");
    this.p += word.length;
  }
  string() {
    if (this.t[this.p] !== String.fromCharCode(34)) this.err("expected quote");
    this.p += 1;
    let out = "";
    while (true) {
      if (this.p >= this.t.length) this.err("unterminated string");
      const c = this.t[this.p];
      const o = this.t.charCodeAt(this.p);
      if (c === String.fromCharCode(34)) { this.p += 1; return out; }
      if (o < 0x20) this.err("raw control char");
      if (c !== BS) { out += c; this.p += 1; continue; }
      const e = this.t[this.p + 1];
      if (e === String.fromCharCode(34) || e === BS || e === "/") { out += e; this.p += 2; continue; }
      if (e === "b") { out += String.fromCharCode(8); this.p += 2; continue; }
      if (e === "f") { out += String.fromCharCode(12); this.p += 2; continue; }
      if (e === "n") { out += String.fromCharCode(10); this.p += 2; continue; }
      if (e === "r") { out += String.fromCharCode(13); this.p += 2; continue; }
      if (e === "t") { out += String.fromCharCode(9); this.p += 2; continue; }
      if (e === "u") {
        const hex = this.t.slice(this.p + 2, this.p + 6);
        if (!isHex4(hex)) this.err("bad unicode escape");
        out += String.fromCharCode(parseInt(hex, 16));
        this.p += 6;
        continue;
      }
      this.err("bad escape");
    }
  }
  number() {
    const start = this.p;
    if (this.t[this.p] === "-") this.p += 1;
    if (this.t[this.p] === "0") {
      this.p += 1;
    } else if (this.t[this.p] >= "1" && this.t[this.p] <= "9") {
      while (this.t[this.p] >= "0" && this.t[this.p] <= "9") this.p += 1;
    } else {
      this.err("bad number");
    }
    if (this.t[this.p] === ".") {
      this.p += 1;
      if (!isDigit(this.t[this.p])) this.err("bad fraction");
      while (isDigit(this.t[this.p])) this.p += 1;
    }
    if (this.t[this.p] === "e" || this.t[this.p] === "E") {
      this.p += 1;
      if (this.t[this.p] === "+" || this.t[this.p] === "-") this.p += 1;
      if (!isDigit(this.t[this.p])) this.err("bad exponent");
      while (isDigit(this.t[this.p])) this.p += 1;
    }
    const lex = this.t.slice(start, this.p);
    const num = Number(lex);
    if (!Number.isFinite(num)) throw new C14nError("NUMBER_OUT_OF_RANGE", lex);
    return num;
  }
  object() {
    this.p += 1; // {
    const map = new Map();
    this.ws();
    if (this.t[this.p] === "}") { this.p += 1; return map; }
    while (true) {
      this.ws();
      const key = this.string();
      if (map.has(key)) throw new C14nError("DUP_KEY", key);
      this.ws();
      if (this.t[this.p] !== ":") this.err("expected colon");
      this.p += 1;
      const val = this.value();
      map.set(key, val);
      this.ws();
      const c = this.t[this.p];
      if (c === ",") { this.p += 1; continue; }
      if (c === "}") { this.p += 1; return map; }
      this.err("expected comma or brace");
    }
  }
  array() {
    this.p += 1; // [
    const arr = [];
    this.ws();
    if (this.t[this.p] === "]") { this.p += 1; return arr; }
    while (true) {
      const val = this.value();
      arr.push(val);
      this.ws();
      const c = this.t[this.p];
      if (c === ",") { this.p += 1; continue; }
      if (c === "]") { this.p += 1; return arr; }
      this.err("expected comma or bracket");
    }
  }
}

function isDigit(c) { return c >= "0" && c <= "9"; }
function isHex4(s) {
  if (typeof s !== "string" || s.length !== 4) return false;
  for (const ch of s) {
    if (!((ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F"))) return false;
  }
  return true;
}

// ---------- normalize ----------
function checkAndNfc(s, path) {
  for (const ch of s) {
    if (ch.length === 1) {
      const o = ch.charCodeAt(0);
      if (o >= 0xD800 && o <= 0xDFFF) throw new C14nError("LONE_SURROGATE", path);
    }
  }
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (!inDomain(cp)) {
      throw new C14nError("UNICODE_OUT_OF_FROZEN_DOMAIN", path + " U+" + cp.toString(16).toUpperCase().padStart(4, "0"));
    }
  }
  return s.normalize("NFC");
}

function normalize(v, path) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "string") return checkAndNfc(v, path);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new C14nError("NUMBER_OUT_OF_RANGE", path);
    if (v === 0) return 0; // -0 -> 0
    if (Number.isInteger(v)) {
      if (Math.abs(v) > MAX_SAFE) throw new C14nError("NUMBER_OUT_OF_RANGE", path);
      return v;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((item, i) => normalize(item, path + "/" + String(i)));
  if (v instanceof Map) {
    const out = new Map();
    for (const [key, val] of v) {
      const nk = checkAndNfc(key, path);
      if (out.has(nk)) throw new C14nError("NFC_KEY_COLLISION", path + "/" + nk);
      out.set(nk, normalize(val, path + "/" + nk));
    }
    return out;
  }
  throw new C14nError("UNSUPPORTED_TYPE", path);
}

// ---------- serialize ----------
function esc(s) {
  let out = String.fromCharCode(34);
  for (const ch of s) {
    const o = ch.codePointAt(0);
    if (ch === String.fromCharCode(34)) { out += BS + String.fromCharCode(34); continue; }
    if (ch === BS) { out += BS + BS; continue; }
    if (o === 8) { out += BS + "b"; continue; }
    if (o === 9) { out += BS + "t"; continue; }
    if (o === 10) { out += BS + "n"; continue; }
    if (o === 12) { out += BS + "f"; continue; }
    if (o === 13) { out += BS + "r"; continue; }
    if (o < 0x20) { out += BS + "u" + o.toString(16).padStart(4, "0"); continue; }
    out += ch;
  }
  return out + String.fromCharCode(34);
}

function serialize(v, path, annotations) {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "string") return esc(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    const kind = annotations[path];
    if (kind === undefined) throw new C14nError("UNANNOTATED_ARRAY", path);
    const parts = v.map((item, i) => serialize(item, path + "/" + String(i), annotations));
    if (kind === "set") {
      parts.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
      for (let i = 1; i < parts.length; i += 1) {
        if (parts[i] === parts[i - 1]) throw new C14nError("SET_DUPLICATE", path);
      }
    } else if (kind !== "seq") {
      throw new C14nError("BAD_ANNOTATION", path);
    }
    return "[" + parts.join(",") + "]";
  }
  if (v instanceof Map) {
    const entries = Array.from(v.entries());
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const body = entries.map(([k, val]) => esc(k) + ":" + serialize(val, path + "/" + k, annotations)).join(",");
    return "{" + body + "}";
  }
  throw new C14nError("UNSUPPORTED_TYPE", path);
}

function canonicalize(jsonText, annotations = {}) {
  const tree = normalize(new Scanner(jsonText).parse(), "$");
  return serialize(tree, "$", annotations);
}

// ---------- CLI ----------
function resultOf(entry) {
  try {
    return { id: entry.id, status: "accept", canonical: canonicalize(entry.input, entry.annotations || {}) };
  } catch (exc) {
    if (exc instanceof C14nError) return { id: entry.id, status: "reject", code: exc.code, detail: exc.detail };
    throw exc;
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--domain-json")) {
    const dj = args[args.indexOf("--domain-json") + 1];
    DOMAIN_RANGES = JSON.parse(readFileSync(dj, "utf8")).ranges;
  }
  if (args.includes("--batch")) {
    if (DOMAIN_RANGES === null) {
      try {
        DOMAIN_RANGES = verifiedDomainRanges();
      } catch (exc) {
        console.error("REGISTRY_UNRESOLVED: " + String((exc && exc.message) || exc));
        return 2;
      }
    }
    const casesPath = args[args.indexOf("--batch") + 1];
    const outPath = args[args.indexOf("--out") + 1];
    const doc = JSON.parse(readFileSync(casesPath, "utf8"));
    const results = doc.cases.map(resultOf);
    writeFileSync(outPath, JSON.stringify({ side: "node", results }, null, 1), "utf8");
    return 0;
  }
  console.log("usage: node c14n.mjs --batch cases.json --out results.json");
  return 2;
}

process.exit(main());
