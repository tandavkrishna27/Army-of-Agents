/**
 * DAT-003 S2 — rename detection + the frozen `.parse()` fail-closed gate.
 *
 * A base-only path whose sha256 equals a result-only path's sha256, 1:1, folds
 * into one `rename{fromPath, path, resultSha256, sizeBytes}`. Ambiguous multi-way
 * content identity does NOT fold (deterministic delete+create). The frozen schema's
 * hash-equal + duplicate-destination-path refinements are the final gate.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { WorkspaceManifestV1 } from "@armyofagents/worker-protocol";

import { buildWorkspacePatch, type BuildWorkspacePatchInput } from "../build-patch.js";

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const ARTIFACT = "44444444-4444-4444-8444-444444444444";

interface FileSpec { path: string; content: string }

function manifest(specs: FileSpec[]): WorkspaceManifestV1 {
  const entries = specs.map((s) => {
    const bytes = Buffer.from(s.content, "utf8");
    return { path: s.path, kind: "file" as const, provenance: "untracked" as const, sizeBytes: bytes.length, sha256: sha256(bytes), executable: false };
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    protocolVersion: 1,
    organizationId: ORG,
    companyId: COMPANY,
    artifactId: ARTIFACT,
    base: {
      kind: "content_manifest",
      algorithm: "sha256",
      revision: "e".repeat(64),
      dirty: false,
      caseMode: "sensitive",
      ignorePolicy: { kind: "explicit", digest: "f".repeat(64) },
      inclusion: { tracked: true, untracked: "include", ignored: false },
    },
    snapshotProvenance: {
      capturedAt: "2026-08-14T00:00:00.000Z",
      sourceTargetId: "55555555-5555-4555-8555-555555555555",
      folderGrantId: null,
      captureToolVersion: "aoa-worker-daemon/test",
    },
    entries,
  } as WorkspaceManifestV1;
}

function ctx(base: WorkspaceManifestV1, result: WorkspaceManifestV1): BuildWorkspacePatchInput {
  return { base, result, organizationId: ORG, companyId: COMPANY, jobId: JOB, attempt: 1, artifactId: ARTIFACT, sha256 };
}

describe("DAT-003 producer — rename detection", () => {
  it("folds a 1:1 content-identical delete+create into a single rename", () => {
    const base = manifest([{ path: "old/name.txt", content: "moved" }]);
    const result = manifest([{ path: "new/name.txt", content: "moved" }]);
    const { patch } = buildWorkspacePatch(ctx(base, result));
    expect(patch.operations).toHaveLength(1);
    expect(patch.operations[0]).toMatchObject({
      op: "rename",
      fromPath: "old/name.txt",
      path: "new/name.txt",
      resultSha256: sha256(Buffer.from("moved")),
      sizeBytes: 5,
    });
  });

  it("does NOT fold when the moved content also changed (delete + create)", () => {
    const base = manifest([{ path: "old.txt", content: "before" }]);
    const result = manifest([{ path: "new.txt", content: "after" }]);
    const { patch } = buildWorkspacePatch(ctx(base, result));
    const ops = patch.operations.map((o) => o.op).sort();
    expect(ops).toEqual(["create", "delete"]);
  });

  it("does NOT fold an ambiguous 2-delete / 1-create same-sha group (deterministic)", () => {
    const base = manifest([
      { path: "a.txt", content: "dup" },
      { path: "b.txt", content: "dup" },
    ]);
    const result = manifest([{ path: "c.txt", content: "dup" }]);
    const { patch } = buildWorkspacePatch(ctx(base, result));
    const byPath = Object.fromEntries(patch.operations.map((o) => [o.path, o.op]));
    expect(byPath).toEqual({ "a.txt": "delete", "b.txt": "delete", "c.txt": "create" });
    expect(patch.operations.some((o) => o.op === "rename")).toBe(false);
  });

  it("detects two independent renames deterministically", () => {
    const base = manifest([
      { path: "a.txt", content: "X" },
      { path: "b.txt", content: "Y" },
    ]);
    const result = manifest([
      { path: "c.txt", content: "X" },
      { path: "d.txt", content: "Y" },
    ]);
    const { patch } = buildWorkspacePatch(ctx(base, result));
    const renames = patch.operations.filter((o) => o.op === "rename").map((o) => (o as { fromPath: string; path: string }));
    expect(renames).toEqual([
      { op: "rename", fromPath: "a.txt", path: "c.txt", resultSha256: sha256(Buffer.from("X")), sizeBytes: 1 },
      { op: "rename", fromPath: "b.txt", path: "d.txt", resultSha256: sha256(Buffer.from("Y")), sizeBytes: 1 },
    ]);
  });

  it("is deterministic: two builds of the same inputs are byte-identical", () => {
    const base = manifest([
      { path: "keep.txt", content: "k" },
      { path: "mod.txt", content: "old" },
      { path: "moved.txt", content: "M" },
      { path: "del.txt", content: "d" },
    ]);
    const result = manifest([
      { path: "keep.txt", content: "k" },
      { path: "mod.txt", content: "new" },
      { path: "renamed.txt", content: "M" },
      { path: "created.txt", content: "c" },
    ]);
    const a = buildWorkspacePatch(ctx(base, result));
    const b = buildWorkspacePatch(ctx(base, result));
    expect(JSON.stringify(a.patch)).toBe(JSON.stringify(b.patch));
  });
});
