/**
 * Device-bound enrollment + lost-response replay recovery flow (WRK-002).
 *
 * `enroll` performs the initial CONSUME (fresh idempotency key); `renew` performs
 * a replay against the SAME code with the RETAINED idempotency key + unchanged
 * semantic digest + a FRESH device proof — the JOB-002 as-built session model
 * (E4-D05, as amended by E4-D11): there is NO dedicated renew route/audience.
 * Both post to the frozen `target_enrollment` operation; the server distinguishes
 * initial-consume from replay server-side and issues a NEW short-lived session
 * either way. Replay is a lost-response RECOVERY mechanism (recover a session
 * after a dropped enroll response), NOT sustained session renewal: the server
 * gates every enroll — replay included — on the enrollment CODE ROUTE TTL
 * (`CODE_TTL_MS = 10 min`, never extended, shorter than the 15-min session), so a
 * replay only succeeds while the code route is live. Sustained renewal past that
 * window is out of scope (E4-F007); a lapsed session requires re-enrollment.
 *
 * Failure mapping is fail-safe. On the enroll/renew path the as-built server
 * route (`server/src/routes/worker-control.ts`) COLLAPSES an enrollment-service
 * `target_revoked` into HTTP 401 `unauthorized` (it only emits
 * malformed/unauthorized/internal_unavailable; `target_revoked` is surfaced only
 * on poll/lease_ack). A 401 on this path can therefore mean a revoked/replaced
 * generation, so the worker treats it as terminal-for-request AND stops using
 * the identity and backs off — it never retries with a possibly-revoked key. A
 * changed digest / idempotency mismatch is `malformed` (terminal, not a stop). A
 * corrupt key store fails closed (the `DeviceKeyStoreError` propagates; the
 * daemon exits non-zero) rather than silently minting a new identity.
 */

import { randomBytes, randomUUID } from "node:crypto";

