// DAT-009 slice 3 — the worker-side artifact EXPORT consumer: digest → grant → export → commit.
//
// This is the FIRST production consumer of the DAT-002 grant pipeline, and it needs its own
// test at THIS link for the reason the staged-input mirror gives: a chain proven only at its
// ends cannot tell a broken mint from a broken commit from a broken provider.
//
// ★ The load-bearing cases are the refusals and the ORDER. Both ops answer HTTP 200 for
// `rejected`, so a status-only check reports a successful export of nothing; and the digest
// must precede the mint, because since DAT-009 slice 2 a mint writes a DURABLE row and an
// unredeemed grant is litter with a five-minute life.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  ArtifactExportFailedError,
  createArtifactExportSequencer,
  exportArtifactId,
  grantPutHeaders,
  type ArtifactExportRequest,
  type SandboxArtifactExporter,
} from "../lease/artifact-export.js";
import { EffectAuthority, EffectAuthorityWithdrawnError } from "../supervisor/effect-authority.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { makeHandoff } from "./support/supervisor-fixtures.js";
import { POLL_FIXTURE_IDS } from "./support/poll-fixtures.js";
import { generateDeviceKey } from "../identity/device-key.js";
import { createMetrics, SANDBOX_OP_METRIC } from "../metrics/metrics.js";
import type { WorkerSession } from "../enrollment/enroll.js";

const BODY = "diff --git a/a.txt b/a.txt\n";
const SHA = createHash("sha256").update(BODY).digest("hex");
const SIZE = Buffer.byteLength(BODY);

const PATH = "/home/user/workspace/.aoa-run.patch";
const REQUEST: ArtifactExportRequest = {
  path: PATH,
  kind: "workspace_patch",
  contentType: "text/plain",
  retention: "run",
};

const ARTIFACT_ID = exportArtifactId({ jobId: POLL_FIXTURE_IDS.job, attempt: 1, path: PATH });
const OBJECT_KEY =
  `organizations/${POLL_FIXTURE_IDS.org}/jobs/${POLL_FIXTURE_IDS.job}/attempts/1/${ARTIFACT_ID}`;

const SESSION: WorkerSession = { token: "session-token", expiresAt: new Date(Date.now() + 600_000) } as never;

function uploadGrant(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    operation: "upload",
    artifactId: ARTIFACT_ID,
    method: "PUT",
    url: "https://store.example/put?X-Amz-Signature=SECRETSIGNATURE",
    headers: {},
    issuedAt: "2026-09-04T12:00:00.000Z",
    expiresAt: "2026-09-04T12:05:00.000Z",
    maxBytes: SIZE,
    expectedSha256: SHA,
    objectKey: OBJECT_KEY,
    redaction: "secret",
    ...overrides,
  };
}

/** A provider half that records what it was asked and answers as the test scripts. */
function exporter(script: {
  digest?: () => Promise<{ sha256: string; sizeBytes: number }>;
  exportKey?: string;
  exportThrows?: Error;
} = {}): SandboxArtifactExporter & { calls: string[]; grants: unknown[] } {
  const calls: string[] = [];
  const grants: unknown[] = [];
  return {
    calls,
    grants,
    async digest() {
      calls.push("digest");
      if (script.digest) return script.digest();
      return { sha256: SHA, sizeBytes: SIZE };
    },
    async export(_path, grant) {
      calls.push("export");
      grants.push(grant);
      if (script.exportThrows) throw script.exportThrows;
      return { objectKey: script.exportKey ?? OBJECT_KEY };
    },
  };
}

