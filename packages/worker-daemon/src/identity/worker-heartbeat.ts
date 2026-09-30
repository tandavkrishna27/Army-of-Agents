// Wave-4 — the daemon-side heartbeat caller.
//
// The poll authority (`server/src/services/job-leasing.ts` authorityCurrent) requires
// worker.lastSeenAt AND target.lastSeenAt to be non-null and fresh. Nothing else in the
// shipped daemon advances worker.lastSeenAt (device-liveness.ts documents there is no periodic
// heartbeat), so a freshly enrolled worker's first poll is denied (returned as target_revoked)
// and the poll loop stops. This caller sends ONE heartbeat to POST /api/execution-targets/heartbeat,
// which seeds both rows server-side (registerProofBoundHeartbeat) and returns 204.
//
// ★ BEST-EFFORT, NEVER THROWS. A failure returns "failed"; the caller/loop decides what to do.
// Mirrors identity/self-hello-refresh.ts (same proof + request shape); the heartbeat has no
// session-header response (204), so it returns the coarse outcome only.

import { randomBytes, randomUUID } from "node:crypto";

import type { ControlPlaneClient } from "../transport/client.js";
import type { DeviceKey } from "./device-key.js";
import { signDeviceProof } from "./device-proof.js";
import type { WorkerSession } from "../enrollment/enroll.js";

export interface SendHeartbeatDeps {
  readonly client: ControlPlaneClient;
  /** The live session presented as Bearer (and the source of the device binding). */
  readonly session: WorkerSession;
  readonly key: DeviceKey;
  readonly now?: () => number;
  readonly newProofId?: () => string;
  readonly newCorrelationId?: () => string;
}

/**
 * Send one heartbeat. Returns "ok" on a 204, "failed" on any other status or transport
 * error. Never throws.
 */
export async function sendHeartbeat(deps: SendHeartbeatDeps): Promise<"ok" | "failed"> {
  const now = deps.now ?? (() => Date.now());
  const newProofId = deps.newProofId ?? (() => `prf_${randomBytes(24).toString("base64url")}`);

  try {
    // Everything that can throw lives INSIDE this try — the id INVOCATIONS (correlationId, proofId,
    // now) and signing (crypto/canonicalization) as well as transport — so the documented "NEVER
    // THROWS" contract is literally true for ANY caller, not only the loop (which already wraps this
    // call defensively). The `now`/`newProofId` *default resolution* above is a plain `??` that
    // cannot throw; only their invocation can, which is here.
    const correlationId = (deps.newCorrelationId ?? (() => randomUUID()))();
    // Body MUST match workerExecutionTargetHeartbeatSchema (`.strict()`): only { status }.
    const bytes = Buffer.from(JSON.stringify({ status: "active" }), "utf8");
    const proof = signDeviceProof({
      method: "POST",
      path: deps.client.heartbeatPath,
      rawBody: bytes,
      correlationId,
      issuedAt: new Date(now()).toISOString(),
      proofId: newProofId(),
      key: deps.key,
    });
    const response = await deps.client.heartbeat({
      bytes,
      sessionToken: deps.session.token,
      proofHeaders: proof.headers,
      requestId: correlationId,
    });
    return response.status === 204 ? "ok" : "failed";
  } catch {
    return "failed"; // signing or transport failure — best-effort, never a throw
  }
}
