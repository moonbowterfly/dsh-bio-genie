// test/runtime-jsonschema-heal.mjs — A8 contract test (design casefile 前置).
// Asserts the first-layer dependency contract statically (requirements pin + runtime
// REQUIRED_PACKAGES + inspect probe), plus an optional live probe against the plugin
// venv when it exists on this machine (self-heal effectiveness evidence).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
function check(name, ok, detail = "") {
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : ""));
  if (!ok) fails += 1;
}

const runtimeSrc = readFileSync(join(ROOT, "src", "runtime.js"), "utf8");
check("REQUIRED_PACKAGES includes jsonschema", /const REQUIRED_PACKAGES = \[[^\]]*'jsonschema'[^\]]*\]/.test(runtimeSrc));
check("inspect probe reports jsonschema", runtimeSrc.includes('"jsonschema": _ver("jsonschema")'));

const req = readFileSync(join(ROOT, "python", "requirements.txt"), "utf8");
check("requirements pins jsonschema==4.26.0 (v0.6 E2 frozen pin)", req.includes("jsonschema==4.26.0"));

const home = process.env.USERPROFILE || process.env.HOME || "";
const venvPy = process.env.DSH_BIO_GENIE_PY || join(home, ".dsh", "dsh-bio-genie", "python-env", "Scripts", "python.exe");
if (existsSync(venvPy)) {
  const NL = String.fromCharCode(10);
  const probe = [
    "import json",
    "def _ver(n):",
    "    try:",
    "        import importlib.metadata as md",
    "        return md.version(n)",
    "    except Exception:",
    "        return None",
    "print(json.dumps({\"jsonschema\": _ver(\"jsonschema\")}))",
  ].join(NL);
  let v = null;
  try {
    const out = execFileSync(venvPy, ["-I", "-c", probe], { encoding: "utf8", timeout: 120000 });
    v = JSON.parse(out.trim().split(NL).pop()).jsonschema;
  } catch (e) {
    v = "(probe error: " + String(e.message).slice(0, 80) + ")";
  }
  check("live venv probe: jsonschema importable (self-heal effective)", v === "4.26.0", "version=" + v);
} else {
  console.log("SKIP(live): plugin venv not found at " + venvPy + " (static contract still asserted)");
}

console.log(fails === 0 ? "runtime-jsonschema-heal: ALL PASS" : "runtime-jsonschema-heal: " + fails + " FAILURES");
process.exit(fails === 0 ? 0 : 1);
