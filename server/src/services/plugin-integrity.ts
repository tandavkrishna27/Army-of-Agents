/**
 * @fileoverview Plugin install integrity verification (Sprint 1 C11).
 *
 * When the marketplace catalog declares `npm.integrity` for a plugin, this
 * service compares the npm-recorded integrity in `package-lock.json` (post
 * `npm install`) against the catalog-declared value. A mismatch fail-closes
 * with `IntegrityMismatchError`, defending against:
 *  - compromised npm registry mirrors swapping tarballs,
 *  - MITM on the npm.pm CDN,
 *  - upstream supply-chain tampering.
 *
 * Integrity strings follow Subresource Integrity (SRI) / npm metadata format:
 * `<algorithm>-<base64>`, e.g. `sha512-XI5MPzVNApjAyhQzphX8...==`.
 *
 * Comparison is exact-string. npm always emits canonical form, so no
 * normalization is needed; differing algorithms are correctly counted as a
 * mismatch.
 *
 * Catalog items without an `integrity` field bypass verification — the caller
 * is responsible for emitting a one-line WARN. This keeps the field opt-in so
 * the AoA marketplace catalog can populate it gradually.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Thrown when the integrity hash recorded by npm in `package-lock.json`
 * does not match the integrity string declared by the marketplace catalog.
 *
 * Both values are surfaced for diagnosis. Callers should treat this as
 * fail-closed (do not register the plugin row) and may attempt cleanup of
 * the on-disk install artifacts.
 */
export class IntegrityMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;
  readonly packageName: string;

  constructor(packageName: string, expected: string, actual: string) {
    super(
      `Plugin ${packageName} integrity mismatch: catalog expected ${expected}, npm installed ${actual}. ` +
        `This may indicate a compromised npm registry mirror, MITM, or upstream tampering — install fail-closed.`,
    );
    this.name = "IntegrityMismatchError";
    this.expected = expected;
    this.actual = actual;
    this.packageName = packageName;
  }
}

/**
 * Verify that the `actual` integrity npm recorded matches the `expected`
 * integrity declared by the marketplace catalog. Throws on mismatch.
 *
 * Comparison is exact-string. The expected format is `<algorithm>-<base64>`.
 * Different algorithms count as mismatch (npm itself does the same — it
 * picks a single algorithm per package and never silently re-hashes).
 *
 * Caller responsibility: only call this when the catalog supplied a
 * non-empty `expected` value.
 *
 * @throws {IntegrityMismatchError} if expected !== actual.
 */
export function verifyIntegrity(
  expected: string,
  actual: string,
  packageName: string,
): void {
  if (expected !== actual) {
    throw new IntegrityMismatchError(packageName, expected, actual);
  }
}

/**
 * Read the integrity string npm recorded for `packageName` from the
 * `package-lock.json` it just wrote. Returns the integrity (e.g.
 * `sha512-...`) if found, or `null` if the lockfile or the package entry
 * cannot be located.
 *
 * Lookup order:
 *  1. `<installDir>/package-lock.json` — the canonical lockfile that
 *     `npm install --prefix <installDir>` writes alongside `package.json`.
 *  2. `<installDir>/node_modules/.package-lock.json` — npm's hidden lockfile
 *     for cases where the top-level lockfile isn't written (e.g. some
 *     legacy npm configurations).
 *
 * Both lockfiles use the same `packages` map keyed by `node_modules/<pkg>`
 * with `integrity` on each entry.
 *
 * Never throws — JSON parse failures, missing files, and missing entries
 * all return `null`. The caller decides how to react to a `null` (the
 * integrity-verification path treats it as a hard error since the catalog
 * explicitly asked for verification).
 *
 * @param packagePath - Resolved absolute path of the installed package
 *   (currently unused but accepted for callsite ergonomics — the caller
 *   already has it from installation, and future heuristics may inspect
 *   it directly).
 * @param installDir - The `--prefix` target passed to `npm install` (where
 *   `package-lock.json` lives one level above `node_modules`).
 * @param packageName - The canonical package name as it appears in
 *   `package-lock.json`'s `packages` map (e.g. `left-pad` or
 *   `@armyofagents/aoa-plugin-slack`).
 */
export async function readInstalledIntegrity(
  _packagePath: string,
  installDir: string,
  packageName: string,
): Promise<string | null> {
  const lookupKey = `node_modules/${packageName}`;

  for (const lockfilePath of [
    path.join(installDir, "package-lock.json"),
    path.join(installDir, "node_modules", ".package-lock.json"),
  ]) {
    if (!existsSync(lockfilePath)) continue;

    let parsed: { packages?: Record<string, { integrity?: string }> };
    try {
      const raw = await readFile(lockfilePath, "utf-8");
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      // Malformed JSON or unreadable file — try the next candidate.
      continue;
    }

    const entry = parsed.packages?.[lookupKey];
    if (entry && typeof entry.integrity === "string" && entry.integrity.length > 0) {
      return entry.integrity;
    }
  }

  return null;
}
