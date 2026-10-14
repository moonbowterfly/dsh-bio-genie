// bundle_loader.mjs — manifest-driven bundle loader (spec v0.12 K2; node twin).
// Verifies the exact file set against bundle.manifest.json and returns documents
// keyed by manifest path. No directory scanning for registration, no dynamic
// retrieval, no network. Any problem is fail-closed for callers.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function packetRoot(opt) {
  return resolve(opt || process.env.PACKET_ROOT || join(HERE, ".."));
}

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

export function loadBundle(rootOpt) {
  const root = packetRoot(rootOpt);
  const problems = [];
  const docs = {};
  const manifestPath = join(root, "bundle.manifest.json");
  if (!existsSync(manifestPath)) {
    return { root, docs, problems: ["MANIFEST_MISSING_FILE bundle.manifest.json under " + root] };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    return { root, docs, problems: ["MANIFEST_UNPARSEABLE " + String(e.message).slice(0, 160)] };
  }
  const files = manifest.files;
  if (!Array.isArray(files)) {
    return { root, docs, problems: ["MANIFEST_SHAPE_INVALID files is not a list"] };
  }
  const listed = [];
  for (const e of files) {
    if (!e || typeof e.path !== "string" || typeof e.sha256 !== "string") {
      problems.push("MANIFEST_SHAPE_INVALID " + JSON.stringify(e).slice(0, 120));
      continue;
    }
    listed.push(e.path);
  }
  if (new Set(listed).size !== listed.length) {
    problems.push("MANIFEST_DUPLICATE_PATH " + listed.join(","));
  }

  const onDisk = [];
  for (const sub of ["schemas", "meta"]) {
    const d = join(root, sub);
    if (existsSync(d)) {
      for (const f of readdirSync(d).sort()) {
        if (f.endsWith(".json")) onDisk.push(sub + "/" + f);
      }
    }
  }
  for (const rel of onDisk) {
    if (!listed.includes(rel)) problems.push("MANIFEST_EXTRA_FILE " + rel + " on disk but not listed");
  }
  for (const rel of listed) {
    if (!onDisk.includes(rel)) problems.push("MANIFEST_MISSING_FILE " + rel + " listed but absent on disk");
  }

  for (const e of files) {
    if (!e || typeof e.path !== "string" || typeof e.sha256 !== "string") continue;
    const p = join(root, e.path);
    if (!existsSync(p)) continue;
    const h = sha256File(p);
    if (h !== e.sha256) {
      problems.push("REGISTRY_UNRESOLVED hash mismatch " + e.path + " disk=" + h.slice(0, 16) + " listed=" + e.sha256.slice(0, 16));
    }
    let doc;
    try {
      doc = JSON.parse(readFileSync(p, "utf8"));
    } catch (err) {
      problems.push("MANIFEST_UNPARSEABLE " + e.path + " " + String(err.message).slice(0, 120));
      continue;
    }
    if (doc.$id !== "bundle://" + e.path) {
      problems.push("MANIFEST_ID_MISMATCH " + e.path + " $id=" + String(doc.$id));
    }
    docs[e.path] = doc;
  }
  return { root, docs, problems };
}
