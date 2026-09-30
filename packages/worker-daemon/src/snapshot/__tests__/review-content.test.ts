/**
 * DAT-001 adversarial-review regression tests — content-base determinism.
 *
 * Covers:
 *   E — no Unicode normalization: an NFD path and its NFC equivalent produced
 *       different `contentRevision`/`manifestHash`, breaking the cross-platform
 *       "same tree → same hash" acceptance criterion. The producer now folds paths
 *       to NFC at the normalization choke point.
 *   F — defense-in-depth: the fail-closed finalize step asserts entries are in the
 *       pinned UTF-8 byte order (the sort is the sole ordering authority, so a
 *       future sort regression fails closed rather than minting a non-reproducible
 *       manifestHash).
 */

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildWorkspaceManifest, assertEntriesSorted, type BuildWorkspaceManifestInput } from "../build-manifest.js";
import { WorkspaceSnapshotError } from "../errors.js";
import type { SnapshotEntry } from "../hashing.js";

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoa-snap-review-content-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function contentInput(over: Partial<BuildWorkspaceManifestInput> = {}): BuildWorkspaceManifestInput {
  return {
    root: dir,
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

const file = (entry: Partial<SnapshotEntry> & { path: string }): SnapshotEntry => ({
  kind: "file",
  provenance: "untracked",
  sizeBytes: 1,
  sha256: "a".repeat(64),
  executable: false,
  ...entry,
});

describe("DAT-001 review — content-base determinism", () => {
  // Finding E — NFD "café" (e + combining acute) must hash identically to NFC "café".
  it("normalizes entry paths to NFC so NFD and NFC filenames are byte-identical", async () => {
    const nfd = "café.txt"; // c a f e + U+0301 COMBINING ACUTE ACCENT
    const nfc = "café.txt"; // c a f + U+00E9 (é)
    expect(nfd).not.toBe(nfc); // sanity: they are distinct code-unit sequences
    writeFileSync(path.join(dir, nfd), "x\n");

    const result = await buildWorkspaceManifest(contentInput());
    const paths = result.manifest.entries.map((e) => e.path);
    expect(paths).toContain(nfc);
    expect(paths).not.toContain(nfd);
  });

  // Finding F — the finalize gate rejects an out-of-order entry list (defense-in-depth).
  it("assertEntriesSorted throws on entries not in UTF-8 byte order", () => {
    const ordered = [file({ path: "a.txt" }), file({ path: "b.txt" })];
    expect(() => assertEntriesSorted(ordered)).not.toThrow();

    const reversed = [file({ path: "b.txt" }), file({ path: "a.txt" })];
    expect(() => assertEntriesSorted(reversed)).toThrow(WorkspaceSnapshotError);
  });
});
