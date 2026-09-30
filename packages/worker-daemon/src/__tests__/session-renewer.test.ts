import { describe, expect, it, vi } from "vitest";

import { generateDeviceKey } from "../identity/device-key.js";
import { createSessionRenewer } from "../identity/session-renewal.js";
import { SESSION_RENEW_PATH, ControlPlaneTransportError, type ControlPlaneClient, type WorkerOperationHttpRequest, type SessionRenewHttpResponse } from "../transport/client.js";
import { EnrollmentError, type WorkerSession } from "../enrollment/enroll.js";

// WRK-010 slice 2 — the worker-side renewal client (§5). The device-proof-over-the-path
// property (S2-M7) is proven at integration tier (the server 401s a wrong-path proof); this
// unit tier proves the OBSERVABLE contract: the live session is the Bearer (S2-M6), the new
// token is read from the header, errors map through mapErrorStatus (S2-M8), and each attempt
// signs a FRESH proofId (§10 R1).

const CURRENT: WorkerSession = {
  token: "live-session-token",
  workerId: "11111111-1111-4111-8111-111111111111",
  targetId: "22222222-2222-4222-8222-222222222222",
  deviceGeneration: 3,
  obtainedAtMs: 1_000,
  ttlMs: 900_000,
  expiresAtMs: 901_000,
};

function fakeClient(
  respond: (req: WorkerOperationHttpRequest) => SessionRenewHttpResponse | Promise<SessionRenewHttpResponse> | never,
) {
  const calls: WorkerOperationHttpRequest[] = [];
  const client = {
    sessionRenewPath: SESSION_RENEW_PATH,
    sessionRenew: vi.fn(async (req: WorkerOperationHttpRequest) => {
      calls.push(req);
      return respond(req);
    }),
  } as unknown as ControlPlaneClient;
  return { client, calls };
}

describe("createSessionRenewer (WRK-010 slice 2)", () => {
  // ★ POSITIVE CONTROL: a client that always throws must redden renew.
  it("POSITIVE CONTROL: a throwing client rejects", async () => {
    const { client } = fakeClient(() => {
      throw new Error("boom");
    });
    const renew = createSessionRenewer({ client, key: generateDeviceKey() });
    await expect(renew(CURRENT)).rejects.toThrow("boom");
  });

  it("presents the LIVE session as the Bearer and returns the NEW token from the header", async () => {
    const { client, calls } = fakeClient(() => ({
      status: 200,
      sessionHeader: "fresh-token",
      body: { protocolVersion: 1, outcome: "renewed", expiresAt: new Date(2_000).toISOString(), deviceGeneration: 3 },
    }));
    const renew = createSessionRenewer({ client, key: generateDeviceKey(), now: () => 5_000, sessionTtlMs: 900_000 });
    const next = await renew(CURRENT);

    expect(calls[0].sessionToken).toBe("live-session-token"); // S2-M6: the live bearer
    expect(next.token).toBe("fresh-token");
    expect(next.workerId).toBe(CURRENT.workerId);
    expect(next.targetId).toBe(CURRENT.targetId);
    expect(next.deviceGeneration).toBe(3);
    // Client-clock TTL: obtainedAt = now(), expiresAt = now + ttl.
    expect(next.obtainedAtMs).toBe(5_000);
    expect(next.expiresAtMs).toBe(5_000 + 900_000);
  });

  it("signs a FRESH proofId per attempt (§10 R1)", async () => {
    const { client, calls } = fakeClient(() => ({
      status: 200,
      sessionHeader: "t",
      body: { deviceGeneration: 3 },
    }));
    const renew = createSessionRenewer({ client, key: generateDeviceKey() });
    await renew(CURRENT);
    await renew(CURRENT);
    const proofId0 = calls[0].proofHeaders["aoa-device-proof-id"];
    const proofId1 = calls[1].proofHeaders["aoa-device-proof-id"];
    expect(proofId0).toBeTruthy();
    expect(proofId1).toBeTruthy();
    expect(proofId0).not.toBe(proofId1);
  });

  it("maps a 401 to a terminal stop-and-backoff EnrollmentError (S2-M8)", async () => {
    const { client } = fakeClient(() => ({ status: 401, sessionHeader: null, body: null }));
    const renew = createSessionRenewer({ client, key: generateDeviceKey() });
    await expect(renew(CURRENT)).rejects.toMatchObject({
      kind: "unauthorized",
      terminalForRequest: true,
      stopAndBackoff: true,
    });
  });

  it("maps a 503 to a RETRYABLE internal_unavailable (store must NOT stop)", async () => {
    const { client } = fakeClient(() => ({ status: 503, sessionHeader: null, body: null }));
    const renew = createSessionRenewer({ client, key: generateDeviceKey() });
    await expect(renew(CURRENT)).rejects.toMatchObject({
      kind: "internal_unavailable",
      stopAndBackoff: false,
    });
  });

  it("treats a 200 with no session header as an unexpected error", async () => {
    const { client } = fakeClient(() => ({ status: 200, sessionHeader: null, body: { deviceGeneration: 3 } }));
    const renew = createSessionRenewer({ client, key: generateDeviceKey() });
    await expect(renew(CURRENT)).rejects.toMatchObject({ kind: "unexpected" });
  });

  it("wraps a transport failure as a retryable EnrollmentError", async () => {
    const { client } = fakeClient(() => {
      throw new ControlPlaneTransportError("network", "down");
    });
    const renew = createSessionRenewer({ client, key: generateDeviceKey() });
    await expect(renew(CURRENT)).rejects.toBeInstanceOf(EnrollmentError);
    await expect(renew(CURRENT)).rejects.toMatchObject({ kind: "transport", stopAndBackoff: false });
  });
});
