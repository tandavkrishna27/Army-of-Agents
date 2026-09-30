#!/usr/bin/env node
/**
 * check-test-inventory.mjs
 *
 * Always-on `policy`-job guard: THE TEST SUITE MAY NOT SILENTLY SHRINK.
 *
 * On 2026-08-21 the desktop staging assembler deleted 154 test files from this
 * repository. Its prune step walked with `statSync`, which follows symlinks, and a
 * `pnpm deploy` root is full of links pointing back at the real `packages/*`
 * directories — so the prune left its own staging root and deleted the originals.
 * CI then reported success on four consecutive commits, because removing a test
 * removes a failure. No gate in this repository reacts to a suite getting smaller.
 *
 * The lstat fix in the assembler stops that assembler. This guard stops the NEXT
 * script that walks a tree with `rmSync`, by making the suite's size a committed fact
 * that a machine re-checks.
 *
 * NOTE THE WALK NEVER FOLLOWS SYMLINKS. That is not incidental tidiness — it is the
 * same defect this guard exists to detect, and a checker that reproduced it would
 * count files outside the repository and mask the very deletion it is looking for.
 *
 * Filesystem layer only: it lists directories and delegates every membership and
 * verdict decision to the pure `scripts/lib/test-inventory.mjs`.
 *
 * Usage:
 *   node scripts/check-test-inventory.mjs
 *   node scripts/check-test-inventory.mjs --root <fixture-dir>
 *   node scripts/check-test-inventory.mjs --write   # deliberate, human-only bump
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  evaluateInventory,
  isExcludedDirectory,
  isTestFile,
  treeForPath,
} from "./lib/test-inventory.mjs";

export const MANIFEST_RELATIVE_PATH = "scripts/test-inventory.json";

/**
 * Count test files per tree.
 *
 * THE LOAD-BEARING DETAIL IS `withFileTypes`, NOT THE EXPLICIT SYMLINK LINE BELOW.
 * A `Dirent` carries lstat semantics: for a symlink or a Windows junction it reports
 * isDirectory() === false AND isFile() === false, so such entries fall through both
 * branches and are never traversed. The `isSymbolicLink()` check is therefore
 * defence-in-depth — mutation testing confirmed removing it changes nothing (an
 * equivalent mutant), and it is kept only to state the intent at the point of use.
 *
 * What WOULD reintroduce the incident is replacing the Dirent tests with
 * `statSync(child).isDirectory()`, because stat resolves the link and the walk then
 * leaves the root. That mutation IS caught: `check-test-inventory.test.mjs`'s
 * "does NOT follow a symlinked directory" fails on it. Do not "simplify" this walk
 * to statSync.
 */
export function countTestFiles(root) {
  const counts = Object.create(null);
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop();
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!isExcludedDirectory(entry.name)) stack.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isTestFile(childRel)) continue;
      const tree = treeForPath(childRel);
      counts[tree] = (counts[tree] ?? 0) + 1;
    }
  }
  return counts;
}

function readManifest(root) {
  const absolute = path.join(root, MANIFEST_RELATIVE_PATH);
  try {
    return { expectations: JSON.parse(readFileSync(absolute, "utf8")).trees ?? {} };
  } catch (error) {
    return { error: `${MANIFEST_RELATIVE_PATH}: ${error.message}` };
  }
}

function writeManifest(root, expectations) {
  const trees = {};
  for (const tree of Object.keys(expectations).sort()) trees[tree] = expectations[tree];
  writeFileSync(
    path.join(root, MANIFEST_RELATIVE_PATH),
    `${JSON.stringify({ trees }, null, 2)}\n`,
    "utf8",
  );
}

function describe(violation) {
  const { kind, tree, actual, expected, detail } = violation;
  switch (kind) {
    case "pinned_mismatch":
      return actual < expected
        ? `${tree}: ${expected - actual} test file(s) LOST (${actual}, pinned at ${expected})`
        : `${tree}: ${actual - expected} test file(s) added (${actual}, pinned at ${expected}) — bump the pin`;
    case "below_floor":
      return `${tree}: ${expected - actual} test file(s) LOST (${actual}, floor ${expected})`;
    case "unmanaged_tree":
      return `${tree}: ${actual} test file(s) in a tree with NO expectation — add one`;
    default:
      return `${tree ?? "(manifest)"}: ${detail ?? kind}`;
  }
}

function main(argv) {
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag === -1 ? process.cwd() : path.resolve(argv[rootFlag + 1]);
  const counts = countTestFiles(root);

  if (argv.includes("--write")) {
    const previous = readManifest(root).expectations ?? {};
    const next = {};
    for (const tree of Object.keys(counts).sort()) {
      next[tree] = { mode: previous[tree]?.mode ?? "floor", count: counts[tree] };
    }
    for (const tree of Object.keys(previous)) {
      if (!Object.hasOwn(next, tree)) {
        console.log(`REMOVED tree ${tree} (was ${previous[tree].count})`);
      } else if (next[tree].count < (previous[tree].count ?? 0)) {
        // Surfaced loudly: writing the manifest is how a legitimate deletion is
        // recorded, and it is also how an illegitimate one would be laundered. The
        // decrease is printed so the diff a reviewer sees is not the first mention.
        console.log(`DECREASE ${tree}: ${previous[tree].count} -> ${next[tree].count}`);
      }
    }
    writeManifest(root, next);
    console.log(`wrote ${MANIFEST_RELATIVE_PATH} (${Object.keys(next).length} trees)`);
    return 0;
  }

  const manifest = readManifest(root);
  if (manifest.error) {
    console.error(`test-inventory: cannot read the manifest — ${manifest.error}`);
    return 1;
  }
  const { ok, violations } = evaluateInventory({ counts, expectations: manifest.expectations });
  if (ok) {
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    console.log(`test-inventory: OK (${total} test files across ${Object.keys(counts).length} trees)`);
    return 0;
  }
  console.error("test-inventory: the committed suite size does not match the tree.\n");
  for (const violation of violations) console.error(`  - ${describe(violation)}`);
  console.error(
    "\nIf a suite shrank unintentionally, restore the files — do NOT bump the manifest." +
      "\nIf the change is deliberate, run `node scripts/check-test-inventory.mjs --write`" +
      "\nand commit the manifest alongside the code, where review can see it.",
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-test-inventory.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
