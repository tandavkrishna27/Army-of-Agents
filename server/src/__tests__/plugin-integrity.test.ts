/**
 * Tests for plugin-integrity helpers — Sprint 1 C11.
 *
 * Pure-function + filesystem-fixture tests with no drizzle dependencies.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  verifyIntegrity,
  IntegrityMismatchError,
  readInstalledIntegrity,
} from "../services/plugin-integrity.js";

describe("verifyIntegrity", () => {
  it("does not throw when expected and actual match exactly", () => {
    expect(() =>
      verifyIntegrity(
        "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",
        "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",
        "left-pad",
      ),
    ).not.toThrow();
  });

  it("throws IntegrityMismatchError with expected/actual/packageName when hashes differ", () => {
    let caught: unknown = null;
    try {
      verifyIntegrity("sha512-abc", "sha512-xyz", "evil-pkg");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(IntegrityMismatchError);
    const e = caught as IntegrityMismatchError;
    expect(e.expected).toBe("sha512-abc");
    expect(e.actual).toBe("sha512-xyz");
    expect(e.packageName).toBe("evil-pkg");
    expect(e.message).toContain("evil-pkg");
    expect(e.message).toContain("sha512-abc");
    expect(e.message).toContain("sha512-xyz");
    expect(e.name).toBe("IntegrityMismatchError");
  });

  it("treats different algorithms as a mismatch (sha256 vs sha512)", () => {
    expect(() =>
      verifyIntegrity("sha256-abc", "sha512-abc", "p"),
    ).toThrow(IntegrityMismatchError);
  });
});

describe("readInstalledIntegrity", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "aoa-integrity-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeLockfile(installDir: string, packages: Record<string, unknown>): Promise<void> {
    const lockfile = {
      name: "test-install",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages,
    };
    await writeFile(path.join(installDir, "package-lock.json"), JSON.stringify(lockfile, null, 2));
  }

  it("returns the integrity string from package-lock.json for a plain package", async () => {
    const expected = "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==";
    const pkgDir = path.join(tmp, "node_modules", "left-pad");
    await mkdir(pkgDir, { recursive: true });
    await writeLockfile(tmp, {
      "": { name: "test-install", version: "1.0.0" },
      "node_modules/left-pad": {
        version: "1.3.0",
        resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
        integrity: expected,
      },
    });

    const result = await readInstalledIntegrity(pkgDir, tmp, "left-pad");
    expect(result).toBe(expected);
  });

  it("returns the integrity string for a scoped package", async () => {
    const expected = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    const pkgDir = path.join(tmp, "node_modules", "@armyofagents", "aoa-plugin-slack");
    await mkdir(pkgDir, { recursive: true });
    await writeLockfile(tmp, {
      "": { name: "test-install", version: "1.0.0" },
      "node_modules/@armyofagents/aoa-plugin-slack": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/@armyofagents/aoa-plugin-slack/-/aoa-plugin-slack-1.0.0.tgz",
        integrity: expected,
      },
    });

    const result = await readInstalledIntegrity(pkgDir, tmp, "@armyofagents/aoa-plugin-slack");
    expect(result).toBe(expected);
  });

  it("returns null when the lockfile is missing", async () => {
    const pkgDir = path.join(tmp, "node_modules", "no-lockfile");
    await mkdir(pkgDir, { recursive: true });
    // intentionally no package-lock.json

    const result = await readInstalledIntegrity(pkgDir, tmp, "no-lockfile");
    expect(result).toBeNull();
  });

  it("returns null when the package is not in the lockfile", async () => {
    const pkgDir = path.join(tmp, "node_modules", "missing-pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeLockfile(tmp, {
      "": { name: "test-install", version: "1.0.0" },
      "node_modules/some-other-pkg": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/some-other-pkg/-/some-other-pkg-1.0.0.tgz",
        integrity: "sha512-other==",
      },
    });

    const result = await readInstalledIntegrity(pkgDir, tmp, "missing-pkg");
    expect(result).toBeNull();
  });

  it("returns null when lockfile is malformed JSON (does not throw)", async () => {
    const pkgDir = path.join(tmp, "node_modules", "broken-lock");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(path.join(tmp, "package-lock.json"), "{not valid json");

    const result = await readInstalledIntegrity(pkgDir, tmp, "broken-lock");
    expect(result).toBeNull();
  });

  it("falls back to node_modules/.package-lock.json when top-level lockfile is missing", async () => {
    const expected = "sha512-FROMNESTEDLOCK==";
    const pkgDir = path.join(tmp, "node_modules", "nested-lock-pkg");
    await mkdir(pkgDir, { recursive: true });
    const nestedLock = {
      name: "test-install",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "node_modules/nested-lock-pkg": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/nested-lock-pkg/-/nested-lock-pkg-1.0.0.tgz",
          integrity: expected,
        },
      },
    };
    await writeFile(
      path.join(tmp, "node_modules", ".package-lock.json"),
      JSON.stringify(nestedLock, null, 2),
    );

    const result = await readInstalledIntegrity(pkgDir, tmp, "nested-lock-pkg");
    expect(result).toBe(expected);
  });
});