import {
  enrollmentResponseV1Schema,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";

import { generateDeviceKey, type DeviceKey } from "../identity/device-key.js";
import { signDeviceProof } from "../identity/device-proof.js";
import type { DeviceKeyStore } from "../identity/key-store.js";
import { buildEnrollmentRequest } from "../transport/envelope.js";
import { ControlPlaneTransportError, type ControlPlaneClient } from "../transport/client.js";

export const DEFAULT_SESSION_TTL_MS = 15 * 60_000;

export type EnrollmentFailureKind =
  | "unauthorized"
  | "malformed"
  | "target_revoked"
  | "internal_unavailable"
  | "transport"
  | "unexpected";

/**
 * A structured enrollment failure. `terminalForRequest` = the request cannot be
 * usefully re-sent unchanged. `stopAndBackoff` = the worker must stop using the
 * current identity and back off (revocation/expired generation, or an ambiguous
 * `unauthorized` on the enroll/renew path).
 */
export class EnrollmentError extends Error {
  constructor(
    public readonly kind: EnrollmentFailureKind,
    public readonly terminalForRequest: boolean,
    public readonly stopAndBackoff: boolean,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "EnrollmentError";
  }
}

export interface WorkerSession {
  readonly token: string;
  readonly workerId: string;
  readonly targetId: string;
  readonly deviceGeneration: number;
  readonly obtainedAtMs: number;
  readonly ttlMs: number;
  readonly expiresAtMs: number;
}

export interface EnrollResult {
  readonly outcome: "enrolled";
  readonly workerId: string;
  readonly targetId: string;
  readonly deviceGeneration: number;
  readonly providerConstraints: unknown;
  readonly session: WorkerSession;
  /** Retained so a later renewal replays with the same key (no double-consume). */
  readonly idempotencyKey: string;
  /** True when this submission reused an idempotency key (a renewal/replay). */
  readonly replay: boolean;
  /** The device thumbprint the identity is bound to. */
  readonly deviceThumbprint: string;
}

export interface EnrollerDeps {
  readonly keyStore: DeviceKeyStore;
  readonly client: ControlPlaneClient;
  readonly now?: () => number;
  readonly sessionTtlMs?: number;
  readonly randomUuid?: () => string;
  readonly randomProofId?: () => string;
  readonly randomNonce?: () => string;
}

export interface EnrollInput {
  readonly hello: WorkerHelloV1;
  readonly code: string;
}

export interface RenewInput extends EnrollInput {
  readonly idempotencyKey: string;
}

export interface Enroller {
  /** Initial consume with a fresh idempotency key. */
  enroll(input: EnrollInput): Promise<EnrollResult>;
  /** Replay renewal reusing a prior idempotency key (fresh proof). */
  renew(input: RenewInput): Promise<EnrollResult>;
}

function defaultProofId(): string {
  return `prf_${randomBytes(24).toString("base64url")}`;
}
function defaultNonce(): string {
  return randomBytes(18).toString("base64url");
}

/** Load the persisted device key or mint+persist a new one. A corrupt store
 * throws `DeviceKeyStoreError` here (fail closed) — never masked. */
function loadOrCreateKey(keyStore: DeviceKeyStore): DeviceKey {
  const existing = keyStore.load();
  if (existing) return existing;
  const created = generateDeviceKey();
  keyStore.save(created);
  return created;
}

export function createEnroller(deps: EnrollerDeps): Enroller {
  const now = deps.now ?? (() => Date.now());
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const newUuid = deps.randomUuid ?? (() => randomUUID());
  const newProofId = deps.randomProofId ?? defaultProofId;
  const newNonce = deps.randomNonce ?? defaultNonce;

  async function submit(input: EnrollInput, idempotencyKey: string, replay: boolean): Promise<EnrollResult> {
    const key = loadOrCreateKey(deps.keyStore);

    const correlationId = newUuid();
    const issuedAt = new Date(now()).toISOString();
    const { bytes } = buildEnrollmentRequest({
      correlationId,
      idempotencyKey,
      issuedAt,
      nonce: newNonce(),
      hello: input.hello,
    });

    const proof = signDeviceProof({
      method: "POST",
      path: deps.client.path,
      rawBody: bytes,
      correlationId,
      issuedAt: new Date(now()).toISOString(),
      proofId: newProofId(),
      key,
    });

    let response;
    try {
      response = await deps.client.enroll({
        bytes,
        enrollmentCode: input.code,
        proofHeaders: proof.headers,
        requestId: correlationId,
      });
    } catch (err) {
      if (err instanceof ControlPlaneTransportError) {
        const terminal = err.kind === "request_too_large";
        throw new EnrollmentError("transport", terminal, false, `enrollment transport failed: ${err.kind}`);
      }
      throw err;
    }

    if (response.status === 200) {
      const parsed = enrollmentResponseV1Schema.safeParse(response.body);
      if (!parsed.success) {
        throw new EnrollmentError("unexpected", true, false, "enrollment response failed schema validation", 200);
      }
      if (parsed.data.outcome !== "enrolled") {
        throw new EnrollmentError(
          "unexpected",
          true,
          false,
          `enrollment rejected: ${parsed.data.reason}`,
          200,
        );
      }
      if (!response.sessionHeader) {
        throw new EnrollmentError("unexpected", true, false, "enrolled response missing the session header", 200);
      }
      const obtainedAtMs = now();
      const session: WorkerSession = {
        token: response.sessionHeader,
        workerId: parsed.data.workerId,
        targetId: parsed.data.targetId,
        deviceGeneration: parsed.data.deviceGeneration,
        obtainedAtMs,
        ttlMs: sessionTtlMs,
        expiresAtMs: obtainedAtMs + sessionTtlMs,
      };
      return {
        outcome: "enrolled",
        workerId: parsed.data.workerId,
        targetId: parsed.data.targetId,
        deviceGeneration: parsed.data.deviceGeneration,
        providerConstraints: parsed.data.providerConstraints,
        session,
        idempotencyKey,
        replay,
        deviceThumbprint: key.deviceThumbprint,
      };
    }

    throw mapErrorStatus(response.status);
  }

  return {
    enroll(input: EnrollInput): Promise<EnrollResult> {
      return submit(input, newUuid(), false);
    },
    renew(input: RenewInput): Promise<EnrollResult> {
      return submit(input, input.idempotencyKey, true);
    },
  };
}

/**
 * Map an enroll HTTP error status to a structured failure. 401 is fail-safe:
 * because the enroll route collapses `target_revoked` into `unauthorized`, a 401
 * on this path is treated as terminal-for-request AND stop+backoff.
 */
export function mapErrorStatus(status: number): EnrollmentError {
  switch (status) {
    case 400:
      return new EnrollmentError("malformed", true, false, "enrollment request malformed", 400);
    case 401:
      return new EnrollmentError(
        "unauthorized",
        true,
        true,
        "enrollment unauthorized (possibly a revoked/replaced generation on the enroll route)",
        401,
      );
    case 409:
      return new EnrollmentError("target_revoked", true, true, "enrollment target revoked", 409);
    case 429:
      return new EnrollmentError("internal_unavailable", false, false, "enrollment throttled", 429);
    case 503:
      return new EnrollmentError("internal_unavailable", false, false, "enrollment temporarily unavailable", 503);
    default:
      return new EnrollmentError("unexpected", true, false, `unexpected enrollment status ${status}`, status);
  }
}
