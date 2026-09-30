/**
 * DAT-003 adversarial-review regression tests (producer).
 *
 *   #5 — a metadata-only change (executable bit) has NO representable file
 *        operation in the frozen patch schema, so the producer must fail closed
 *        with an ACCURATE diagnostic (not a misleading "no differences").
 *   #8 — bind the committed vectors fixture to the REAL producer: buildWorkspacePatch
 *        run over each fixture diff vector must reproduce the fixture's expected
 *        operations, so the independent `.mjs` re-derivation and the real producer
 *        cannot silently diverge.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { WorkspaceManifestV1 } from "@armyofagents/worker-protocol";

import { buildWorkspacePatch } from "../build-patch.js";
import { WorkspacePatchError } from "../errors.js";

const sha256 = (v: string): string => createHash("sha256").update(v).digest("hex");
const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const ARTIFACT = "44444444-4444-4444-8444-444444444444";

const BASE = {
  kind: "content_manifest" as const,
  algorithm: "sha256" as const,
  revision: "e".repeat(64),
  dirty: false,
  caseMode: "sensitive" as const,
  ignorePolicy: { kind: "explicit" as const, digest: "f".repeat(64) },
  inclusion: { tracked: true as const, untracked: "include" as const, ignored: false as const },
};

interface EntrySpec { path: string; kind?: "file" | "directory"; sha256?: string; sizeBytes?: number; executable?: boolean }

function manifest(entries: EntrySpec[]): WorkspaceManifestV1 {
  const built = entries.map((e) => {
    if ((e.kind ?? "file") === "directory") {
      return { path: e.path, kind: "directory" as const, provenance: "untracked" as const, sizeBytes: 0, sha256: null, executable: false };
    }
    return {
      path: e.path, kind: "file" as const, provenance: "untracked" as const,
      sizeBytes: e.sizeBytes ?? 1, sha256: e.sha256!, executable: e.executable ?? false,
    };
  });
  built.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    protocolVersion: 1, organizationId: ORG, companyId: COMPANY, artifactId: ARTIFACT,
    base: BASE,
    snapshotProvenance: { capturedAt: "2026-08-15T00:00:00.000Z", sourceTargetId: "55555555-5555-4555-8555-555555555555", folderGrantId: null, captureToolVersion: "test" },
    entries: built,
  };
}

const input = (base: WorkspaceManifestV1, result: WorkspaceManifestV1) => ({
  base, result, organizationId: ORG, companyId: COMPANY, jobId: JOB, attempt: 1, artifactId: ARTIFACT, sha256,
});

describe("DAT-003 review — producer regressions", () => {
  // Finding #5: an executable-bit-only change → accurate metadata diagnostic.
  it("fails closed with an accurate diagnostic when the only change is a metadata (exec bit) flip", () => {
    const h = sha256("run.sh-content");
    const base = manifest([{ path: "run.sh", sha256: h, executable: false }]);
    const result = manifest([{ path: "run.sh", sha256: h, executable: true }]);
    expect(() => buildWorkspacePatch(input(base, result))).toThrow(WorkspacePatchError);
    expect(() => buildWorkspacePatch(input(base, result))).toThrow(/metadata not representable/i);
  });

  // Finding #8: the committed fixture must agree with the REAL producer.
  it("reproduces every committed fixture diff vector via the real buildWorkspacePatch", () => {
    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../tests/fixtures/workspace-patch/v1/vectors.json",
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      diffVectors: Array<{ name: string; base: EntrySpec[]; result: EntrySpec[]; operations: Array<Record<string, unknown>> }>;
    };
    // Map each symbolic fixture sha token → a real 64-hex hash, consistently across
    // base/result/expected-ops.
    const realSha = (token: string): string => sha256(`fixture:${token}`);
    const mapEntries = (specs: EntrySpec[]): EntrySpec[] =>
      specs.map((s) => ((s.kind ?? "file") === "directory" ? s : { ...s, sha256: realSha(String(s.sha256)) }));
    const mapOp = (op: Record<string, unknown>): Record<string, unknown> =>
      "resultSha256" in op ? { ...op, resultSha256: realSha(String(op.resultSha256)) } : op;

    expect(fixture.diffVectors.length).toBeGreaterThan(0);
    for (const vector of fixture.diffVectors) {
      const base = manifest(mapEntries(vector.base));
      const result = manifest(mapEntries(vector.result));
      const { patch } = buildWorkspacePatch(input(base, result));
      // The producer sorts by destination path; compare as sets of plain ops.
      const produced = patch.operations.map((op) => ({ ...op }));
      const expected = vector.operations.map(mapOp);
      const key = (o: Record<string, unknown>) => JSON.stringify(o, Object.keys(o).sort());
      expect(new Set(produced.map(key))).toEqual(new Set(expected.map(key)));
    }
  });
});
