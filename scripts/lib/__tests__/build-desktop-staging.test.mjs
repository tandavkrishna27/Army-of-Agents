/**
 * DSK-003 — the assembler's filesystem adapter uses lstat, proven on a real link.
 *
 * `collectStagingFiles` refuses symlinks and is unit-tested with an injected fs. But the
 * CLI supplies the REAL adapter, and nothing tested that — so a mutant swapping
 * `lstatSync` for `statSync` survived, which is precisely the defect that shipped in the
 * first version: `statSync` follows links, and the assembler declared 3548 files where 346
 * existed.
 *
 * A Windows JUNCTION needs no elevation, so this exercises the real code path on the real
 * platform rather than pinning a string.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { realIo } from "../../build-desktop-staging.mjs";
import { collectStagingFiles } from "../staging-manifest.mjs";

/** Create a directory link without elevation on Windows. */
function linkDir(target, linkPath) {
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

describe("DSK-003 — the real adapter does not follow links", () => {
  it("refuses a root containing a real junction", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aoa-stage-test-"));
    try {
      const real = path.join(dir, "real");
      mkdirSync(real, { recursive: true });
      writeFileSync(path.join(real, "a.js"), "export const a = 1;");
      writeFileSync(path.join(dir, "package.json"), "{}");
      if (!linkDir(real, path.join(dir, "linked"))) return; // unprivileged, no Dev Mode

      const result = collectStagingFiles(dir, realIo);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "symlink_in_artifact");
      assert.ok(result.detail.includes("linked"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collects a link-free root with the real adapter — non-vacuity", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aoa-stage-test-"));
    try {
      mkdirSync(path.join(dir, "dist"), { recursive: true });
      writeFileSync(path.join(dir, "dist", "index.js"), "export const a = 1;");
      writeFileSync(path.join(dir, "package.json"), "{}");
      const result = collectStagingFiles(dir, realIo);
      assert.equal(result.ok, true);
      assert.deepEqual(result.files.map((f) => f.path).sort(), ["dist/index.js", "package.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the file contents it read, not just the paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aoa-stage-test-"));
    try {
      writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
      const result = collectStagingFiles(dir, realIo);
      assert.equal(result.files[0].text, '{"name":"x"}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
