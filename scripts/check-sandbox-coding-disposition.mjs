#!/usr/bin/env node
/**
 * check-sandbox-coding-disposition.mjs
 *
 * Always-on `policy`-job guard for CLI-002's per-adapter-TYPE disposition matrix.
 * It asserts that EVERY registered adapter type
 * (`server/src/adapters/builtin-adapter-types.ts`) has an explicit disposition in
 * `server/src/services/sandbox-coding-disposition.ts`, that no disposition is stale,
 * that every bucket is valid, and that every non-v1 bucket carries an attributable
 * reason. This is the static "no adapter left undispositioned" boundary — the
 * program-design.md:765 mandate — enforced without booting the server.
 *
 * The filesystem layer only; all parsing/validation lives in the pure
 * `scripts/lib/sandbox-coding-disposition.mjs`.
 *
 * Usage:
 *   node scripts/check-sandbox-coding-disposition.mjs
 *   node scripts/check-sandbox-coding-disposition.mjs --root <fixture-dir>
 */

import { readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  extractRegisteredTypes,
  extractDispositions,
  evaluateDispositionCoverage,
} from "./lib/sandbox-coding-disposition.mjs";

export const REGISTRY_REL = "server/src/adapters/builtin-adapter-types.ts";
export const MATRIX_REL = "server/src/services/sandbox-coding-disposition.ts";

export async function runDispositionCheck(root, opts = {}) {
  const readFile = opts.readFile ?? fsReadFile;
  const errors = [];
  const readErrors = [];

  let registrySource;
  let matrixSource;
  try {
    registrySource = await readFile(path.join(root, ...REGISTRY_REL.split("/")), "utf8");
  } catch (err) {
    readErrors.push(`${REGISTRY_REL}: unreadable (${err?.code ?? err?.message ?? err})`);
  }
  try {
    matrixSource = await readFile(path.join(root, ...MATRIX_REL.split("/")), "utf8");
  } catch (err) {
    readErrors.push(`${MATRIX_REL}: unreadable (${err?.code ?? err?.message ?? err})`);
  }

  if (registrySource !== undefined && matrixSource !== undefined) {
    const registeredTypes = extractRegisteredTypes(registrySource);
    const dispositions = extractDispositions(matrixSource);
    errors.push(...evaluateDispositionCoverage({ registeredTypes, dispositions }));
  }
  return { errors, readErrors };
}

export function resolveRoot(argv) {
  const i = argv.indexOf("--root");
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return process.cwd();
}

async function main() {
  const root = resolveRoot(process.argv.slice(2));
  const { errors, readErrors } = await runDispositionCheck(root);
  if (readErrors.length > 0) {
    console.error("filesystem read errors:");
    for (const line of readErrors) console.error(`  ${line}`);
  }
  if (errors.length > 0) {
    console.error("disposition-coverage violations:");
    for (const line of errors) console.error(`  ${line}`);
  }
  if (readErrors.length > 0 || errors.length > 0) process.exit(1);
  console.log("sandbox coding disposition: PASS");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
