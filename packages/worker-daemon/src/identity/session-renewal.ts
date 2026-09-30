/**
 * Worker-side device-proof session RENEWAL client (WRK-010 slice 2).
 *
 * This is the PRODUCTION body of `SessionStoreDeps.renew` — the caller slice 1's route
 * (`POST /api/worker-control/session/renew`) was missing. It presents a STILL-LIVE session
 * as the Bearer plus a FRESH device proof, and receives a new 15-minute session. No
 * enrollment code, no 10-minute code-route ceiling, nothing re-read off disk.
 *
 * Mirrors the enroller (`enroll.ts` `submit`): sign a device proof over the EXACT request
 * path + body, POST, and map the response. It reuses `mapErrorStatus` so a renewal-route 401
 * and an enroll-route 401 flow through ONE stop-and-backoff policy in `SessionStore`
 * (`forceRefresh`'s catch) — a 401 here means the worker's authority is gone and the only
 * recovery is re-enrollment, exactly as on the enroll path.
 *
 * A FRESH `proofId` is generated per attempt (WRK-010 §10 R1): a retry reusing a spent one
 * dies as a replay and reads as a revocation.
 */

import { randomBytes, randomUUID } from "node:crypto";

import type { DeviceKey } from "./device-key.js";
import { signDeviceProof } from "./device-proof.js";
import {
  DEFAULT_SESSION_TTL_MS,
  EnrollmentError,
  mapErrorStatus,
  type WorkerSession,
} from "../enrollment/enroll.js";
import { ControlPlaneTransportError, type ControlPlaneClient } from "../transport/client.js";

export interface SessionRenewerDeps {
  readonly client: ControlPlaneClient;
  /** The enrolled device key; signs the renewal proof. */
  readonly key: DeviceKey;
  readonly now?: () => number;
  /** Injectable for tests; a FRESH id per attempt in production. */
  readonly randomProofId?: () => string;
  readonly randomUuid?: () => string;
  readonly sessionTtlMs?: number;
}

function defaultProofId(): string {
  return `prf_${randomBytes(24).toString("base64url")}`;
}

/**
 * Build the renewal thunk `SessionStoreDeps.renew` expects: given the CURRENT live session,
 * exchange it for a new one on the renewal route.
 */
export function createSessionRenewer(deps: SessionRenewerDeps): (current: WorkerSession) => Promise<WorkerSession> {
  const now = deps.now ?? (() => Date.now());
  const newProofId = deps.randomProofId ?? defaultProofId;
  const newUuid = deps.randomUuid ?? (() => randomUUID());
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

  return async function renew(current: WorkerSession): Promise<WorkerSession> {
    const correlationId = newUuid();
    // The exact `sessionRenewRequestSchema` shape the server expects
    // (`services/worker-session-renewal.ts`), `.strict()`-clean.
    const bytes = Buffer.from(
      JSON.stringify({ protocolVersion: 1, audience: "device_session", correlationId }),
      "utf8",
    );

    const proof = signDeviceProof({
      method: "POST",
      path: deps.client.sessionRenewPath,
      rawBody: bytes,
      correlationId,
      issuedAt: new Date(now()).toISOString(),
      proofId: newProofId(), // FRESH per attempt (§10 R1)
      key: deps.key,
    });

    let response;
    try {
      response = await deps.client.sessionRenew({
        bytes,
        // The LIVE session is the Bearer — this is the whole reason renew takes `current`.
        sessionToken: current.token,
        proofHeaders: proof.headers,
        requestId: correlationId,
      });
    } catch (err) {
      if (err instanceof ControlPlaneTransportError) {
        const terminal = err.kind === "request_too_large";
        throw new EnrollmentError("transport", terminal, false, `session renewal transport failed: ${err.kind}`);
      }
      throw err;
    }

    if (response.status !== 200) {
      // 401 → unauthorized + stopAndBackoff (authority gone, re-enroll); 400 → malformed;
      // 429/503 → internal_unavailable (retryable). Reused so the two 401 sources agree.
      throw mapErrorStatus(response.status);
    }
    if (!response.sessionHeader) {
      throw new EnrollmentError("unexpected", true, false, "renewed response missing the session header", 200);
    }
    const generation = readDeviceGeneration(response.body, current.deviceGeneration);
    const obtainedAtMs = now();
    return {
      token: response.sessionHeader,
      workerId: current.workerId,
      targetId: current.targetId,
      deviceGeneration: generation,
      obtainedAtMs,
      ttlMs: sessionTtlMs,
      // Client-clock TTL, mirroring `enroll.ts` — so the near-expiry threshold measures
      // now-vs-expiry on ONE clock. The server's `expiresAt` is echoed in the body for logs.
      expiresAtMs: obtainedAtMs + sessionTtlMs,
    };
  };
}

/** Read the server-reported device generation; fall back to the presented one (renewal never
 * rotates it — `admitSessionRenewal` mints for the authenticated principal's generation). */
function readDeviceGeneration(body: unknown, fallback: number): number {
  if (body && typeof body === "object" && "deviceGeneration" in body) {
    const g = (body as { deviceGeneration: unknown }).deviceGeneration;
    if (typeof g === "number" && Number.isInteger(g)) return g;
  }
  return fallback;
}
