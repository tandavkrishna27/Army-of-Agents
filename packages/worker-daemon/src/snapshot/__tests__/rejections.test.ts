/**
 * Slice 2 — fail-closed rejections.
 *
 * Every attack scenario must THROW (never silently skip). Special-file / device
 * rejection is unit-tested against a fabricated `Stats` (cross-platform,
 * deterministic); symlink + case-collision end-to-end tests are per-OS-skipped
 * where the host cannot create the artifact (Windows: unprivileged symlink,
 * case-insensitive FS). These scenarios are built at TEST TIME — never committed.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Stats } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertNoCollisions,
  assertRepresentable,
  buildWorkspaceManifest,
  type BuildWorkspaceManifestInput,
} from "../build-manifest.js";
import { WorkspaceSnapshotError } from "../errors.js";
import { DEFAULT_SNAPSHOT_LIMITS } from "../limits.js";

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function fakeStats(overrides: Partial<Record<keyof Stats, boolean>>): Stats {
  const flag = (name: string) => () => overrides[name as keyof Stats] === true;
  return {
    isFile: flag("isFile"),
    isDirectory: flag("isDirectory"),
    isSymbolicLink: flag("isSymbolicLink"),
    isFIFO: flag("isFIFO"),
    isSocket: flag("isSocket"),
    isBlockDevice: flag("isBlockDevice"),
    isCharacterDevice: flag("isCharacterDevice"),
  } as unknown as Stats;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoa-snap-rej-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function input(root: string, over: Partial<BuildWorkspaceManifestInput> = {}): BuildWorkspaceManifestInput {
  return {
    root,
    base: "content_manifest",
    caseMode: "sensitive",
    organizationId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    artifactId: "33333333-3333-4333-8333-333333333333",
    sourceTargetId: "44444444-4444-4444-8444-444444444444",
    folderGrantId: null,
    captureToolVersion: "aoa-worker-daemon/test",
    capturedAt: "2026-08-14T00:00:00.000Z",
    untracked: "include",
    ignore: { kind: "explicit", rules: [] },
    sha256,
    ...over,
  };
}

describe("assertRepresentable — special/device/symlink rejection", () => {
  it("accepts a plain file and a plain directory", () => {
    expect(() => assertRepresentable(fakeStats({ isFile: true }), "a")).not.toThrow();
    expect(() => assertRepresentable(fakeStats({ isDirectory: true }), "a")).not.toThrow();
  });

  for (const kind of ["isSymbolicLink", "isFIFO", "isSocket", "isBlockDevice", "isCharacterDevice"] as const) {
    it(`rejects a ${kind} node`, () => {
      expect(() => assertRepresentable(fakeStats({ [kind]: true }), "x")).toThrow(WorkspaceSnapshotError);
    });
  }

  it("rejects an unknown node type (neither file nor directory)", () => {
    expect(() => assertRepresentable(fakeStats({}), "x")).toThrow(WorkspaceSnapshotError);
  });
});

describe("assertNoCollisions", () => {
  it("rejects a duplicate path", () => {
    expect(() => assertNoCollisions(["a", "b", "a"])).toThrow(/duplicate/);
  });
  it("rejects a case-colliding path", () => {
    expect(() => assertNoCollisions(["Foo", "foo"])).toThrow(/case-colliding/);
  });
  it("accepts distinct case-sensitive-unique paths", () => {
    expect(() => assertNoCollisions(["a", "b", "c/d"])).not.toThrow();
  });
});

describe("size ceilings reject the whole snapshot (never silent-skip)", () => {
  it("rejects a file over the per-file ceiling", async () => {
    writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(1024));
    await expect(
      buildWorkspaceManifest(input(dir, { limits: { ...DEFAULT_SNAPSHOT_LIMITS, maxFileBytes: 512 } })),
    ).rejects.toThrow(/per-file ceiling/);
  });

  it("rejects when the cumulative total exceeds the total ceiling", async () => {
    writeFileSync(path.join(dir, "a.bin"), Buffer.alloc(400));
    writeFileSync(path.join(dir, "b.bin"), Buffer.alloc(400));
    await expect(
      buildWorkspaceManifest(input(dir, { limits: { ...DEFAULT_SNAPSHOT_LIMITS, maxTotalBytes: 500 } })),
    ).rejects.toThrow(/total-bytes ceiling/);
  });

  it("rejects when the entry count exceeds the entry ceiling", async () => {
    writeFileSync(path.join(dir, "a.txt"), "1");
    writeFileSync(path.join(dir, "b.txt"), "2");
    writeFileSync(path.join(dir, "c.txt"), "3");
    await expect(
      buildWorkspaceManifest(input(dir, { limits: { ...DEFAULT_SNAPSHOT_LIMITS, maxEntries: 2 } })),
    ).rejects.toThrow(/entry-count ceiling/);
  });
});

describe("symlink rejection end-to-end (per-OS skip)", () => {
  it("rejects a symlink discovered during the walk", async () => {
    writeFileSync(path.join(dir, "real.txt"), "hi");
    let created = false;
    try {
      symlinkSync(path.join(dir, "real.txt"), path.join(dir, "link.txt"));
      created = true;
    } catch {
      // Windows unprivileged symlink creation fails → skip.
    }
    if (!created) {
      expect(true).toBe(true);
      return;
    }
    await expect(buildWorkspaceManifest(input(dir))).rejects.toThrow(/symlink/);
  });
});
