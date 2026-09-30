import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * #42 — pnpm 10/11 migrates the root `pnpm` field (overrides + patchedDependencies)
 * out of package.json into pnpm-workspace.yaml and drops it from the manifest.
 * Losing that block silently reverts ~22 security-pin overrides and un-applies
 * the embedded-postgres patch the test DB depends on. This contract test fails
 * the required `verify` gate (and locally, pre-push) if the field is gone.
 *
 * Assert STRUCTURE only — never exact override values — so legitimate override
 * adds/bumps don't churn it.
 */
// server/src/__tests__ -> repo root is three levels up.
const ROOT = path.resolve(__dirname, "..", "..", "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

describe("pnpm manifest guard (#42) — pnpm 10/11 must not have dropped the pnpm field", () => {
  it("resolves the aoa root package.json", () => {
    // Guards against a wrong-path resolution making the rest vacuously pass.
    expect(pkg.name).toBe("aoa");
  });

  it("pins packageManager to pnpm 9.x", () => {
    expect(pkg.packageManager).toMatch(/^pnpm@9\./);
  });

  it("keeps a non-empty pnpm.overrides block (the security pins)", () => {
    expect(pkg.pnpm?.overrides).toBeTypeOf("object");
    expect(Object.keys(pkg.pnpm.overrides).length).toBeGreaterThan(10);
  });

  it("keeps the embedded-postgres patchedDependencies entry and its patch file", () => {
    const patched: Record<string, string> = pkg.pnpm?.patchedDependencies ?? {};
    const key = Object.keys(patched).find((k) => k.startsWith("embedded-postgres@"));
    expect(key, "embedded-postgres patchedDependencies entry missing").toBeTruthy();
    expect(
      existsSync(path.join(ROOT, patched[key!])),
      `patch file ${patched[key!]} missing on disk`,
    ).toBe(true);
  });

  it("pnpm-workspace.yaml has not absorbed the pnpm field (the pnpm 10/11 destination)", () => {
    // pnpm 10/11 relocates `overrides`/`patchedDependencies` OUT of package.json
    // and INTO top-level keys in pnpm-workspace.yaml — detect that directly.
    const wsPath = path.join(ROOT, "pnpm-workspace.yaml");
    if (!existsSync(wsPath)) return;
    const ws = readFileSync(wsPath, "utf8");
    // Match TOP-LEVEL keys only (column 0, no indentation) — pnpm 10/11 writes
    // these at the root of the file. An indented `overrides:` (e.g. a named
    // catalog under `catalogs:`) is legitimate and must not trip the guard.
    expect(
      ws,
      "overrides migrated into pnpm-workspace.yaml — run under pnpm 9.15.4 and move them back to package.json",
    ).not.toMatch(/^overrides\s*:/m);
    expect(
      ws,
      "patchedDependencies migrated into pnpm-workspace.yaml — move it back to package.json",
    ).not.toMatch(/^patchedDependencies\s*:/m);
  });
});
