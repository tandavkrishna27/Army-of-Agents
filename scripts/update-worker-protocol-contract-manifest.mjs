#!/usr/bin/env node
/**
 * update-worker-protocol-contract-manifest.mjs
 *
 * Deterministic manifest generator for the worker-protocol v1 contract bytes
 * (`docs/contracts/worker-protocol/v1/`). The manifest is one
 * `<sha256-hex>  <posix-file>\n` line per hashed contract input, sorted by POSIX
 * path, UTF-8, LF-only, with a final LF. It is byte-identical on Windows and
 * Linux because it validates and rejects any CRLF/CR/BOM/invalid-UTF-8/
 * missing-final-LF/non-POSIX input BEFORE hashing, and never hashes the manifest
 * into itself.
 *
 * Modes:
 *   node scripts/update-worker-protocol-contract-manifest.mjs           # write
 *   node scripts/update-worker-protocol-contract-manifest.mjs --check   # verify only
 *
 * The pure helpers `validateContractTextBytes()` and `buildManifestBytes()` are
 * exported for the dependency-free `node:test` mutation corpus.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** The contract directory, relative to the repo root, as POSIX segments. */
export const CONTRACT_DIR_SEGMENTS = ["docs", "contracts", "worker-protocol", "v1"];
/**
 * The exact set of hashed contract inputs, sorted by POSIX path (README.md is
 * prose, not hashed). The conformance corpus AND the PRT-007 operation matrix are
 * both pinned so a change to either the vectors or the documented operation set
 * shifts the manifest and fails the drift check. The independent frozen-consumer
 * baseline + its recorded source revision are pinned SEPARATELY by the frozen
 * fixture's own `manifest.sha256` + `dependency-lock.json`, which `cross-version.test.ts`
 * recomputes and binds to this contract.
 */
export const CONTRACT_FILES = ["conformance.json", "operations.md"];
/** The manifest file name (never hashed into itself). */
export const MANIFEST_FILE = "manifest.sha256";

/**
 * Validate one contract input's raw bytes and return its decoded text. Throws on
 * a non-POSIX path, the manifest file, invalid UTF-8, a UTF-8 BOM, any CR/CRLF,
 * or a missing final LF.
 *
 * @param {string} file POSIX file name (no directory separators)
 * @param {Uint8Array} bytes raw file bytes
 * @returns {string} the decoded UTF-8 text
 */
export function validateContractTextBytes(file, bytes) {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(`invalid contract file name: ${JSON.stringify(file)}`);
  }
  if (file.includes("\\") || path.posix.basename(file) !== file) {
    throw new Error(`non-POSIX contract path: ${file}`);
  }
  if (file === MANIFEST_FILE) {
    throw new Error(`the manifest must never hash itself: ${file}`);
  }
  // `fatal: true` throws on any invalid UTF-8 sequence; `ignoreBOM: true` keeps a
  // leading BOM as U+FEFF instead of silently stripping it, so the check below can
  // reject it.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${file}: UTF-8 BOM is forbidden`);
  if (text.includes("\r")) throw new Error(`${file}: CR/CRLF is forbidden; contract bytes must be LF`);
  if (!text.endsWith("\n")) throw new Error(`${file}: final LF is required`);
  return text;
}

/**
 * Build the manifest bytes from pre-read `{ file, bytes }` entries. Entries are
 * sorted by POSIX path (stable, `localeCompare(..., "en")`), each is validated,
 * and duplicates are rejected. The result is UTF-8/LF with a final LF.
 *
 * @param {Array<{file: string, bytes: Uint8Array}>} entries
 * @returns {Uint8Array}
 */
export function buildManifestBytes(entries) {
  if (!Array.isArray(entries)) throw new Error("entries must be an array");
  const sorted = [...entries].sort((a, b) => a.file.localeCompare(b.file, "en"));
  const seen = new Set();
  const lines = [];
  for (const { file, bytes } of sorted) {
    if (seen.has(file)) throw new Error(`duplicate contract file: ${file}`);
    seen.add(file);
    validateContractTextBytes(file, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    lines.push(`${digest}  ${file}`);
  }
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

/**
 * Read the hashed contract inputs from a repository root.
 * @param {string} root
 * @returns {Promise<{ dir: string, manifestPath: string, entries: Array<{file: string, bytes: Uint8Array}> }>}
 */
async function readContractEntries(root) {
  const dir = path.join(root, ...CONTRACT_DIR_SEGMENTS);
  const entries = [];
  for (const file of CONTRACT_FILES) {
    const bytes = await readFile(path.join(dir, file));
    entries.push({ file, bytes });
  }
  return { dir, manifestPath: path.join(dir, MANIFEST_FILE), entries };
}

async function main() {
  const check = process.argv.includes("--check");
  const root = process.cwd();
  const { manifestPath, entries } = await readContractEntries(root);
  const manifest = buildManifestBytes(entries);

  if (check) {
    let existing;
    try {
      existing = await readFile(manifestPath);
    } catch {
      console.error(`worker-protocol contract manifest missing: ${manifestPath}`);
      console.error("run: pnpm gen:worker-protocol-contract");
      process.exit(1);
    }
    if (Buffer.compare(Buffer.from(manifest), existing) !== 0) {
      console.error("worker-protocol contract manifest is stale or the contract bytes changed.");
      console.error("run: pnpm gen:worker-protocol-contract");
      process.exit(1);
    }
    console.log("worker-protocol contract manifest: OK");
    return;
  }

  await writeFile(manifestPath, manifest);
  console.log(`wrote ${path.posix.join(...CONTRACT_DIR_SEGMENTS, MANIFEST_FILE)}`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
