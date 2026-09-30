#!/usr/bin/env node
/**
 * check-worker-keystore-boundary.mjs
 *
 * Always-on `policy`-job guard for the DSK-001 leaf package
 * `@armyofagents/worker-keystore` (design D2 / I23).
 *
 * The package exists so a private device key can cross a process boundary on
 * stdin. Every decision about HOW that happens — the planner, the outcome
 * classifier, the envelope codec, the store — is pure and OS-free so it is
 * provable on the ubuntu-only REQUIRED CI lane. That decomposition only means
 * something if the dangerous capability really does stay in one place, so this
 * checker enforces it mechanically rather than trusting review:
 *
 *   - the manifest declares EXACTLY {worker-daemon, worker-protocol} — a native
 *     keychain binding must never arrive by accident in a package that is
 *     injected INTO the daemon's process;
 *   - `node:child_process` may be imported from EXACTLY ONE runtime source file,
 *     `command-runner.ts`;
 *   - non-literal imports and the `node:module` createRequire bridge are
 *     rejected, because either would let arbitrary code reach the process holding
 *     the key.
 *
 * Filesystem/command layer only: it reads bytes and directory listings and
 * delegates every parsing/validation decision to the pure
 * `scripts/lib/worker-keystore-boundary.mjs`. Read/parse errors are reported
 * SEPARATELY from import-policy violations.
 *
 * Usage:
 *   node scripts/check-worker-keystore-boundary.mjs
 *   node scripts/check-worker-keystore-boundary.mjs --root <fixture-dir>
 */

import { readFile as fsReadFile, readdir as fsReaddir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  classifyRuntimeSourceFileName,
  evaluateManifest,
  evaluateRuntimeSourceImports,
} from "./lib/worker-keystore-boundary.mjs";

export const WORKER_KEYSTORE_BOUNDARY_PACKAGES = [
  { rel: "packages/worker-keystore", name: "@armyofagents/worker-keystore" },
];

function toRel(root, absolute) {
  return path.relative(root, absolute).replaceAll("\\", "/");
}

function describeError(err) {
  if (err && typeof err === "object" && "code" in err && err.code) return String(err.code);
  return err && err.message ? err.message : String(err);
}

async function checkPackage(root, pkg, readFile, readdir) {
  const policyErrors = [];
  const readErrors = [];
  const manifestRel = `${pkg.rel}/package.json`;
  const srcRel = `${pkg.rel}/src`;
  const packageRoot = path.join(root, ...pkg.rel.split("/"));
  const sourceRoot = path.join(packageRoot, "src");

  let manifestText;
  try {
    manifestText = await readFile(path.join(packageRoot, "package.json"), "utf8");
  } catch (err) {
    readErrors.push(`${manifestRel}: missing or unreadable (${describeError(err)})`);
  }
  if (manifestText !== undefined) {
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (err) {
      readErrors.push(`${manifestRel}: invalid JSON (${describeError(err)})`);
    }
    if (manifest !== undefined) {
      policyErrors.push(...evaluateManifest(manifest, { manifestRel, expectedName: pkg.name }));
    }
  }

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (err) {
      if (directory === sourceRoot) {
        readErrors.push(`${srcRel}: missing (${describeError(err)})`);
      } else {
        readErrors.push(`${toRel(root, directory)}: unreadable directory (${describeError(err)})`);
      }
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const rel = toRel(root, absolute);
      if (entry.isSymbolicLink()) {
        policyErrors.push(`${rel}: runtime-source symlinks are forbidden`);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const kind = classifyRuntimeSourceFileName(entry.name);
      if (kind === "alternate-extension") {
        policyErrors.push(`${rel}: alternate runtime-source extensions are forbidden; use .ts`);
        continue;
      }
      if (kind !== "runtime") continue; // test source + non-source files skipped
      let source;
      try {
        source = await readFile(absolute, "utf8");
      } catch (err) {
        readErrors.push(`${rel}: unreadable source (${describeError(err)})`);
        continue;
      }
      policyErrors.push(...evaluateRuntimeSourceImports({ relPath: rel, absPath: absolute, sourceRoot, source }));
    }
  }

  await walk(sourceRoot);
  return { policyErrors, readErrors };
}

export async function runBoundaryCheck(root, opts = {}) {
  const readFile = opts.readFile ?? fsReadFile;
  const readdir = opts.readdir ?? fsReaddir;
  const packages = opts.packages ?? WORKER_KEYSTORE_BOUNDARY_PACKAGES;
  const policyErrors = [];
  const readErrors = [];
  for (const pkg of packages) {
    const result = await checkPackage(root, pkg, readFile, readdir);
    policyErrors.push(...result.policyErrors);
    readErrors.push(...result.readErrors);
  }
  return { policyErrors, readErrors };
}

export function resolveRoot(argv) {
  const i = argv.indexOf("--root");
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return process.cwd();
}

async function main() {
  const root = resolveRoot(process.argv.slice(2));
  const { policyErrors, readErrors } = await runBoundaryCheck(root);
  if (readErrors.length > 0) {
    console.error("filesystem read/parse errors:");
    for (const line of readErrors) console.error(`  ${line}`);
  }
  if (policyErrors.length > 0) {
    console.error("import-policy violations:");
    for (const line of policyErrors) console.error(`  ${line}`);
  }
  if (readErrors.length > 0 || policyErrors.length > 0) {
    process.exit(1);
  }
  console.log("worker keystore boundary: PASS");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
