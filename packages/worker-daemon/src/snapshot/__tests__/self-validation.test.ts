/**
 * Slice 5 — the DAT-001-D2 self-validation gate.
 *
 * The producer runs `workspaceManifestV1Schema.parse()` on its OWN output as the
 * final fail-closed gate (a real runtime parse, not a type assertion). These
 * tests feed the exact gate `parseManifestFailClosed` internally-malformed
 * manifests and assert it THROWS — proving the local fail-closed guarantee.
 */

import { describe, expect, it } from "vitest";

import { parseManifestFailClosed } from "../build-manifest.js";
import { WorkspaceSnapshotError } from "../errors.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";
const TARGET = "44444444-4444-4444-8444-444444444444";
const HEX = "a".repeat(64);

function baseManifest(entries: unknown[]): Record<string, unknown> {
  return {
    protocolVersion: 1,
    organizationId: ORG,
    companyId: COMPANY,
    artifactId: ARTIFACT,
    base: {
      kind: "content_manifest",
      algorithm: "sha256",
      revision: HEX,
      dirty: false,
      caseMode: "sensitive",
      ignorePolicy: { kind: "explicit", digest: HEX },
      inclusion: { tracked: true, untracked: "include", ignored: false },
    },
    snapshotProvenance: {
      capturedAt: "2026-08-14T00:00:00.000Z",
      sourceTargetId: TARGET,
      folderGrantId: null,
      captureToolVersion: "aoa-worker-daemon/test",
    },
    entries,
  };
}

const fileEntry = (path: string) => ({ path, kind: "file", provenance: "untracked", sizeBytes: 1, sha256: HEX, executable: false });

describe("parseManifestFailClosed — self-validation gate", () => {
  it("accepts a well-formed manifest and returns it", () => {
    const manifest = parseManifestFailClosed(baseManifest([fileEntry("a.txt")]));
    expect(manifest.entries[0].path).toBe("a.txt");
  });

  it("rejects a traversal ('..') entry path", () => {
    expect(() => parseManifestFailClosed(baseManifest([fileEntry("../escape")]))).toThrow(WorkspaceSnapshotError);
  });

  it("rejects an absolute entry path", () => {
    expect(() => parseManifestFailClosed(baseManifest([fileEntry("/etc/passwd")]))).toThrow(WorkspaceSnapshotError);
  });

  it("rejects a directory entry carrying a content hash", () => {
    const badDir = { path: "d", kind: "directory", provenance: "untracked", sizeBytes: 0, sha256: HEX, executable: false };
    expect(() => parseManifestFailClosed(baseManifest([badDir]))).toThrow(WorkspaceSnapshotError);
  });

  it("rejects a file entry with a null content hash", () => {
    const badFile = { path: "f", kind: "file", provenance: "untracked", sizeBytes: 1, sha256: null, executable: false };
    expect(() => parseManifestFailClosed(baseManifest([badFile]))).toThrow(WorkspaceSnapshotError);
  });

  it("rejects a case-colliding entry pair", () => {
    expect(() => parseManifestFailClosed(baseManifest([fileEntry("Foo"), fileEntry("foo")]))).toThrow(
      WorkspaceSnapshotError,
    );
  });

  it("rejects a git_sha1 base whose revision is not 40-hex", () => {
    const m = baseManifest([fileEntry("a.txt")]);
    (m.base as Record<string, unknown>).kind = "git_commit";
    (m.base as Record<string, unknown>).algorithm = "git_sha1";
    (m.base as Record<string, unknown>).ignorePolicy = { kind: "gitignore_plus_aoa", digest: HEX };
    // revision is still 64-hex → mismatch for git_sha1 (expects 40-hex).
    expect(() => parseManifestFailClosed(m)).toThrow(WorkspaceSnapshotError);
  });

  it("rejects an unknown top-level key (strict schema)", () => {
    const m = baseManifest([fileEntry("a.txt")]);
    (m as Record<string, unknown>).surprise = "x";
    expect(() => parseManifestFailClosed(m)).toThrow(WorkspaceSnapshotError);
  });
});
