/**
 * DAT-003 S1 — the patch producer set-diff (create / modify / delete).
 *
 * A pure in-memory diff of two frozen `WorkspaceManifestV1` entry lists keyed by
 * `path`: result-only file → create; both-present, sha differs → modify; base-only
 * file → delete. Directory entries are ignored by the diff. Op order is the pinned
 * UTF-8 byte order over the (unique) destination path. Self-validated by the frozen
 * `workspacePatchManifestV1Schema.parse()`.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { workspacePatchManifestV1Schema, type WorkspaceManifestV1 } from "@armyofagents/worker-protocol";

import { buildWorkspacePatch, type BuildWorkspacePatchInput } from "../build-patch.js";
import { WorkspacePatchError } from "../errors.js";

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const ARTIFACT = "44444444-4444-4444-8444-444444444444";

interface FileSpec {
  path: string;
  content: string;
  kind?: "file" | "directory";
}

function manifest(specs: FileSpec[], capturedAt = "2026-08-14T00:00:00.000Z"): WorkspaceManifestV1 {
  const entries = specs.map((s) => {
    const kind = s.kind ?? "file";
    if (kind === "directory") {
      return { path: s.path, kind: "directory" as const, provenance: "untracked" as const, sizeBytes: 0, sha256: null, executable: false };
    }
    const bytes = Buffer.from(s.content, "utf8");
    return {
      path: s.path,
      kind: "file" as const,
      provenance: "untracked" as const,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      executable: false,
    };
  });
  // Entries must be sorted; the tests supply pre-sorted specs by simple ASCII.
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
      capturedAt,
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

describe("DAT-003 producer — set-diff", () => {
  it("emits create/modify/delete with a self-validating patch", () => {
    const base = manifest([
      { path: "keep.txt", content: "same" },
      { path: "mod.txt", content: "old" },
      { path: "gone.txt", content: "bye" },
    ]);
    const result = manifest([
      { path: "keep.txt", content: "same" },
      { path: "mod.txt", content: "new" },
      { path: "new.txt", content: "hi" },
    ]);
    const { patch } = buildWorkspacePatch(ctx(base, result));
    // Frozen schema accepts the output.
    expect(() => workspacePatchManifestV1Schema.parse(patch)).not.toThrow();
    const byPath = Object.fromEntries(patch.operations.map((o) => [o.path, o.op]));
    expect(byPath).toEqual({ "mod.txt": "modify", "new.txt": "create", "gone.txt": "delete" });
    // keep.txt (unchanged) produces no op.
    expect(patch.operations.find((o) => o.path === "keep.txt")).toBeUndefined();
  });

  it("orders operations by UTF-8 byte order of the destination path", () => {
    const base = manifest([{ path: "z.txt", content: "z" }]);
    const result = manifest([
      { path: "b.txt", content: "b" },
      { path: "A.txt", content: "A" },
      { path: "a.txt", content: "a" },
    ]);
    const { patch } = buildWorkspacePatch(ctx(base, result));
    // "A" (0x41) < "a" (0x61) < "b" (0x62) < "z" (0x7a); z.txt is a delete at 0x7a.
    expect(patch.operations.map((o) => o.path)).toEqual(["A.txt", "a.txt", "b.txt", "z.txt"]);
  });

  it("ignores directory entries (a directory-only change surfaces via its files)", () => {
    const base = manifest([{ path: "src", content: "", kind: "directory" }]);
    const result = manifest([
      { path: "src", content: "", kind: "directory" },
      { path: "src/x.txt", content: "x" },
    ]);
    const { patch } = buildWorkspacePatch(ctx(base, result));
    expect(patch.operations).toHaveLength(1);
    expect(patch.operations[0]).toMatchObject({ op: "create", path: "src/x.txt" });
  });

  it("carries baseManifestHash != resultManifestHash from computeManifestHash", () => {
    const base = manifest([{ path: "a.txt", content: "1" }]);
    const result = manifest([{ path: "a.txt", content: "2" }]);
    const built = buildWorkspacePatch(ctx(base, result));
    expect(built.baseManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(built.resultManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(built.baseManifestHash).not.toBe(built.resultManifestHash);
    expect(built.patch.baseManifestHash).toBe(built.baseManifestHash);
    expect(built.patch.resultManifestHash).toBe(built.resultManifestHash);
  });

  it("throws (fail-closed) on a no-op diff (identical trees → no operations)", () => {
    const base = manifest([{ path: "a.txt", content: "same" }]);
    const result = manifest([{ path: "a.txt", content: "same" }]);
    expect(() => buildWorkspacePatch(ctx(base, result))).toThrow(WorkspacePatchError);
  });
});
