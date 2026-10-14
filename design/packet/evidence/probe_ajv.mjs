// probe_ajv.mjs — validator behavior probes (v3, aligned with spec v0.12 K1 contract).
//
// Active contract: exactly TWO registered extension keywords (x-canonical,
// x-decimal-string). The pattern library is an independent NON-schema data
// resource and must NEVER be compiled by any validator.
// T1/T2/T3/T4/T5/T6/T7/T10/T11 mechanics are unchanged from earlier runs
// (historical outputs retained in staging only); T8/T9 are rewritten for the
// current contract (no third-keyword registration exists anywhere).
import { createRequire } from "node:module";
import { join } from "node:path";

const WS = process.env.AJV_WORKSPACE || process.cwd();
const require = createRequire(join(WS, "__resolve__.cjs"));
let Ajv;
try {
  const m = require("ajv");
  Ajv = m.default || m;
} catch (e) {
  console.error("ERROR: cannot resolve ajv from AJV_WORKSPACE=" + WS);
  process.exit(2);
}

const CARET = String.fromCharCode(94); // ^
const DOLLAR = String.fromCharCode(36); // $

function banner(name, fn) {
  try {
    const out = fn();
    console.log(name + ": OK | " + (out === undefined ? "" : out));
  } catch (e) {
    console.log(name + ": ERR | " + String(e.message).slice(0, 240));
  }
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

banner("T1 unknown keyword under strict (any third keyword is refused)", () => {
  const ajv = new Ajv(OPTS);
  try {
    ajv.compile({ type: "object", patterns: { x: {} } });
    return "compiled?!";
  } catch (e) {
    return "refused as required: " + String(e.message).slice(0, 80);
  }
});

banner("T3 register the two frozen annotation keywords + use them", () => {
  const ajv = new Ajv(OPTS);
  ajv.addKeyword({ keyword: "x-canonical", schemaType: "string" });
  ajv.addKeyword({ keyword: "x-decimal-string", schemaType: "boolean" });
  const v = ajv.compile({
    type: "object",
    properties: {
      a: { type: "array", "x-canonical": "set", items: { type: "string" } },
      b: { type: "string", "x-decimal-string": true },
    },
  });
  const ok = v({ a: ["x"], b: "12" });
  return "compiles, validates ok=" + ok;
});

banner("T4 bundle:// ref via addSchema + definitions", () => {
  const ajv = new Ajv(OPTS);
  ajv.addSchema(
    {
      $id: "bundle://meta/common.defs.json",
      definitions: { sha256hex: { type: "string", pattern: CARET + "[0-9a-f]{64}" + DOLLAR } },
    },
    "bundle://meta/common.defs.json",
  );
  const v = ajv.compile({
    $id: "bundle://schemas/t.schema.json",
    type: "object",
    properties: { h: { $ref: "bundle://meta/common.defs.json#/definitions/sha256hex" } },
  });
  const a = v({ h: "a".repeat(64) });
  const b = v({ h: "zz" });
  return "64hex=" + a + " bad=" + b;
});

banner("T5 bundle:// ref to an UNREGISTERED file (compile must fail)", () => {
  const ajv = new Ajv(OPTS);
  try {
    ajv.compile({
      $id: "bundle://schemas/t2.schema.json",
      type: "object",
      properties: { h: { $ref: "bundle://meta/missing.json#/definitions/x" } },
    });
    return "compiled without target?!";
  } catch (e) {
    return "refused: " + String(e.message).slice(0, 90);
  }
});

banner("T6 remote http ref (compile must fail; no loader)", () => {
  const ajv = new Ajv(OPTS);
  try {
    ajv.compile({
      $id: "bundle://schemas/t3.schema.json",
      type: "object",
      properties: { h: { $ref: "http://example.com/x.json#/definitions/y" } },
    });
    return "compiled without target?!";
  } catch (e) {
    return "refused: " + String(e.message).slice(0, 90);
  }
});

banner("T7 pattern semantics: anchored literal has no trailing-LF hole", () => {
  const ajv = new Ajv(OPTS);
  const v = ajv.compile({ type: "string", pattern: CARET + "[0-9]+" + DOLLAR });
  const LF = String.fromCharCode(10);
  return "plain=" + v("0") + " trailingLF=" + v("0" + LF) + " surrounded=" + v(" x0 ");
});

banner("T8 (current contract) data document with patterns key must NEVER compile", () => {
  const ajv = new Ajv(OPTS);
  try {
    ajv.compile({ $id: "bundle://meta/pattern-library.json", patterns: { p1: { pattern: "[0-9]+" } } });
    return "compiled?! (would require a third keyword)";
  } catch (e) {
    return "compile refused as required: " + String(e.message).slice(0, 80);
  }
});

banner("T9 (current contract) two-keyword instance compiles the schema set; no third registration exists", () => {
  const ajv = new Ajv(OPTS);
  ajv.addKeyword({ keyword: "x-canonical", schemaType: "string" });
  ajv.addKeyword({ keyword: "x-decimal-string", schemaType: "boolean" });
  ajv.addSchema(
    { $id: "bundle://meta/common.defs.json", definitions: { d: { type: "string" } } },
    "bundle://meta/common.defs.json",
  );
  const v = ajv.compile({
    $id: "bundle://schemas/t5.schema.json",
    type: "object",
    properties: { s: { $ref: "bundle://meta/common.defs.json#/definitions/d" } },
  });
  return "two-keyword compiles; sample=" + v({ s: "x" });
});

banner("T10 anchored literal execution (sanity)", () => {
  const ajv = new Ajv(OPTS);
  const v = ajv.compile({ type: "string", pattern: CARET + "(?:[0-9]{2})" + DOLLAR });
  return "22=" + v("22") + " 2=" + v("2");
});

banner("T11 unicodeRegExp note: anchored ASCII literal unaffected", () => {
  const ajv = new Ajv(OPTS);
  const v = ajv.compile({ type: "string", pattern: CARET + "(?:[0-9]+)" + DOLLAR });
  return "plain=" + v("0") + " empty=" + v("");
});
