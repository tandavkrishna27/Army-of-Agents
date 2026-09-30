#!/usr/bin/env tsx
import { copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PERSONA = ["AGENTS.md", "SOUL.md", "HEARTBEAT.md", "TOOLS.md"] as const;

export function syncCommanderToSkills(opts: {
  productRoot: string;
  skillsRoot: string;
}): string[] {
  const { productRoot, skillsRoot } = opts;
  const srcCommander = resolve(productRoot, "server/src/onboarding-assets/commander");
  const dstCommander = resolve(skillsRoot, "commander");
  const srcTools = resolve(productRoot, "packages/shared/src/generated/tools.json");
  const dstTools = resolve(skillsRoot, "generated/tools.json");

  if (!existsSync(dstCommander)) {
    throw new Error(`skills repo missing commander/ dir: ${dstCommander}`);
  }
  if (!existsSync(resolve(skillsRoot, "generated"))) {
    throw new Error(`skills repo missing generated/ dir: ${resolve(skillsRoot, "generated")}`);
  }
  if (!existsSync(srcTools)) {
    throw new Error(`tools.json not found — run \`pnpm gen:tools\` first: ${srcTools}`);
  }

  const written: string[] = [];
  for (const f of PERSONA) {
    const src = resolve(srcCommander, f);
    if (!existsSync(src)) throw new Error(`missing product persona file: ${src}`);
    const dst = resolve(dstCommander, f);
    copyFileSync(src, dst);
    written.push(dst);
  }
  copyFileSync(srcTools, dstTools);
  written.push(dstTools);
  return written;
}

// CLI: `pnpm sync:skills -- <path-to-skills-repo>`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("sync-commander-to-skills.ts")) {
  const skillsRoot = process.argv[2];
  if (!skillsRoot) {
    console.error("Usage: pnpm sync:skills -- <path-to-AoA-Skills-repo>");
    process.exit(1);
  }
  const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const written = syncCommanderToSkills({ productRoot, skillsRoot });
  console.log(`Vendored ${written.length} files into ${skillsRoot}:`);
  for (const w of written) console.log(`  ${w}`);
}
