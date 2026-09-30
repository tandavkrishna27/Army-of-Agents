#!/usr/bin/env node
// WRK-008 slice 2b Step 9b — the boot-roots-provider-free guard.
//
//   node scripts/check-boot-roots-provider-free.mjs
//
// Enumerates the repository's worker boot roots (non-test source files under the worker bin
// directories that obtain bootstrapWorkerDaemon) and asserts the declared property: no boot root
// constructs a provider unconditionally, and the shipped default resolves to none. Fails on an
// undeclared root, a stale declaration, a resolver that does not default to none, or an
// unreadable source (fail closed).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { evaluateBootRoots } from "./lib/boot-roots-provider-free.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectationPath = path.join(repoRoot, "scripts", "boot-roots-expectation.json");

// The bin directories a worker boot root can live in. A new root outside these would also need a
// new scan directory here — itself a reviewable, attributable change.
const BIN_DIRS = [
  "packages/worker-daemon/src/bin",
  "packages/worker-keystore/src/bin",
  // DEP-011 Slice 2b — the CONTAINER networked-provider composition root.
  "packages/worker-networked-host/src/bin",
];
const BOOTSTRAP_IDENTIFIER = "bootstrapWorkerDaemon";

/** All non-test .ts files under the bin dirs whose source names the bootstrap identifier. */
function findBootRoots() {
  const roots = [];
  for (const dir of BIN_DIRS) {
    let entries;
    try {
      entries = readdirSync(path.join(repoRoot, dir));
    } catch {
      continue; // a bin dir that does not exist contributes no roots
    }
    for (const name of entries) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
      const rel = `${dir}/${name}`;
      const content = readFileSync(path.join(repoRoot, rel), "utf8");
      if (content.includes(BOOTSTRAP_IDENTIFIER)) roots.push(rel);
    }
  }
  return roots.sort();
}

function main() {
  const expectation = JSON.parse(readFileSync(expectationPath, "utf8"));
  const foundRoots = findBootRoots();

  const resolverContents = {};
  for (const spec of Object.values(expectation.roots)) {
    if (spec.providerPosture === "resolver" && spec.resolverFile) {
      try {
        resolverContents[spec.resolverFile] = readFileSync(path.join(repoRoot, spec.resolverFile), "utf8");
      } catch {
        resolverContents[spec.resolverFile] = undefined; // fail closed in the evaluator
      }
    }
  }

  const violations = evaluateBootRoots({ foundRoots, expectation, resolverContents });
  if (violations.length > 0) {
    console.error("check-boot-roots-provider-free FAILED:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
    return;
  }
  console.log(`check-boot-roots-provider-free OK — ${foundRoots.length} boot root(s), none constructs a provider unconditionally.`);
}

main();
