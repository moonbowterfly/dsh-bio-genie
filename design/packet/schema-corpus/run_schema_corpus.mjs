// run_schema_corpus.mjs — synbio-schema-corpus@1 node-side verdict runner (v0.12).
// stdout = pure JSON {side:"node", results:[...]}; progress goes to stderr.
// Manifest-driven bundle (build/bundle_loader.mjs). Verdict = engine (ajv, frozen
// config) && semantic layer: DECIMAL_STRING scanner (I1) for x-decimal-string nodes;
// explicit full-match wrapper + domain=ascii + max_len for other pattern nodes (K3).
// `ajv` resolves via AJV_WORKSPACE. Read-only.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "../build/bundle_loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const WS = process.env.AJV_WORKSPACE || process.cwd();
const require = createRequire(join(WS, "__resolve__.cjs"));
let Ajv;
try {
  const m = require("ajv");
  Ajv = m.default || m;
} catch (e) {
  console.error("ERROR: cannot resolve 'ajv' from AJV_WORKSPACE=" + WS);
  console.error("See locks/README.md for the dependency setup.");
  process.exit(2);
}

const rootOverride = process.env.PACKET_ROOT || process.env.SCHEMA_CORPUS_PACKET;
const { root, docs, problems } = loadBundle(rootOverride);
if (problems.length) {
  for (const p of problems) console.error("[LOADER] " + p);
  process.exit(1);
}

// self-cert header (K7.6): root + manifest sha + index sha + read-only. stderr keeps stdout pure JSON.
const fs = require("node:fs");
function _sha(p, n) {
  try {
    return createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, n);
  } catch (e) {
    return null;
  }
}
{
  const _m = _sha(join(root, "bundle.manifest.json"), 16) || "MISSING";
  const _ip = join(root, "SHA256SUMS-packet.txt");
  const _hp = join(root, "HASHES");
  const _ix = fs.existsSync(_ip) ? "sums:" + _sha(_ip, 12) : (fs.existsSync(_hp) ? "hashes:" + _sha(_hp, 12) : "(none)");
  console.error("[run_schema_corpus.mjs] packet_root=" + root + " manifest_sha=" + _m + " index_sha=" + _ix + " read-only: no packet writes");
}

const OPTS = {
  strict: true,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  validateFormats: false,
  validateSchema: true,
  addUsedSchema: false,
  $data: false,
  unicodeRegExp: true,
};

const library = docs["meta/pattern-library.json"].patterns;
const byLiteral = new Map();
for (const [name, entry] of Object.entries(library)) byLiteral.set(entry.pattern, { name, entry });

const SCHEMAS = {};
for (const k of Object.keys(docs)) {
  if (k.startsWith("schemas/")) SCHEMAS[k.slice("schemas/".length, -5)] = docs[k];
}

const ajv = new Ajv(OPTS);
ajv.addKeyword({ keyword: "x-canonical", schemaType: "string" });
ajv.addKeyword({ keyword: "x-decimal-string", schemaType: "boolean" });
ajv.addSchema(docs["meta/common.defs.json"], "bundle://meta/common.defs.json");
for (const [stem, doc] of Object.entries(SCHEMAS)) {
  ajv.addSchema(doc, "bundle://schemas/" + stem + ".json");
}
const validators = {};
for (const stem of Object.keys(SCHEMAS)) validators[stem] = ajv.compile(SCHEMAS[stem]);

// --- DECIMAL_STRING (I1 algorithm; port of evidence/decimal_string_probe.mjs) ---
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

const wrapperCache = new Map();
function fullmatchWrapper(lit, s) {
  let re = wrapperCache.get(lit);
  if (!re) {
    re = new RegExp("^(?:" + lit + ")$", "u");
    wrapperCache.set(lit, re);
  }
  return re.test(s);
}

function matchCode(name, entry, s) {
  if (!isAscii(s)) return "PATTERN_DOMAIN_VIOLATION";
  const scalarCount = [...s].length; // Unicode scalar values (astral-safe); equals s.length on the ASCII path
  if (scalarCount > entry.max_len) return "PATTERN_MAX_LEN";
  if (name === "canonicalDecimal") {
    if (!decimalScan(s)) return "DECIMAL_STRING_NONCANONICAL";
    return null;
  }
  if (!fullmatchWrapper(entry.pattern, s)) return "PATTERN_MISMATCH";
  return null;
}

function resolveRef(node) {
  if (!node || typeof node !== "object") return node;
  const r = node["$ref"];
  if (typeof r === "string") {
    const pre = "bundle://meta/common.defs.json#/definitions/";
    if (r.startsWith(pre)) {
      const name = r.slice(pre.length);
      return (docs["meta/common.defs.json"].definitions && docs["meta/common.defs.json"].definitions[name]) || node;
    }
    const pre2 = "bundle://schemas/";
    if (r.startsWith(pre2)) {
      const t = r.slice(pre2.length).split("#")[0];
      const stem = t.endsWith(".json") ? t.slice(0, -5) : t;
      return SCHEMAS[stem] || node;
    }
  }
  return node;
}

function semErrors(stem, doc) {
  const errs = [];
  function walk(s, v, path) {
    s = resolveRef(s);
    if (!s || typeof s !== "object") return;
    if (typeof v === "string") {
      if (s["x-decimal-string"] === true) {
        const hit = byLiteral.get(s.pattern);
        if (!hit) errs.push({ code: "DECIMAL_PAIRING_INVALID", path });
        else {
          const code = matchCode(hit.name, hit.entry, v);
          if (code) errs.push({ code, path });
        }
      } else if (typeof s.pattern === "string") {
        const hit = byLiteral.get(s.pattern);
        if (!hit) errs.push({ code: "PATTERN_NOT_IN_LIBRARY", path });
        else {
          const code = matchCode(hit.name, hit.entry, v);
          if (code) errs.push({ code, path });
        }
      }
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const props = s.properties || {};
      for (const k of Object.keys(v)) {
        if (Object.prototype.hasOwnProperty.call(props, k)) walk(props[k], v[k], path + "/" + k);
      }
      const ap = s.additionalProperties;
      if (ap && typeof ap === "object") {
        for (const k of Object.keys(v)) {
          if (!Object.prototype.hasOwnProperty.call(props, k)) walk(ap, v[k], path + "/" + k);
        }
      }
    } else if (Array.isArray(v)) {
      const it = s.items;
      if (it && typeof it === "object") {
        for (let i = 0; i < v.length; i += 1) walk(it, v[i], path + "/" + i);
      }
    }
  }
  walk(SCHEMAS[stem], doc, "");
  return errs;
}

const cases = JSON.parse(
  require("node:fs").readFileSync(join(root, "schema-corpus", "schema_cases.json"), "utf8"),
);
const results = [];
for (const c of cases.cases) {
  const v = validators[c.schema];
  const engineOk = v(c.doc);
  const sem = semErrors(c.schema, c.doc);
  results.push({
    id: c.id,
    valid: engineOk && sem.length === 0,
    engine: engineOk,
    engine_errors: engineOk ? 0 : (v.errors ? v.errors.length : -1),
    sem: sem.map((x) => x.code + "@" + x.path),
  });
}
console.error("node-side cases: " + results.length);
process.stdout.write(JSON.stringify({ side: "node", results }, null, 1) + "\n");
