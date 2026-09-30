#!/usr/bin/env node
/**
 * check-worker-protocol-boundary.mjs
 *
 * Always-on `policy`-job guard for the `@armyofagents/worker-protocol` leaf
 * package. It enforces that the package stays dependency-light and that its
 * runtime source imports ONLY `zod` or relative modules that stay inside the
 * package `src` directory — no Node builtins, no `node:*`, no other AoA
 * package, no other bare package, no `.test` source, no relative escape, and
 * no Node/runtime globals. Alternate runtime-source extensions and symlinks
 * under `src` are rejected too.
 *
 * This file is the filesystem/command layer only: it reads bytes and directory
 * listings and delegates every parsing/validation decision to the pure,
 * dependency-free `scripts/lib/worker-protocol-boundary.mjs`.
 *
 * Filesystem read/parse errors (missing manifest, unreadable source, missing
 * `src` directory) are reported SEPARATELY from import-policy violations, so a
 * missing/unreadable file is never mislabeled as a policy result.
 *
 * Usage:
 *   node scripts/check-worker-protocol-boundary.mjs
 *   node scripts/check-worker-protocol-boundary.mjs --root <fixture-dir>
 *
 * `--root` exists only for the dependency-free `node:test` harness in
 * `check-worker-protocol-boundary.test.mjs`; it defaults to `process.cwd()` in
 * normal and CI use.
 */

import { readFile as fsReadFile, readdir as fsReaddir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  classifyRuntimeSourceFileName,
  evaluateManifest,
  evaluateRuntimeSourceImports,
} from "./lib/worker-protocol-boundary.mjs";

const PACKAGE_REL = "packages/worker-protocol";
const MANIFEST_REL = `${PACKAGE_REL}/package.json`;
const SRC_REL = `${PACKAGE_REL}/src`;

function toRel(root, absolute) {
  return path.relative(root, absolute).replaceAll("\\", "/");
}

function describeError(err) {
  if (err && typeof err === "object" && "code" in err && err.code) return String(err.code);
  return err && err.message ? err.message : String(err);
}

/**
 * Run the boundary check against a repository root.
 *
 * @param {string} root repository root (defaults to cwd)
 * @param {{readFile?:Function, readdir?:Function}} [deps] injectable fs (tests)
 * @returns {Promise<{policyErrors:string[], readErrors:string[]}>}
 */
export async function runBoundaryCheck(root, deps = {}) {
  const readFile = deps.readFile ?? fsReadFile;
  const readdir = deps.readdir ?? fsReaddir;
  const policyErrors = [];
  const readErrors = [];

  const packageRoot = path.join(root, "packages", "worker-protocol");
  const sourceRoot = path.join(packageRoot, "src");

  // Manifest: read + parse (fs/parse issues => readErrors; content => policy).
  let manifestText;
  try {
    manifestText = await readFile(path.join(packageRoot, "package.json"), "utf8");
  } catch (err) {
    readErrors.push(`${MANIFEST_REL}: missing or unreadable (${describeError(err)})`);
  }
  if (manifestText !== undefined) {
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (err) {
      readErrors.push(`${MANIFEST_REL}: invalid JSON (${describeError(err)})`);
    }
    if (manifest !== undefined) {
      policyErrors.push(...evaluateManifest(manifest));
    }
  }

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (err) {
      if (directory === sourceRoot) {
        readErrors.push(`${SRC_REL}: missing (${describeError(err)})`);
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
      if (kind !== "runtime") continue; // test source + non-source files are skipped
      let source;
      try {
        source = await readFile(absolute, "utf8");
      } catch (err) {
        readErrors.push(`${rel}: unreadable source (${describeError(err)})`);
        continue;
      }
      policyErrors.push(
        ...evaluateRuntimeSourceImports({ relPath: rel, absPath: absolute, sourceRoot, source }),
      );
    }
  }

  await walk(sourceRoot);

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
  console.log("worker protocol boundary: PASS");
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
