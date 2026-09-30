import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { type WorkspaceManifestV1, type WorkspacePatchManifestV1 } from "@armyofagents/worker-protocol";

import { FenceCloseProxy } from "../../lease/fence-close-proxy.js";
import { FenceClosedError } from "../../lease/fence-close-proxy.js";
import type { EffectFence } from "../../supervisor/effect-authority.js";
import type { EventDeliveryIdentity, WorkerEventSink } from "../../supervisor/events.js";
import { createResultCommitter, type ArtifactCommitOutcome } from "../result-commit.js";
import type { BuildWorkspacePatchInput } from "../build-patch.js";

// -----------------------------------------------------------------------------
// CLI-003/D4 — the fenced, idempotent result commit. It builds a
// `WorkspacePatchManifestV1` via `buildWorkspacePatch` (the DAT-003 producer's first
// worker-daemon consumer) and commits it THROUGH the FenceCloseProxy worker gate —
// so a lost lease denies locally (FenceClosedError) BEFORE the round-trip. Idempotency
// keys on the ARTIFACT IDENTITY (never the non-unique versionNumber): a re-delivered
// commit is a no-op returning the recorded outcome.
// -----------------------------------------------------------------------------

const sha256 = (bytes: Buffer | Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

const ORG = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const ARTIFACT = "44444444-4444-4444-8444-444444444444";

function manifest(specs: Array<{ path: string; content: string }>): WorkspaceManifestV1 {
  const entries = specs
    .map((s) => {
      const bytes = Buffer.from(s.content, "utf8");
      return {
        path: s.path,
        kind: "file" as const,
        provenance: "untracked" as const,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
        executable: false,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
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

function patchInput(): BuildWorkspacePatchInput {
  return {
    base: manifest([{ path: "src/a.ts", content: "old" }]),
    result: manifest([
      { path: "src/a.ts", content: "new" },
      { path: "src/b.ts", content: "added" },
    ]),
    organizationId: ORG,
    companyId: COMPANY,
    jobId: JOB,
    attempt: 1,
    artifactId: ARTIFACT,
    sha256,
  };
}

const FENCE: EffectFence = {
  jobId: JOB,
  attempt: 1,
  leaseId: "66666666-6666-4666-8666-666666666666",
  fenceToken: "f".repeat(40),
  deviceGeneration: 1,
  observedSeq: 0,
};

function identity(): EventDeliveryIdentity {
  return {
    organizationId: ORG,
    companyId: COMPANY,
    workerId: "77777777-7777-4777-8777-777777777777",
    jobId: JOB,
    attempt: 1,
    leaseId: FENCE.leaseId,
    fenceToken: FENCE.fenceToken,
  };
}

function proxy(): FenceCloseProxy {
  const sink: WorkerEventSink = { emit() {} };
  return new FenceCloseProxy({ fence: FENCE, identity: identity(), eventSink: sink, redactionCanaries: [] });
}

describe("CLI-003/D4 — fenced idempotent result commit", () => {
  it("builds the patch and commits it once through the fence gate", async () => {
    const calls: WorkspacePatchManifestV1[] = [];
    const commitVia = async (patch: WorkspacePatchManifestV1): Promise<ArtifactCommitOutcome> => {
      calls.push(patch);
      return { committed: true, artifactId: patch.artifactId, versionNumber: 1 };
    };
    const committer = createResultCommitter();
    const outcome = await committer.commit({ proxy: proxy(), patchInput: patchInput(), commitVia });

    expect(outcome).toEqual({ committed: true, artifactId: ARTIFACT, versionNumber: 1 });
    expect(calls).toHaveLength(1);
    // The committed patch is the real DAT-003 diff (a modify + a create).
    expect(calls[0]!.operations.map((o) => o.op).sort()).toEqual(["create", "modify"]);
    expect(calls[0]!.artifactId).toBe(ARTIFACT);
  });

  it("§2.3 output cannot commit after lease loss — denied locally BEFORE the round-trip", async () => {
    let roundTrips = 0;
    const commitVia = async (): Promise<ArtifactCommitOutcome> => {
      roundTrips += 1;
      return { committed: true, artifactId: ARTIFACT };
    };
    const p = proxy();
    p.close("lease_lost");
    const committer = createResultCommitter();
    await expect(committer.commit({ proxy: p, patchInput: patchInput(), commitVia })).rejects.toBeInstanceOf(FenceClosedError);
    // The commit was denied at the worker gate — nothing crossed the wire.
    expect(roundTrips).toBe(0);
  });

  it("§2.2 duplicate result delivery is harmless — a re-commit of the same artifact is a no-op", async () => {
    let roundTrips = 0;
    const commitVia = async (patch: WorkspacePatchManifestV1): Promise<ArtifactCommitOutcome> => {
      roundTrips += 1;
      // The server assigns a DIFFERENT versionNumber on each call — proving the
      // idempotency key is the artifact identity, not the versionNumber.
      return { committed: true, artifactId: patch.artifactId, versionNumber: roundTrips };
    };
    const committer = createResultCommitter();
    const first = await committer.commit({ proxy: proxy(), patchInput: patchInput(), commitVia });
    const second = await committer.commit({ proxy: proxy(), patchInput: patchInput(), commitVia });
    expect(roundTrips).toBe(1);
    expect(second).toEqual(first);
    expect(second.versionNumber).toBe(1);
  });

  it("§2.2 CONCURRENT duplicate deliveries of the same artifact share ONE round-trip", async () => {
    let roundTrips = 0;
    const commitVia = async (patch: WorkspacePatchManifestV1): Promise<ArtifactCommitOutcome> => {
      roundTrips += 1;
      // Yield the event loop so both concurrent commits are in-flight before either
      // records its outcome — the check-then-act window the in-flight sentinel closes.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { committed: true, artifactId: patch.artifactId, versionNumber: roundTrips };
    };
    const committer = createResultCommitter();
    const [a, b] = await Promise.all([
      committer.commit({ proxy: proxy(), patchInput: patchInput(), commitVia }),
      committer.commit({ proxy: proxy(), patchInput: patchInput(), commitVia }),
    ]);
    expect(roundTrips).toBe(1);
    expect(a).toEqual(b);
  });

  it("a post-close duplicate of an already-committed artifact stays a no-op (no throw)", async () => {
    const commitVia = async (patch: WorkspacePatchManifestV1): Promise<ArtifactCommitOutcome> => ({
      committed: true,
      artifactId: patch.artifactId,
      versionNumber: 1,
    });
    const committer = createResultCommitter();
    await committer.commit({ proxy: proxy(), patchInput: patchInput(), commitVia });
    const closed = proxy();
    closed.close("completed");
    // Already recorded → returns the stored outcome without touching the (closed) gate.
    const again = await committer.commit({ proxy: closed, patchInput: patchInput(), commitVia });
    expect(again.versionNumber).toBe(1);
  });
});
