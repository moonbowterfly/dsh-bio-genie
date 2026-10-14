// meta_smoke.mjs — node-side smoke (v0.12): manifest-driven bundle; cross-doc refs of
// common.defs.json; decimal literal read from meta/pattern-library.json. `ajv` via
// AJV_WORKSPACE; only the two frozen extension keywords are registered. Read-only.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packetRoot, loadBundle } from "../build/bundle_loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LF = String.fromCharCode(10);

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

const { root, docs, problems } = loadBundle();
const mpath = join(root, "bundle.manifest.json");
const manifestSha = existsSync(mpath) ? createHash("sha256").update(readFileSync(mpath)).digest("hex").slice(0, 16) : "MISSING";
const ipath = join(root, "SHA256SUMS-packet.txt");
const hpath = join(root, "HASHES");
const indexSha = existsSync(ipath)
  ? "sums:" + createHash("sha256").update(readFileSync(ipath)).digest("hex").slice(0, 12)
  : (existsSync(hpath) ? "hashes:" + createHash("sha256").update(readFileSync(hpath)).digest("hex").slice(0, 12) : "(none)");
console.log("[meta_smoke.mjs] packet_root=" + root + " manifest_sha=" + manifestSha + " index_sha=" + indexSha + " read-only: no packet writes");
if (problems.length) {
  console.log("BUNDLE LOAD FAILED:");
  for (const p of problems) console.log("  [LOADER] " + p);
  process.exit(1);
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

const ajv = new Ajv(OPTS);
ajv.addKeyword({ keyword: "x-canonical", schemaType: "string" });
ajv.addKeyword({ keyword: "x-decimal-string", schemaType: "boolean" });
ajv.addSchema(docs["meta/common.defs.json"], "bundle://meta/common.defs.json");

const DEC = docs["meta/pattern-library.json"].patterns.canonicalDecimal.pattern;

const refSchema = {
  $id: "bundle://schemas/_smoke.schema.json",
  type: "object",
  properties: {
    hash: { $ref: "bundle://meta/common.defs.json#/definitions/sha256Hex" },
    dec: { type: "string", "x-decimal-string": true, pattern: DEC },
    arr: { type: "array", "x-canonical": "set", items: { type: "string" } },
  },
};
const v = ajv.compile(refSchema);

let fails = 0;
function check(name, data, expected) {
  const got = v(data);
  const ok = got === expected;
  if (!ok) fails += 1;
  console.log((ok ? "PASS " : "FAIL ") + name + " expected=" + expected + " got=" + got);
}

const H = "a".repeat(64);
check("good-hash-good-decimal", { hash: H, dec: "12.5", arr: ["x"] }, true);
check("bad-hash", { hash: "zz", dec: "12.5" }, false);
check("zero-decimal", { hash: H, dec: "0" }, true);
check("leading-zero-rejected", { hash: H, dec: "01" }, false);
check("exp-form-rejected", { hash: H, dec: "1e-7" }, false);
check("trailing-lf-rejected(js-anchored)", { hash: H, dec: "0" + LF }, false);
console.log("smoke:", fails === 0 ? "ALL PASS (6 cases)" : fails + " FAILURES");
process.exit(fails === 0 ? 0 : 1);
