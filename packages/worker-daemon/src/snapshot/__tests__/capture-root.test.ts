/**
 * DSK-002 Lane A / I4 — the capture ROOT is checked, not just its children.
 *
 * `walkContentTree(root, root, …)` calls `readdirSync(dirAbs)` immediately. Every
 * CHILD is `lstat`ed as the walk descends, so a symlink anywhere in the tree is
 * rejected — but the root itself is never stat'ed at all, so a root that IS a
 * symlink is silently followed.
 *
 * That is a TOCTOU escape under DSK-002's threat model: the grant names a base, and
 * anything that can replace that base with a link between grant time and capture
 * time redirects the whole capture. The agent writing into the granted folder is
 * exactly the actor with the access to do it.
 *
 * A junction is used on Windows because it needs no elevation, which makes this the
 * platform-capability proof as well: libuv maps both IO_REPARSE_TAG_SYMLINK and
 * IO_REPARSE_TAG_MOUNT_POINT to `isSymbolicLink()`, and the design doc refused to
 * take that on trust.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildWorkspaceManifest, type BuildWorkspaceManifestInput } from "../build-manifest.js";

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";
const TARGET = "44444444-4444-4444-8444-444444444444";

function inputFor(root: string): BuildWorkspaceManifestInput {
  return {
    root,
    base: "content_manifest",
    caseMode: "sensitive",
    organizationId: ORG,
    companyId: COMPANY,
    artifactId: ARTIFACT,
    sourceTargetId: TARGET,
    folderGrantId: null,
    captureToolVersion: "aoa-worker-daemon/test",
    capturedAt: "2026-08-21T00:00:00.000Z",
    untracked: "include",
    ignore: { kind: "explicit", rules: [] },
    sha256,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoa-root-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Create a directory link without requiring elevation on Windows. */
function linkDir(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false; // unprivileged + no Developer Mode; the caller skips.
  }
}

describe("DSK-002/I4 — a symlinked capture root fails closed", () => {
  it("refuses a root that is a link, instead of following it", () => {
    const real = path.join(dir, "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(path.join(real, "secret.txt"), "CONTENTS-BEHIND-THE-LINK");

    const link = path.join(dir, "link");
    if (!linkDir(real, link)) return; // unprivileged Windows without Developer Mode

    // Non-vacuity first: the SAME tree captured through its real path succeeds, so a
    // rejection below is about the link and not about the tree being unreadable.
    expect(() => buildWorkspaceManifest(inputFor(real))).not.toThrow();

    // Pinned to the SYMLINK arm's exact message. `/symlink|link|root/i` was the first
    // attempt and a mutant walked straight through it: with the symlink arm deleted,
    // `lstat` reports a link as `isDirectory() === false`, so the directory arm rejects
    // it with "capture root is not a directory" — which contains "root", so the loose
    // regex matched and the test passed while the arm was gone.
    expect(() => buildWorkspaceManifest(inputFor(link)))
      .rejects.toThrow(/capture root is a symlink and will not be followed/);
  });

  it("still accepts an ordinary directory root", async () => {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.txt"), "alpha\n");
    const result = await buildWorkspaceManifest(inputFor(dir));
    expect(result.manifest.entries.map((e) => e.path)).toContain("src/a.txt");
  });

  it("refuses a root that is not a directory at all", () => {
    // Asserted on the GUARD's message, not merely "it threw". Without the guard this
    // still failed — with an ENOTDIR from readdirSync — so a bare `.toThrow()` here
    // would have been green before the fix and proven nothing.
    const file = path.join(dir, "just-a-file.txt");
    writeFileSync(file, "not a tree");
    expect(() => buildWorkspaceManifest(inputFor(file)))
      .rejects.toThrow(/capture root is not a directory/);
  });

  it("refuses a root that does not exist, naming the errno", () => {
    expect(() => buildWorkspaceManifest(inputFor(path.join(dir, "nope"))))
      .rejects.toThrow(/capture root is not readable \(ENOENT\)/);
  });
});

describe("DSK-002/I4 — the platform assumption, proven rather than trusted", () => {
  it("reports a directory link as a symlink on this OS", () => {
    // The design doc declined to take libuv's junction handling on trust. If this ever
    // fails on Windows, the root guard above is the ONLY thing standing between a
    // junction and a followed capture — and every in-tree symlink check is also void.
    const real = path.join(dir, "real");
    mkdirSync(real, { recursive: true });
    const link = path.join(dir, "link");
    if (!linkDir(real, link)) return;

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