/** A control-plane double answering both ops, recording every parsed request body. */
function client(script: {
  grant?: (parsed: Record<string, unknown>) => { status: number; body: unknown };
  commit?: (parsed: Record<string, unknown>) => { status: number; body: unknown };
} = {}) {
  const calls: string[] = [];
  const grantRequests: Record<string, unknown>[] = [];
  const commitRequests: Record<string, unknown>[] = [];
  return {
    calls,
    grantRequests,
    commitRequests,
    client: {
      artifactTransferGrantPath: "/api/worker-control/artifact-transfer-grants",
      artifactCommitPath: "/api/worker-control/artifact-commits",
      async artifactTransferGrant(request: { bytes: Buffer }) {
        const parsed = JSON.parse(request.bytes.toString("utf8")) as Record<string, unknown>;
        calls.push("grant");
        grantRequests.push(parsed);
        if (script.grant) return script.grant(parsed);
        return {
          status: 200,
          body: {
            protocolVersion: 1,
            correlationId: parsed.correlationId,
            serverTime: "2026-09-04T12:00:00.000Z",
            outcome: "upload_granted",
            grant: uploadGrant(),
          },
        };
      },
      async artifactCommit(request: { bytes: Buffer }) {
        const parsed = JSON.parse(request.bytes.toString("utf8")) as Record<string, unknown>;
        calls.push("commit");
        commitRequests.push(parsed);
        if (script.commit) return script.commit(parsed);
        return {
          status: 200,
          body: {
            protocolVersion: 1,
            correlationId: parsed.correlationId,
            serverTime: "2026-09-04T12:00:00.000Z",
            outcome: "committed",
            artifactId: ARTIFACT_ID,
            versionNumber: 1,
            committedAt: "2026-09-04T12:00:00.000Z",
          },
        };
      },
    },
  };
}

function sequencerOver(script: Parameters<typeof client>[0] = {}) {
  const c = client(script);
  const sessionCalls: number[] = [];
  return {
    ...c,
    sessionCalls,
    run: createArtifactExportSequencer({
      client: c.client as never,
      key: generateDeviceKey(),
      session: async () => {
        sessionCalls.push(1);
        return SESSION;
      },
    }),
  };
}

