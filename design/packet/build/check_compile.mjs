// check_compile.mjs — compile every schema under the frozen ajv config (v0.12).
//
// Manifest-driven: all documents come from build/bundle_loader.mjs. Registration covers
// the $ref-eligible documents (23 schemas + meta/common.defs.json). Read-only: prints a
// self-cert header; never writes into the packet. `ajv` resolves via AJV_WORKSPACE.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packetRoot, loadBundle } from "./bundle_loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const WS = process.env.AJV_WORKSPACE || process.cwd();
const require = createRequire(join(WS, "__resolve__.cjs"));
let Ajv;
try {
  const m = require("ajv");
  Ajv = m.default || m;
} catch (e) {
  console.error("ERROR: cannot resolve 'ajv' from AJV_WORKSPACE=" + WS);
  console.error("Set AJV_WORKSPACE to a directory where the locked dependencies were installed (see locks/README.md).");
  process.exit(2);
}

const root = packetRoot();
const mpath = join(root, "bundle.manifest.json");
const manifestSha = existsSync(mpath) ? createHash("sha256").update(readFileSync(mpath)).digest("hex").slice(0, 16) : "MISSING";
const ipath = join(root, "SHA256SUMS-packet.txt");
const hpath = join(root, "HASHES");
const indexSha = existsSync(ipath)
  ? "sums:" + createHash("sha256").update(readFileSync(ipath)).digest("hex").slice(0, 12)
  : (existsSync(hpath) ? "hashes:" + createHash("sha256").update(readFileSync(hpath)).digest("hex").slice(0, 12) : "(none)");
console.log("[check_compile.mjs] packet_root=" + root + " manifest_sha=" + manifestSha + " index_sha=" + indexSha + " read-only: no packet writes");

const { docs, problems } = loadBundle(root);
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
const schemFiles = Object.keys(docs).filter((k) => k.startsWith("schemas/")).sort();
for (const k of schemFiles) {
  ajv.addSchema(docs[k], "bundle://" + k);
}

let fail = 0;
for (const k of schemFiles) {
  try {
    ajv.compile(docs[k]);
    console.log("COMPILE_OK " + k.slice("schemas/".length));
  } catch (e) {
    fail += 1;
    console.log("COMPILE_FAIL " + k.slice("schemas/".length) + " :: " + String(e.message).slice(0, 320));
  }
}
console.log(fail === 0 ? "AJV_COMPILE: ALL OK (" + schemFiles.length + " files)" : "AJV_COMPILE: " + fail + " FAILURES");
process.exit(fail === 0 ? 0 : 1);
