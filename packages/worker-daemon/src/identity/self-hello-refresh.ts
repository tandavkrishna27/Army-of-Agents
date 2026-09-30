// WRK-008 slice 2b — the daemon-side caller for WRK-011's self-hello refresh route.
//
// WRK-011 shipped the server route (`POST /api/execution-targets/self/hello`) and the
// transport method `client.selfHelloRefresh`, but left the daemon caller uncomposed. This is
// it: once per boot, before polling, a provisioned worker presents its PROVISIONED hello so
// the server replaces `profile_snapshot` + `profile_hash` and mints a FRESH session bound to
// the new hash. Without it the stored snapshot stays unmatchable and the server offers no work.
//
// ★ BEST-EFFORT, NEVER THROWS. A refresh failure leaves the server snapshot stale (the worker
// polls but is offered nothing) and the daemon healthy and inert — the same "healthy and
// inert" degradation every other failure lands in. It must not kill the composition.
//
// ★ THE OLD SESSION DIES ON SUCCESS. By worker-session-auth.ts:167 replacing `profile_hash`
// invalidates the caller's OWN session, so a worker that refreshes and keeps its old session
// is worse off than before. The refreshed session returned here is the one to store.

import { randomBytes, randomUUID } from "node:crypto";

import type { WorkerHelloV1 } from "@armyofagents/worker-protocol";

import type { ControlPlaneClient } from "../transport/client.js";
import type { DeviceKey } from "./device-key.js";
import { signDeviceProof } from "./device-proof.js";
import { DEFAULT_SESSION_TTL_MS, type WorkerSession } from "../enrollment/enroll.js";

export interface RefreshSelfHelloDeps {
  readonly client: ControlPlaneClient;
  /** The live session presented as Bearer (and the source of workerId/targetId/generation). */
  readonly current: WorkerSession;
  readonly key: DeviceKey;
  /** The PROVISIONED hello to install as the target's snapshot. */
  readonly hello: WorkerHelloV1;
  readonly now?: () => number;
  readonly newProofId?: () => string;
  readonly newCorrelationId?: () => string;
  readonly sessionTtlMs?: number;
}

/** Returns the FRESH session on a 200 refresh, the UNCHANGED session on a 204 (no-op), or
 * `null` on any failure (transport, non-2xx, or a 200 missing the session header). */
export async function refreshSelfHello(deps: RefreshSelfHelloDeps): Promise<WorkerSession | null> {
  const now = deps.now ?? (() => Date.now());
  const newProofId = deps.newProofId ?? (() => `prf_${randomBytes(24).toString("base64url")}`);
  const correlationId = (deps.newCorrelationId ?? (() => randomUUID()))();
  const ttlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

  const bytes = Buffer.from(
    JSON.stringify({ protocolVersion: 1, correlationId, hello: deps.hello }),
    "utf8",
  );
  const proof = signDeviceProof({
    method: "POST",
    path: deps.client.selfHelloRefreshPath,
    rawBody: bytes,
    correlationId,
    issuedAt: new Date(now()).toISOString(),
    proofId: newProofId(),
    key: deps.key,
  });

  let response;
  try {
    response = await deps.client.selfHelloRefresh({
      bytes,
      sessionToken: deps.current.token,
      proofHeaders: proof.headers,
      requestId: correlationId,
    });
  } catch {
    return null; // transport failure — best-effort, never a throw
  }

  if (response.status === 204) return deps.current; // no-op: snapshot unchanged, session still valid
  if (response.status !== 200 || !response.sessionHeader) return null;

  const obtainedAtMs = now();
  return {
    token: response.sessionHeader,
    workerId: deps.current.workerId,
    targetId: deps.current.targetId,
    deviceGeneration: deps.current.deviceGeneration,
    obtainedAtMs,
    ttlMs,
    expiresAtMs: obtainedAtMs + ttlMs,
  };
}