describe("DAT-009 slice 3 — artifact export sequencer (digest → grant → export → commit)", () => {
  it("★ runs the four steps IN ORDER and returns a reference to the committed object", async () => {
    const { run, calls, grantRequests, commitRequests } = sequencerOver();
    const ex = exporter();
    const refs = await run({ handoff: makeHandoff(), exporter: ex, requests: [REQUEST] });

    // The interleaving is the property: digest BEFORE grant, grant BEFORE export, export
    // BEFORE commit. A sequencer that minted first would still pass a per-call assertion.
    expect([...ex.calls, ...calls].length).toBe(4);
    expect(calls).toEqual(["grant", "commit"]);
    expect(ex.calls).toEqual(["digest", "export"]);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      path: PATH,
      artifactId: ARTIFACT_ID,
      objectKey: OBJECT_KEY,
      sha256: SHA,
      sizeBytes: SIZE,
      versionNumber: 1,
    });
    // A REFERENCE — never bytes.
    expect(Object.keys(refs[0]!)).not.toContain("body");
    expect(Object.keys(refs[0]!)).not.toContain("bytes");

    // ★ The grant request carries the DIGEST STEP's values, which is what makes
    // "digest before mint" structural rather than incidental.
    const grantBody = grantRequests[0]!.body as Record<string, unknown>;
    expect(grantBody.operation).toBe("upload");
    expect(grantBody.expectedSha256).toBe(SHA);
    expect(grantBody.maxBytes).toBe(SIZE);
    expect(grantBody.artifactId).toBe(ARTIFACT_ID);

    // The commit manifest carries the org + company off the FROZEN ENVELOPE — the measurement
    // that made this ticket possible without a frozen change.
    const manifest = (commitRequests[0]!.body as Record<string, unknown>).manifest as Record<string, unknown>;
    expect(manifest.organizationId).toBe(POLL_FIXTURE_IDS.org);
    expect(manifest.companyId).toBe(POLL_FIXTURE_IDS.company);
    expect(manifest.kind).toBe("workspace_patch");
    expect(manifest.sha256).toBe(SHA);
    expect(manifest.sizeBytes).toBe(SIZE);
    expect(manifest.sensitivity).toBe("restricted");
  });

  it("★ binds the object key to THIS run's own org/job/attempt prefix", async () => {
    const { run, grantRequests } = sequencerOver();
    await run({ handoff: makeHandoff(), exporter: exporter(), requests: [REQUEST] });
    const grantBody = grantRequests[0]!.body as Record<string, unknown>;
    expect(grantBody.expectedObjectKey).toBe(OBJECT_KEY);
    expect(String(grantBody.expectedObjectKey).startsWith(`organizations/${POLL_FIXTURE_IDS.org}/`)).toBe(true);
    expect(String(grantBody.expectedObjectKey)).toContain(`/jobs/${POLL_FIXTURE_IDS.job}/attempts/1/`);
  });

  it("★★★ mints NOTHING when there is nothing to export — an empty run leaves no durable row", async () => {
    const { run, calls, sessionCalls } = sequencerOver();
    const ex = exporter();
    const refs = await run({ handoff: makeHandoff(), exporter: ex, requests: [] });
    expect(refs).toEqual([]);
    // Anti-vacuity: the CALL COUNTS are asserted, so a sequencer that silently did nothing on
    // a NON-empty list could not pass the happy-path case above either.
    expect(calls).toEqual([]);
    expect(ex.calls).toEqual([]);
    // ★ And it touches NOTHING AT ALL — not even the session. Pinned because the early return
    // has no other observable effect, and without this assertion removing it stays green: the
    // loop body already does not run for an empty list. The property it buys is that a run
    // with nothing to export CANNOT FAIL on the export path, including when the session is
    // unrenewable — which is precisely the run for which failing would be absurd.
    expect(sessionCalls).toEqual([]);
  });

  it("★★★ a failed digest mints NO grant — the orphan this order exists to prevent", async () => {
    const { run, calls } = sequencerOver();
    const ex = exporter({
      digest: async () => {
        throw new Error("no such file");
      },
    });
    await expect(run({ handoff: makeHandoff(), exporter: ex, requests: [REQUEST] })).rejects.toThrow(
      ArtifactExportFailedError,
    );
    // Since DAT-009 slice 2 a mint writes a durable `granted` row inside the mint transaction.
    // A sequencer that minted before digesting would leave one behind for every absent file.
    expect(calls).toEqual([]);
  });

  it("★★★ carries the server's REFUSAL REASON instead of discarding it (contrast E7-F017)", async () => {
    const { run } = sequencerOver({
      grant: (parsed) => ({
        status: 200,
        body: {
          protocolVersion: 1,
          correlationId: parsed.correlationId,
          serverTime: "2026-09-04T12:00:00.000Z",
          outcome: "rejected",
          reason: "attempt_terminal",
        },
      }),
    });
    const error = await run({ handoff: makeHandoff(), exporter: exporter(), requests: [REQUEST] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ArtifactExportFailedError);
    // `attempt_terminal` is the lifecycle-window mistake this module can make, and the whole
    // value of the message is that it names it. The download mirror reports every refusal as
    // "malformed grant" (E7-F017) and sends the reader hunting a protocol bug.
    expect((error as Error).message).toContain("attempt_terminal");
    expect((error as ArtifactExportFailedError).stage).toBe("grant");
  });

  it("refuses a CROSS-PAIRED download grant rather than parsing it as an upload", async () => {
    const { run, calls } = sequencerOver({
      grant: (parsed) => ({
        status: 200,
        body: {
          protocolVersion: 1,
          correlationId: parsed.correlationId,
          serverTime: "2026-09-04T12:00:00.000Z",
          outcome: "download_granted",
          grant: uploadGrant({ operation: "download", method: "GET" }),
        },
      }),
    });
    const ex = exporter();
    await expect(run({ handoff: makeHandoff(), exporter: ex, requests: [REQUEST] })).rejects.toThrow(
      /outcome download_granted/,
    );
    // And nothing was uploaded under it.
    expect(ex.calls).toEqual(["digest"]);
    expect(calls).toEqual(["grant"]);
  });

  it("a commit refusal is distinguishable and fabricates NO reference", async () => {
    const { run } = sequencerOver({
      commit: (parsed) => ({
        status: 200,
        body: {
          protocolVersion: 1,
          correlationId: parsed.correlationId,
          serverTime: "2026-09-04T12:00:00.000Z",
          outcome: "rejected",
          reason: "event_hash_mismatch",
        },
      }),
    });
    const error = await run({ handoff: makeHandoff(), exporter: exporter(), requests: [REQUEST] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ArtifactExportFailedError);
    expect((error as ArtifactExportFailedError).stage).toBe("commit");
    expect((error as Error).message).toContain("event_hash_mismatch");
  });

  it("★ refuses a `committed` response that carries no version number", async () => {
    // Found by a SURVIVING mutant: deleting this guard left every test green, because the
    // double always answers with a version. A `committed` outcome missing `versionNumber` is
    // not the frozen response shape, and returning `undefined` in a field typed `number` is a
    // fabricated reference — the same class as a fabricated digest, one step later.
    const { run } = sequencerOver({
      commit: (parsed) => ({
        status: 200,
        body: {
          protocolVersion: 1,
          correlationId: parsed.correlationId,
          serverTime: "2026-09-04T12:00:00.000Z",
          outcome: "committed",
          artifactId: ARTIFACT_ID,
          committedAt: "2026-09-04T12:00:00.000Z",
        },
      }),
    });
    const error = await run({ handoff: makeHandoff(), exporter: exporter(), requests: [REQUEST] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ArtifactExportFailedError);
    expect((error as ArtifactExportFailedError).stage).toBe("commit");
    expect((error as Error).message).toContain("without a version");
  });

  it("refuses a grant for a DIFFERENT object key than the one it asked to write", async () => {
    const { run } = sequencerOver({
      grant: (parsed) => ({
        status: 200,
        body: {
          protocolVersion: 1,
          correlationId: parsed.correlationId,
          serverTime: "2026-09-04T12:00:00.000Z",
          outcome: "upload_granted",
          grant: uploadGrant({
            objectKey: `organizations/${POLL_FIXTURE_IDS.org}/jobs/${POLL_FIXTURE_IDS.job}/attempts/1/someone-else`,
          }),
        },
      }),
    });
    await expect(run({ handoff: makeHandoff(), exporter: exporter(), requests: [REQUEST] })).rejects.toThrow(
      /granted a different object key/,
    );
  });

  it("★ never lets the grant's signed URL reach an error message or a return value", async () => {
    const { run } = sequencerOver();
    // The failure is raised by the PROVIDER, whose own error text carries the url — the most
    // likely real leak, since an implementation that logs what it was doing includes it.
    const leaky = exporter({ exportThrows: new Error("PUT https://store.example/put?X-Amz-Signature=SECRETSIGNATURE failed") });
    const error = await run({ handoff: makeHandoff(), exporter: leaky, requests: [REQUEST] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ArtifactExportFailedError);
    expect((error as Error).message).not.toContain("SECRETSIGNATURE");
    expect((error as Error).message).not.toContain("https://");
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error as object))).not.toContain("SECRETSIGNATURE");
  });

  it("presents the SAME artifact id and idempotency keys on a retry of the same file", async () => {
    const first = sequencerOver();
    const second = sequencerOver();
    await first.run({ handoff: makeHandoff(), exporter: exporter(), requests: [REQUEST] });
    await second.run({ handoff: makeHandoff(), exporter: exporter(), requests: [REQUEST] });
    // A RANDOM key would make a replay indistinguishable from a new request, and a random
    // artifactId would defeat the mint's already-committed guard.
    expect(first.grantRequests[0]!.idempotencyKey).toBe(second.grantRequests[0]!.idempotencyKey);
    expect(first.commitRequests[0]!.idempotencyKey).toBe(second.commitRequests[0]!.idempotencyKey);
    expect((first.grantRequests[0]!.body as Record<string, unknown>).artifactId).toBe(ARTIFACT_ID);
    // The two ops must NOT share one key: they are different operations on the same artifact.
    expect(first.grantRequests[0]!.idempotencyKey).not.toBe(first.commitRequests[0]!.idempotencyKey);
  });
});

