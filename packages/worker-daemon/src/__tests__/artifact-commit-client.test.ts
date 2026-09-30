import { describe, expect, it } from "vitest";

import { OPERATION_DESCRIPTORS } from "@armyofagents/worker-protocol";

import {
  ARTIFACT_COMMIT_PATH,
  ARTIFACT_TRANSFER_GRANT_PATH,
  ControlPlaneTransportError,
  createControlPlaneClient,
} from "../transport/client.js";

// -----------------------------------------------------------------------------
// CLI-003/D4 — the daemon transport client gains the `artifact_commit` (and
// `artifact_transfer_grant`) worker_run operations, mirroring the existing
// event_upload surface. Both were genuinely MISSING before CLI-003 (the frozen
// descriptors + server routes exist; the client stopped at event_upload/quarantine).
// -----------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Uint8Array;
}

function capturingClient(response: { status: number; body: unknown }, captured: CapturedRequest[]) {
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    captured.push({ url: String(input), method: init?.method, headers, body: init?.body as Uint8Array });
    return new Response(JSON.stringify(response.body), { status: response.status });
  }) as unknown as typeof fetch;
  return createControlPlaneClient({ baseUrl: "http://127.0.0.1:9", fetchImpl });
}

const PROOF = { "aoa-device-proof-version": "1" } as const;

describe("CLI-003/D4 — artifactCommit client surface", () => {
  it("consumes the FROZEN artifact_commit descriptor: 256 KiB ceiling + 15s timeout", () => {
    expect(ARTIFACT_COMMIT_PATH).toBe("/api/worker-control/artifact-commits");
    expect(OPERATION_DESCRIPTORS.artifact_commit.maxRequestBytes).toBe(256 * 1024);
    expect(OPERATION_DESCRIPTORS.artifact_commit.timeoutMs).toBe(15_000);
  });

  it("POSTs the exact bytes to ARTIFACT_COMMIT_PATH with Bearer + proof headers", async () => {
    const captured: CapturedRequest[] = [];
    const client = capturingClient({ status: 200, body: { outcome: "committed" } }, captured);
    const bytes = Buffer.from(JSON.stringify({ commit: 1 }), "utf8");
    const res = await client.artifactCommit({ bytes, sessionToken: "sess-abc", proofHeaders: PROOF, requestId: "corr-1" });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(new URL(req.url).pathname).toBe(ARTIFACT_COMMIT_PATH);
    expect(req.method).toBe("POST");
    expect(req.headers["authorization"]).toBe("Bearer sess-abc");
    expect(Buffer.from(req.body).toString("utf8")).toBe(bytes.toString("utf8"));
    expect(client.artifactCommitPath).toBe(ARTIFACT_COMMIT_PATH);
  });

  it("pre-checks the 256 KiB ceiling — an oversize commit throws request_too_large", async () => {
    const captured: CapturedRequest[] = [];
    const client = capturingClient({ status: 200, body: {} }, captured);
    const tooBig = Buffer.alloc(256 * 1024 + 1, 0x61);
    let thrown: unknown;
    try {
      await client.artifactCommit({ bytes: tooBig, sessionToken: "s", proofHeaders: PROOF });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ControlPlaneTransportError);
    expect((thrown as ControlPlaneTransportError).kind).toBe("request_too_large");
    expect(captured).toHaveLength(0);
  });

  it("exposes an artifactTransferGrant surface at its route with the 64 KiB ceiling", async () => {
    expect(ARTIFACT_TRANSFER_GRANT_PATH).toBe("/api/worker-control/artifact-transfer-grants");
    expect(OPERATION_DESCRIPTORS.artifact_transfer_grant.maxRequestBytes).toBe(64 * 1024);
    const captured: CapturedRequest[] = [];
    const client = capturingClient({ status: 200, body: { outcome: "upload_granted" } }, captured);
    await client.artifactTransferGrant({ bytes: Buffer.from("x"), sessionToken: "s", proofHeaders: PROOF });
    expect(new URL(captured[0]!.url).pathname).toBe(ARTIFACT_TRANSFER_GRANT_PATH);
  });
});
