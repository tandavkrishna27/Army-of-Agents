/**
 * Slice 7 — cross-platform determinism.
 *
 * A git base of the same commit yields BYTE-identical manifest bytes/hash (exec
 * bit normalized by git; paths normalized to forward slashes; content read raw).
 * The content_manifest exec-bit caveat (DAT-001-D5: forced `false` on Windows) is
 * documented + asserted against the running platform.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildWorkspaceManifest, type BuildWorkspaceManifestInput } from "../build-manifest.js";

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoa-snap-det-"));
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
    untracked: "exclude",
    ignore: { kind: "explicit", rules: [] },
    sha256,
    ...over,
  };
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

describe("cross-platform determinism", () => {
  it("git base of the same commit is byte-identical across captures", async () => {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@example.com"]);
    git(dir, ["config", "user.name", "Test"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    writeFileSync(path.join(dir, "a", "b", "c.txt"), "deep\n");
    writeFileSync(path.join(dir, "top.txt"), "top\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);

    const gitOver: Partial<BuildWorkspaceManifestInput> = { base: "git_commit", ignore: { kind: "gitignore_plus_aoa" } };
    const a = await buildWorkspaceManifest(input(dir, gitOver));
    const b = await buildWorkspaceManifest(input(dir, gitOver));

    expect(a.manifestHash).toBe(b.manifestHash);
    expect(JSON.stringify(a.manifest)).toBe(JSON.stringify(b.manifest));
    // Nested paths are normalized to forward slashes regardless of host separator.
    expect(a.manifest.entries.map((e) => e.path)).toEqual(["a/b/c.txt", "top.txt"]);
  });

  it("content_manifest executable bit follows the DAT-001-D5 platform rule", async () => {
    writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
    try {
      chmodSync(path.join(dir, "run.sh"), 0o755);
    } catch {
      // best-effort; Windows chmod is a no-op.
    }
    const result = await buildWorkspaceManifest(input(dir));
    const entry = result.manifest.entries.find((e) => e.path === "run.sh");
    // Windows → always false (stat.mode unreliable); POSIX → reflects the +x bit.
    expect(entry?.executable).toBe(process.platform !== "win32");
  });
});
