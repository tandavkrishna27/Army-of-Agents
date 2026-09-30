#!/usr/bin/env node
/**
 * check-adapter-manager-boundary.mjs
 *
 * Always-on `policy`-job guard for the DEP-012 Slice 3 · β2 provider host
 * `@armyofagents/adapter-manager`.
 *
 * The package is the out-of-process host of the per-op SandboxProvider. Its request-path
 * files decide, per request, whether a caller may act on a sandbox — and they must do so
 * WITHOUT the `e2b` network SDK (or the provider-control credential) in the process image.
 * The SDK may enter from EXACTLY ONE composition-root file, `src/bin/adapter-manager.ts`,
 * which dynamically imports the provider and hands it to `createProviderServer`. This
 * checker enforces that mechanically rather than trusting review:
 *
 *   - the manifest declares EXACTLY {provider-wire, sandbox-e2b-provider, worker-daemon} —
 *     `e2b` stays transitive and is never declared;
 *   - `@armyofagents/sandbox-e2b-provider` (bare or any subpath) may be imported from
 *     EXACTLY ONE runtime source file, `src/bin/adapter-manager.ts`;
 *   - the provider-control credential `E2B_API_KEY` may appear in ZERO runtime source files;
 *   - a direct `e2b` import is forbidden everywhere; non-literal imports and the
 *     `node:module` createRequire bridge are rejected.
 *
 * Filesystem/command layer only: it reads bytes and directory listings and delegates every
 * parsing/validation decision to the pure `scripts/lib/adapter-manager-boundary.mjs`.
 * Read/parse errors are reported SEPARATELY from import-policy violations.
 *
 * Usage:
 *   node scripts/check-adapter-manager-boundary.mjs
 *   node scripts/check-adapter-manager-boundary.mjs --root <fixture-dir>
 */

import { readFile as fsReadFile, readdir as fsReaddir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  classifyRuntimeSourceFileName,
  evaluateManifest,
  evaluateRuntimeSourceImports,
} from "./lib/adapter-manager-boundary.mjs";

export const ADAPTER_MANAGER_BOUNDARY_PACKAGES = [
  { rel: "packages/adapter-manager", name: "@armyofagents/adapter-manager" },
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
        // `__tests__` is intentionally skipped: tests legitimately import provider subpaths
        // (component test) and are out of the production closure.
        if (entry.name === "__tests__") continue;
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
  const packages = opts.packages ?? ADAPTER_MANAGER_BOUNDARY_PACKAGES;
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
  console.log("adapter manager boundary: PASS");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