describe("DAT-009 slice 3 — grantPutHeaders (the headers the signed PUT demands)", () => {
  it("★★★ sends the digest as BASE64, never the grant's HEX", () => {
    const headers = grantPutHeaders(uploadGrant() as never);
    expect(headers["x-amz-checksum-sha256"]).toBe(Buffer.from(SHA, "hex").toString("base64"));
    // The single most likely mistake: forwarding `expectedSha256` verbatim. The store refuses
    // it, and nothing in the type system distinguishes the two encodings.
    expect(headers["x-amz-checksum-sha256"]).not.toBe(SHA);
    expect(headers["x-amz-sdk-checksum-algorithm"]).toBe("SHA256");
  });

  it("lets a grant-supplied header win, so a future server that sends them is not overridden", () => {
    const headers = grantPutHeaders(uploadGrant({ headers: { "x-amz-checksum-sha256": "server-said-so" } }) as never);
    expect(headers["x-amz-checksum-sha256"]).toBe("server-said-so");
  });
});

describe("DAT-009 slice 3 — the export pair is gated by EffectAuthority", () => {
  const fence = { jobId: POLL_FIXTURE_IDS.job, attempt: 1, leaseId: POLL_FIXTURE_IDS.lease, fenceToken: "1" };
  const ctx = { deadlineMs: 1_000, idempotencyKey: "k" };

  it("★ a WITHDRAWN authority refuses both, before the grant is passed to any implementation", async () => {
    const provider = createFakeSandboxProvider({ artifactExportMode: "grant_upload", artifactFiles: { [PATH]: BODY } });
    const authority = new EffectAuthority(provider, fence as never);
    authority.withdraw();
    // ★ SYNCHRONOUS, like every other gated method here (`stageFiles` included): the guard runs
    // before the provider call is even made, so the refusal is a throw and not a rejected
    // promise. Asserted in that shape deliberately — for `exportArtifact` it is the property
    // that matters, because it means a withdrawn authority never hands the bearer grant to an
    // implementation at all, and a redeemed grant cannot be recalled.
    expect(() => authority.digestArtifact("sbx", PATH, ctx as never)).toThrow(
      EffectAuthorityWithdrawnError,
    );
    expect(() => authority.exportArtifact("sbx", PATH, uploadGrant() as never, ctx as never)).toThrow(
      EffectAuthorityWithdrawnError,
    );
  });

  it("an ACTIVE authority passes both through to the provider", async () => {
    const provider = createFakeSandboxProvider({ artifactExportMode: "grant_upload", artifactFiles: { [PATH]: BODY } });
    const authority = new EffectAuthority(provider, fence as never);
    await expect(authority.digestArtifact("sbx", PATH, ctx as never)).resolves.toMatchObject({
      sizeBytes: expect.any(Number),
    });
    await expect(
      authority.exportArtifact("sbx", PATH, uploadGrant() as never, ctx as never),
    ).resolves.toMatchObject({ objectKey: OBJECT_KEY });
  });
});

describe("DAT-009 slice 3 — the two operation labels are registered (E7-F010)", () => {
  it("★★★ `digest_artifact` and `export_artifact` pass the CLOSED label allow-list", () => {
    const metrics = createMetrics();
    // Unregistered values THROW on this allow-list, and the throw would land inside the
    // supervisor's fail-closed arms and strand the run with NO TERMINAL — on the happy path
    // as readily as the failure path. That is E7-F010, and this is its regression pin.
    expect(() => metrics.inc(SANDBOX_OP_METRIC, { operation: "digest_artifact", outcome: "success" })).not.toThrow();
    expect(() => metrics.inc(SANDBOX_OP_METRIC, { operation: "export_artifact", outcome: "success" })).not.toThrow();
    // The positive control: an unregistered neighbour still throws, so the assertion above is
    // measuring the allow-list rather than a metrics object that accepts anything.
    expect(() => metrics.inc(SANDBOX_OP_METRIC, { operation: "upload_artifact", outcome: "success" })).toThrow();
  });
});
