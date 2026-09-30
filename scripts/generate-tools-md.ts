#!/usr/bin/env tsx
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildToolManifest,
  renderCommanderToolsMd,
} from "../server/src/services/internal-agent/tool-manifest.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(repoRoot, "server/src/onboarding-assets/commander/TOOLS.md");

const next = renderCommanderToolsMd(buildToolManifest());
const check = process.argv.includes("--check");

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== next) {
    console.error("ERROR: commander/TOOLS.md is stale. Run `pnpm gen:tools:md` and commit.");
    process.exit(1);
  }
  console.log("commander/TOOLS.md is fresh.");
} else {
  writeFileSync(OUT, next, "utf8");
  console.log(`Wrote ${OUT}`);
}
