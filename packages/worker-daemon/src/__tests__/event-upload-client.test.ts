import { describe, expect, it } from "vitest";

import { OPERATION_DESCRIPTORS } from "@armyofagents/worker-protocol";

import {
  ControlPlaneTransportError,
  EVENT_UPLOAD_PATH,
  createControlPlaneClient,
} from "../transport/client.js";

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
    captured.push({
      url: String(input),
      method: init?.method,
      headers,
      body: init?.body as Uint8Array,
    });
    return new Response(JSON.stringify(response.body), { status: response.status });
  }) as unknown as typeof fetch;
  return createControlPlaneClient({ baseUrl: "http://127.0.0.1:9", fetchImpl });
}

const PROOF = { "aoa-device-proof-version": "1" } as const;

describe("transport eventUpload — new daemon surface only (slice 3)", () => {
  it("consumes the FROZEN event_upload descriptor: 4 MiB ceiling + 30s timeout", () => {
    expect(EVENT_UPLOAD_PATH).toBe("/api/worker-control/events");
    expect(OPERATION_DESCRIPTORS.event_upload.maxRequestBytes).toBe(4 * 1024 * 1024);
    expect(OPERATION_DESCRIPTORS.event_upload.timeoutMs).toBe(30_000);
  });

  it("POSTs the exact bytes to EVENT_UPLOAD_PATH with Bearer + proof headers", async () => {
    const captured: CapturedRequest[] = [];
    const client = capturingClient({ status: 200, body: { ok: true } }, captured);
    const bytes = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    await client.eventUpload({ bytes, sessionToken: "sess-abc", proofHeaders: PROOF, requestId: "corr-1" });

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(new URL(req.url).pathname).toBe(EVENT_UPLOAD_PATH);
    expect(req.method).toBe("POST");
    expect(req.headers["authorization"]).toBe("Bearer sess-abc");
    expect(req.headers["aoa-device-proof-version"]).toBe("1");
    expect(Buffer.from(req.body).toString("utf8")).toBe(bytes.toString("utf8"));
    // The proof is signed over the plain pathname (no id-in-path) — expose it.
    expect(client.eventUploadPath).toBe(EVENT_UPLOAD_PATH);
  });

  it("pre-checks the 4 MiB ceiling — an oversize batch throws request_too_large (terminal)", async () => {
    const captured: CapturedRequest[] = [];
    const client = capturingClient({ status: 200, body: {} }, captured);
    const tooBig = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61);
    let thrown: unknown;
    try {
      await client.eventUpload({ bytes: tooBig, sessionToken: "s", proofHeaders: PROOF });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ControlPlaneTransportError);
    expect((thrown as ControlPlaneTransportError).kind).toBe("request_too_large");
    // Nothing was sent — the ceiling is enforced before the socket.
    expect(captured).toHaveLength(0);
  });

  it("maps a network failure to a transport error (timeout/network kinds)", async () => {
    const fetchImpl = (async () => {
      const err = new Error("boom");
      err.name = "TypeError";
      throw err;
    }) as unknown as typeof fetch;
    const client = createControlPlaneClient({ baseUrl: "http://127.0.0.1:9", fetchImpl });
    await expect(
      client.eventUpload({ bytes: Buffer.from("x"), sessionToken: "s", proofHeaders: PROOF }),
    ).rejects.toBeInstanceOf(ControlPlaneTransportError);
  });
});
