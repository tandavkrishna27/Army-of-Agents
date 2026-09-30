import { describe, expect, it, vi } from "vitest";

import { sendHeartbeat } from "../identity/worker-heartbeat.js";
import { generateDeviceKey } from "../identity/device-key.js";
import type { ControlPlaneClient, WorkerOperationHttpRequest } from "../transport/client.js";
import type { WorkerSession } from "../enrollment/enroll.js";

const SESSION: WorkerSession = {
  token: "sess-token",
  workerId: "w1",
  targetId: "t1",
  deviceGeneration: 1,
  obtainedAtMs: 0,
  ttlMs: 900_000,
  expiresAtMs: 900_000,
};

function mockClient(heartbeat: (req: WorkerOperationHttpRequest) => Promise<{ status: number }>): ControlPlaneClient {
  return {
    heartbeatPath: "/api/execution-targets/heartbeat",
    heartbeat,
  } as unknown as ControlPlaneClient;
}

describe("sendHeartbeat", () => {
  const key = generateDeviceKey();

  it("returns ok on a 204 and posts a signed strict {status} body", async () => {
    const heartbeat = vi.fn(async (_req: WorkerOperationHttpRequest) => ({ status: 204 }));
    const result = await sendHeartbeat({ client: mockClient(heartbeat), session: SESSION, key });

    expect(result).toBe("ok");
    expect(heartbeat).toHaveBeenCalledTimes(1);
    const req = heartbeat.mock.calls[0]![0];
    expect(req.sessionToken).toBe("sess-token");
    expect(Buffer.from(req.bytes).toString("utf8")).toBe(JSON.stringify({ status: "active" }));
    // A device proof was attached (the exact headers are covered by device-proof's own tests).
    expect(Object.keys(req.proofHeaders).length).toBeGreaterThan(0);
  });

  it("returns failed on a non-204 status", async () => {
    const result = await sendHeartbeat({
      client: mockClient(async () => ({ status: 401 })),
      session: SESSION,
      key,
    });
    expect(result).toBe("failed");
  });

  it("returns failed (never throws) on a transport error", async () => {
    const result = await sendHeartbeat({
      client: mockClient(async () => {
        throw new Error("network");
      }),
      session: SESSION,
      key,
    });
    expect(result).toBe("failed");
  });
});
