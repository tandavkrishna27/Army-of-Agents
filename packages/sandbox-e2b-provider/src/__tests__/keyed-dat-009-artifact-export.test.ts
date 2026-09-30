import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

// -----------------------------------------------------------------------------
// DAT-009 — THE KEYED LANE FOR THE ARTIFACT EXPORT, AGAINST A REAL E2B SANDBOX.
//
// WHY THIS FILE EXISTS. `E2bSandboxProvider` declared `artifactExportMode = "none"`
// and declined both operations, honestly, with `#transport.readFile` sitting one
// line away and uncalled (`CLI-008-unit-f-design.md` §1.6, link 2). This branch
// implements the pair. Everything about it was argued from `real-transport.ts`
// until this lane ran — and this programme's repeated and expensive lesson is that
// argued-not-observed is exactly where the defects live.
//
// ★ WHAT IS DIFFERENT FROM THE UNIT D LANE, AND WHY IT MATTERS. Unit D's lane
// stages bytes INTO a sandbox and reads them back. Here the bytes are produced BY
// THE SANDBOX — a real `sh -c` command writes the file — and the provider then
// digests and exports what it finds. Reading back something you just wrote proves
// the transport round-trips; digesting something the sandbox itself produced is
// the actual export case, and it is the one nothing had ever run.
//
// ★★ THE PAYLOAD IS BINARY ON PURPOSE. It is all 256 byte values, delivered into
// the sandbox by `base64 -d` and read back through `files.read({format:"bytes"})`.
// A text-mode read, a UTF-8 round trip, or any newline translation anywhere in the
// e2b path would change the digest — and a digest that quietly disagrees with the
// bytes is precisely the failure that would surface far away, at the fenced
// commit's `headObject` re-verification, with nothing left to point at.
//
// ★★★ WHAT THIS LANE DOES **NOT** PROVE, stated so nobody infers it.
//   * It does not perform a real HTTPS PUT. The uploader is injected, so the store
//     half is not exercised here — that half is already live-proven against real
//     MinIO by DAT-002 (`d1-merge-train` run 31885553697, 13/13 green): grant →
//     real presigned PUT → `committed` + a persisted `job_artifacts` row, and a
//     truncated PUT rejected fail-closed with no row. The `x-amz-checksum-sha256`
//     header the default uploader sends is pinned deterministically in the no-key
//     suite (`artifact-export.test.ts`).
//   * It does not put a `job_artifacts` row on any run, and it moves NO capability
//     counter. Nothing in production calls `exportArtifact` — the worker-side
//     sequencer is DAT-009 slice 3, unbuilt — and `countProducedOutputs` filters
//     `kind = 'workspace_patch'` besides.
//
// LANE. E2B / desktop only. E7-F011: the networked/container lane's driver declares
// `artifactExportMode = "none"` and is untouched by this branch.
//
// Runs ONLY with `E2B_API_KEY` present (operator-supplied, via the keyed workflow's
// repo secret); otherwise SKIPS cleanly — never faked.
// -----------------------------------------------------------------------------

import { E2bSandboxProvider } from "../e2b-provider.js";
import type { E2bTransport } from "../transport.js";
import { SandboxNotFoundError } from "../errors.js";
import type { ArtifactUploadGrantV1 } from "@armyofagents/worker-protocol";

const HAS_KEY = typeof process.env.E2B_API_KEY === "string" && process.env.E2B_API_KEY.length > 0;
const describeKeyed = HAS_KEY ? describe : describe.skip;
const TEMPLATE = process.env.E2B_TEMPLATE && process.env.E2B_TEMPLATE.length > 0 ? process.env.E2B_TEMPLATE : "base";

const CTX = { deadlineMs: 60_000, idempotencyKey: "keyed-dat-009" };
const OUT_PATH = "/home/user/aoa-dat-009-out.bin";
const OBJECT_KEY = "organizations/org_keyed/jobs/job_keyed/attempts/1/out.bin";

const LABELS = {
  organizationId: "org_keyed",
  companyId: "co_keyed",
  jobId: "job_keyed",
  attempt: 1,
  leaseId: "lease_keyed",
  workerId: "worker_keyed",
  targetId: "target_keyed",
  deviceGeneration: 1,
};

/** Every byte value 0x00..0xff, twice, so a truncation is visible as well as a mangling. */
const PAYLOAD = new Uint8Array(512);
for (let i = 0; i < PAYLOAD.length; i += 1) PAYLOAD[i] = i % 256;
const PAYLOAD_B64 = Buffer.from(PAYLOAD).toString("base64");
const PAYLOAD_SHA256 = createHash("sha256").update(PAYLOAD).digest("hex");

function grant(expectedSha256: string, maxBytes: number): ArtifactUploadGrantV1 {
  return {
    protocolVersion: 1,
    operation: "upload",
    artifactId: "00000000-0000-4000-8000-0000000000c1",
    method: "PUT",
    url: "https://store.example/keyed-put?sig=keyed",
    headers: {},
    issuedAt: "2026-09-04T12:00:00.000Z",
    expiresAt: "2026-09-04T12:30:00.000Z",
    maxBytes,
    expectedSha256,
    objectKey: OBJECT_KEY,
    redaction: "secret",
  } as ArtifactUploadGrantV1;
}

function recordingUploader() {
  const puts: { objectKey: string; bytes: Uint8Array }[] = [];
  return {
    puts,
    upload: async (g: ArtifactUploadGrantV1, bytes: Uint8Array): Promise<void> => {
      puts.push({ objectKey: g.objectKey, bytes: Uint8Array.from(bytes) });
    },
  };
}

async function realTransport(): Promise<E2bTransport> {
  // Dynamic so the no-key run neither loads the `e2b` SDK nor requires a key.
  const { RealE2bTransport } = await import("../real-transport.js");
  return new RealE2bTransport({});
}

