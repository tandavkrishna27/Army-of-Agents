// Post-`pnpm deploy` fixup for the split control-plane image (DEP-001).
//
// The @armyofagents/* workspace packages export their TypeScript SOURCE in dev
// (exports -> ./src/*.ts) but ship only ./dist (files: ["dist"]) and carry a
// `publishConfig` that remaps exports/main/types to the built ./dist. The image
// runs plain `node` on a `--prod` deploy (no src, no tsx), so it depends on those
// dist exports. pnpm 9's `deploy` does NOT apply publishConfig (no such flag), so
// the deployed manifests keep their ./src exports and Node fails to resolve them
// (ERR_MODULE_NOT_FOUND: .../@armyofagents/db/src/migrate-job.ts).
//
// This script walks a deployment's node_modules, and for every @armyofagents/*
// package that has a publishConfig, promotes publishConfig's fields onto the
// manifest (exactly what `pnpm publish` would do) so plain-node resolution lands
// on the shipped ./dist. Idempotent. Usage:
//   node docker/apply-workspace-publish-config.mjs <deploy-node_modules-dir>

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: apply-workspace-publish-config.mjs <node_modules-dir>");
  process.exit(2);
}

const PROMOTED_FIELDS = ["exports", "main", "module", "types", "typings", "bin", "typesVersions"];
let applied = 0;

function walk(dir, depth) {
  if (depth > 10) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === "package.json") {
      applyToManifest(full);
    } else if (entry.isDirectory() && entry.name !== ".bin") {
      walk(full, depth + 1);
    }
  }
}

function applyToManifest(manifestPath) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return;
  }
  if (typeof pkg?.name !== "string" || !pkg.name.startsWith("@armyofagents/")) return;
  const pc = pkg.publishConfig;
  if (!pc || typeof pc !== "object") return;
  for (const field of PROMOTED_FIELDS) {
    if (pc[field] !== undefined) pkg[field] = pc[field];
  }
  delete pkg.publishConfig;
  writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
  applied += 1;
  console.log(`applied publishConfig: ${pkg.name} (${manifestPath})`);
}

walk(root, 0);
console.log(`apply-workspace-publish-config: promoted publishConfig on ${applied} @armyofagents package manifest(s)`);
