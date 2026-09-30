#!/usr/bin/env tsx
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildToolManifest,
  serializeToolManifest,
} from "../server/src/services/internal-agent/tool-manifest.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(repoRoot, "packages/shared/src/generated/tools.json");

const next = serializeToolManifest(buildToolManifest());
const check = process.argv.includes("--check");

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== next) {
    console.error(
      "ERROR: packages/shared/src/generated/tools.json is stale. Run `pnpm gen:tools` and commit.",
    );
    process.exit(1);
  }
  console.log("tools.json is fresh.");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, next, "utf8");
  console.log(`Wrote ${OUT}`);
}