/**
 * A provider over a REAL sandbox, with teardown guaranteed so a failed assertion
 * never leaks one.
 */
async function withProvider(
  fn: (p: E2bSandboxProvider, sandboxId: string, store: ReturnType<typeof recordingUploader>, t: E2bTransport) => Promise<void>,
): Promise<void> {
  const transport = await realTransport();
  const store = recordingUploader();
  const provider = new E2bSandboxProvider({
    transport,
    templateId: TEMPLATE,
    performUploadGrant: store.upload,
  });
  const created = await provider.create(
    { resourceLabels: LABELS, command: "sh", args: ["-c", "true"], env: {}, workloadType: "batch" },
    CTX,
  );
  try {
    await fn(provider, created.sandboxId, store, transport);
  } finally {
    await transport.terminate(created.sandboxId).catch(() => undefined);
  }
}

/** Have the SANDBOX itself produce the file, from a base64 payload it decodes. */
async function produceInSandbox(t: E2bTransport, sandboxId: string, b64: string, path: string): Promise<void> {
  const r = await t.runCommand({
    sandboxId,
    command: "sh",
    args: ["-c", `printf '%s' '${b64}' | base64 -d > ${path}`],
    envVars: {},
    timeoutMs: 60_000,
  });
  expect(r.exitCode).toBe(0);
}

describeKeyed("DAT-009 — artifact digest + export, executed against a REAL E2B sandbox", () => {
  it(
    "digests a file the SANDBOX produced, and exports its bytes byte-identically",
    async () => {
      await withProvider(async (provider, sandboxId, store, t) => {
        await produceInSandbox(t, sandboxId, PAYLOAD_B64, OUT_PATH);

        // 1. The digest is of what is actually in the sandbox — computed by reading it,
        //    not by trusting what we asked the sandbox to write.
        const digest = await provider.digestArtifact(sandboxId, OUT_PATH, CTX);
        expect(digest.sizeBytes).toBe(PAYLOAD.byteLength);
        expect(digest.sha256).toBe(PAYLOAD_SHA256);
        // Metadata only: the no-bytes property of the port, asserted on the real driver.
        expect(Object.keys(digest).sort()).toEqual(["sha256", "sizeBytes"]);

        // 2. The grant is minted FROM that digest, which is the only reason the two
        //    operations are separate: the frozen grant request requires both fields.
        const g = grant(digest.sha256, digest.sizeBytes);
        const result = await provider.exportArtifact(sandboxId, OUT_PATH, g, CTX);

        // 3. A REFERENCE comes back — never bytes.
        expect(Object.keys(result)).toEqual(["objectKey"]);
        expect(result.objectKey).toBe(OBJECT_KEY);

        // 4. And the bytes that reached the store are the sandbox's, unmangled. All 256
        //    byte values survived e2b's read path.
        expect(store.puts).toHaveLength(1);
        expect(Buffer.from(store.puts[0]!.bytes).equals(Buffer.from(PAYLOAD))).toBe(true);
      });
    },
    240_000,
  );

  it(
    "★ REFUSES to export a file the sandbox changed after the grant was minted",
    async () => {
      // The TOCTOU case, live. A long-running agent that is still writing when the grant
      // is minted is the ordinary case, not an exotic one. Without the re-hash the PUT
      // succeeds and the fenced commit rejects the checksum in another process.
      await withProvider(async (provider, sandboxId, store, t) => {
        await produceInSandbox(t, sandboxId, PAYLOAD_B64, OUT_PATH);
        const digest = await provider.digestArtifact(sandboxId, OUT_PATH, CTX);
        const g = grant(digest.sha256, 1_000_000);

        const append = await t.runCommand({
          sandboxId,
          command: "sh",
          args: ["-c", `printf 'the agent kept writing' >> ${OUT_PATH}`],
          envVars: {},
          timeoutMs: 60_000,
        });
        expect(append.exitCode).toBe(0);

        await expect(provider.exportArtifact(sandboxId, OUT_PATH, g, CTX)).rejects.toThrow(
          /hashed .* expected/,
        );
        // ★ And nothing was uploaded. A refusal that still PUT would be worse than no check.
        expect(store.puts).toHaveLength(0);
      });
    },
    240_000,
  );

  it(
    "★ a MISSING path in a real sandbox throws the domain not-found, never a fabricated digest",
    async () => {
      // The mock can only argue this mapping; the real driver's not-found classification
      // (`real-transport.ts` readFile -> E2bTransportNotFoundError) is observed here.
      await withProvider(async (provider, sandboxId, store) => {
        await expect(
          provider.digestArtifact(sandboxId, "/home/user/aoa-dat-009-absent.bin", CTX),
        ).rejects.toBeInstanceOf(SandboxNotFoundError);
        await expect(
          provider.exportArtifact(sandboxId, "/home/user/aoa-dat-009-absent.bin", grant(PAYLOAD_SHA256, 1_000_000), CTX),
        ).rejects.toBeInstanceOf(SandboxNotFoundError);
        expect(store.puts).toHaveLength(0);
      });
    },
    240_000,
  );

  it(
    "★ REFUSES a file that outgrew its grant, and uploads nothing",
    async () => {
      await withProvider(async (provider, sandboxId, store, t) => {
        await produceInSandbox(t, sandboxId, PAYLOAD_B64, OUT_PATH);
        const digest = await provider.digestArtifact(sandboxId, OUT_PATH, CTX);
        await expect(
          provider.exportArtifact(sandboxId, OUT_PATH, grant(digest.sha256, 16), CTX),
        ).rejects.toThrow(/over the granted 16/);
        expect(store.puts).toHaveLength(0);
      });
    },
    240_000,
  );
});
