/**
 * Slice 1 — content_manifest over a plain temp folder.
 *
 * Walk + hash + sort + canonicalize; two builds of an identical tree (with
 * identical injected `capturedAt`/`artifactId`) MUST yield identical
 * `contentRevision` AND identical `manifestHash`, and the frozen schema must
 * accept the output.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { workspaceManifestV1Schema } from "@armyofagents/worker-protocol";

import { buildWorkspaceManifest, type BuildWorkspaceManifestInput } from "../build-manifest.js";

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";
const TARGET = "44444444-4444-4444-8444-444444444444";

function baseInput(root: string): BuildWorkspaceManifestInput {
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
    capturedAt: "2026-08-14T00:00:00.000Z",
    untracked: "include",
    ignore: { kind: "explicit", rules: [] },
    sha256,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoa-snap-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedTree(root: string): void {
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "a.txt"), "alpha\n");
  writeFileSync(path.join(root, "readme.md"), "# hi\n");
  writeFileSync(path.join(root, "src", "b.bin"), Buffer.from([0, 1, 2, 3]));
}

describe("buildWorkspaceManifest — content_manifest", () => {
  it("produces a schema-valid manifest that includes every file and directory", async () => {
    seedTree(dir);
    const result = await buildWorkspaceManifest(baseInput(dir));

    // The frozen schema accepts the output (independent of the producer's own gate).
    expect(() => workspaceManifestV1Schema.parse(result.manifest)).not.toThrow();

    const paths = result.manifest.entries.map((entry) => entry.path);
    expect(paths).toContain("readme.md");
    expect(paths).toContain("src");
    expect(paths).toContain("src/a.txt");
    expect(paths).toContain("src/b.bin");

    const fileEntry = result.manifest.entries.find((entry) => entry.path === "src/a.txt");
    expect(fileEntry?.kind).toBe("file");
    expect(fileEntry?.sizeBytes).toBe(6);
    expect(fileEntry?.sha256).toBe(sha256("alpha\n"));

    const dirEntry = result.manifest.entries.find((entry) => entry.path === "src");
    expect(dirEntry?.kind).toBe("directory");
    expect(dirEntry?.sha256).toBeNull();
    expect(dirEntry?.sizeBytes).toBe(0);
    expect(dirEntry?.executable).toBe(false);

    expect(result.manifest.base.kind).toBe("content_manifest");
    expect(result.manifest.base.algorithm).toBe("sha256");
    expect(result.manifest.base.dirty).toBe(false);
    // content base: revision IS the repeatable content-identity digest.
    expect(result.manifest.base.revision).toBe(result.contentRevision);
    expect(result.contentRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sorts entries by the UTF-8 byte order of the normalized path", async () => {
    seedTree(dir);
    const result = await buildWorkspaceManifest(baseInput(dir));
    const paths = result.manifest.entries.map((entry) => entry.path);
    const sorted = [...paths].sort((a, b) => {
      const ba = Buffer.from(a, "utf8");
      const bb = Buffer.from(b, "utf8");
      return Buffer.compare(ba, bb);
    });
    expect(paths).toEqual(sorted);
  });

  it("is repeatable: two builds of the same tree give identical hashes", async () => {
    seedTree(dir);
    const a = await buildWorkspaceManifest(baseInput(dir));
    const b = await buildWorkspaceManifest(baseInput(dir));
    expect(a.contentRevision).toBe(b.contentRevision);
    expect(a.manifestHash).toBe(b.manifestHash);
  });

  it("contentRevision excludes capture metadata but manifestHash includes it", async () => {
    seedTree(dir);
    const a = await buildWorkspaceManifest(baseInput(dir));
    const b = await buildWorkspaceManifest({ ...baseInput(dir), capturedAt: "2026-09-01T12:00:00.000Z" });
    // Same content ⇒ same contentRevision even though capturedAt differs...
    expect(a.contentRevision).toBe(b.contentRevision);
    // ...but the per-capture manifestHash MUST differ.
    expect(a.manifestHash).not.toBe(b.manifestHash);
  });
});

describe("the .aoa keystore directory is NEVER captured, whatever the caller asked for", () => {
  // AOA_BUILTIN_IGNORE_RULES exists, per its own comment, as "the overlay that keeps the
  // `.aoa/` keystore dir out of a snapshot". It was applied on the GIT base only
  // (`git-base.ts`). The content_manifest walk used `input.ignore.rules` — the CALLER's
  // list — so a snapshot taken with an empty rule list walked `.aoa/` and captured
  // whatever was in it.
  //
  // Two snapshot bases, one security-motivated builtin, applied to one of them. The
  // builtin is not advice to callers; it is a floor.

  it("omits .aoa/ even when the caller supplies NO ignore rules", async () => {
    seedTree(dir);
    mkdirSync(path.join(dir, ".aoa"), { recursive: true });
    writeFileSync(path.join(dir, ".aoa", "device-identity.v1.bin"), "PRIVATE-KEY-BYTES");

    const result = await buildWorkspaceManifest(baseInput(dir));
    const paths = result.manifest.entries.map((e) => e.path);
    expect(paths).not.toContain(".aoa/device-identity.v1.bin");
    expect(JSON.stringify(result.manifest)).not.toContain("PRIVATE-KEY-BYTES");
    // Non-vacuity: the rest of the tree IS captured, so this is not passing because the
    // walk found nothing.
    expect(paths).toContain("readme.md");
  });

  it("omits .git/ on the content base too — the same floor, both builtins", async () => {
    seedTree(dir);
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "config"), "[core]\n");

    const result = await buildWorkspaceManifest(baseInput(dir));
    expect(result.manifest.entries.map((e) => e.path)).not.toContain(".git/config");
  });

  it("still honours the caller's own rules — the floor ADDS, it does not replace", async () => {
    // If the builtin merge accidentally replaced the caller's list, this would capture
    // secrets.txt and the fix would have traded one leak for another.
    seedTree(dir);
    writeFileSync(path.join(dir, "secrets.txt"), "caller asked to skip this");

    const input = { ...baseInput(dir), ignore: { kind: "explicit" as const, rules: ["secrets.txt"] } };
    const result = await buildWorkspaceManifest(input);
    const paths = result.manifest.entries.map((e) => e.path);
    expect(paths).not.toContain("secrets.txt");
    expect(paths).toContain("readme.md");
  });

  it("attests what it APPLIED — the digest reflects the floor, not just the caller's list", async () => {
    // The git-base convention, quoted: the builtins are "BOTH folded into the digest
    // (attribution) AND independently APPLIED … makes the attested policy match what was
    // applied". A digest over the caller's list alone would claim a weaker policy than
    // the one enforced, which is the same class of dishonesty as the leak itself.
    seedTree(dir);
    const withRules = await buildWorkspaceManifest({
      ...baseInput(dir), ignore: { kind: "explicit" as const, rules: [".aoa/", ".git/"] },
    });
    const withoutRules = await buildWorkspaceManifest(baseInput(dir));
    expect(withoutRules.manifest.base.ignorePolicy.digest)
      .toBe(withRules.manifest.base.ignorePolicy.digest);
  });
});
