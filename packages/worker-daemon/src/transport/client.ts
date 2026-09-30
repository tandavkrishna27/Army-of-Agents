/**
 * Control-plane HTTP client for the enroll operation (WRK-002).
 *
 * A thin POST client that obeys `OPERATION_DESCRIPTORS.enrollment` (audience
 * `target_enrollment`, 256 KiB request ceiling, 15s client timeout). It attaches
 * the enrollment-code + `aoa-device-*` proof headers, sends the exact signed
 * bytes, and returns the raw status + parsed body + `aoa-worker-session` header
 * for the enroll flow to interpret. HTTP method/path/status live HERE (kept out
 * of the frozen protocol package); the enroll path is exposed so the proof is
 * signed over the SAME path the request is sent to.
 */

import { OPERATION_DESCRIPTORS } from "@armyofagents/worker-protocol";

import { WORKER_CONTROL_HEADERS } from "./headers.js";

/** The mounted enroll route path (server: `api.use(...)` at `/api`). */
export const ENROLL_PATH = "/api/worker-control/enroll";
/** The mounted poll route path (audience `worker_poll`). */
export const POLL_PATH = "/api/worker-control/poll";
/** The mounted lease-ack route base (audience `worker_run`). Both the ack and the
 * WRK-005 renew route hang off this base (`…/leases/:id/ack`, `…/leases/:id/renew`). */
export const LEASE_ACK_BASE_PATH = "/api/worker-control/leases";

/**
 * The mounted quarantine route paths (audience `device_session`, WRK-005). These
 * path strings are PROVISIONAL: the concrete E5/DAT server contract (route strings
 * + the exact device-session header binding) is not built yet. WRK-005 shapes the
 * client to the frozen `quarantine_*` v1 schemas and tests against the fake plane's
 * chosen binding; the live round-trip is E5/DAT.
 */
export const QUARANTINE_GRANT_PATH = "/api/worker-control/quarantine/grant";
export const QUARANTINE_FINALIZE_PATH = "/api/worker-control/quarantine/finalize";

/**
 * The mounted event-upload route path (audience `worker_run`, WRK-006). Fixed
 * (no id-in-path), so the device proof is signed over this EXACT `/api/...`
 * pathname. The daemon is a PURE CONSUMER of the frozen `event_upload` op.
 */
export const EVENT_UPLOAD_PATH = "/api/worker-control/events";

/**
 * The mounted artifact-commit route path (audience `worker_run`, DAT-002/CLI-003).
 * The daemon is a PURE CONSUMER of the frozen `artifact_commit` op — the server
 * half (`server/src/services/artifact-commit.ts`) is `guardActiveFence`-first and
 * idempotent. Fixed (no id-in-path), so the device proof is signed over this EXACT
 * pathname. Mirrors the mounted route `/api/worker-control/artifact-commits`.
 */
export const ARTIFACT_COMMIT_PATH = "/api/worker-control/artifact-commits";

/**
 * The mounted control-ACK route path (audience `worker_run`, JOB-006/JOB-015). The
 * worker uploads its ACK for a control command it received on the lease-renew
 * response's `dev.aoa.job/control-v1` extension. Fixed (no id-in-path), so the device
 * proof is signed over this EXACT pathname; mirrors the mounted route
 * `/api/worker-control/control-acks`.
 *
 * ★ The ACK is the ONLY thing that clears `ack_status IS NULL` server-side, and that
 * column is what stops redelivery. Before JOB-015 the daemon had no client method for
 * this route at all — the ACK surface existed on the server with no caller on the
 * worker, the mirror image of the read that had no caller on the server.
 */
export const CONTROL_ACK_PATH = "/api/worker-control/control-acks";

/**
 * The mounted artifact-transfer-grant route path (audience `worker_run`,
 * DAT-002/CLI-003). Consumes the frozen `artifact_transfer_grant` op. The live
 * presigned-upload round-trip (grant → PUT → commit) is DAT-002 slice 7 (a
 * documented CLI-003 non-goal); this surface is provided for completeness so the
 * commit path has its paired grant op on the client.
 */
export const ARTIFACT_TRANSFER_GRANT_PATH = "/api/worker-control/artifact-transfer-grants";

/**
 * WRK-008 slice 2 — the worker reads its OWN registered self-model.
 *
 * ★ NOT a frozen wire op, and deliberately not under `/api/worker-control/`. E4-D02 keeps
 * the ten frozen operations closed, so this is a LOCAL operation with a local descriptor —
 * the same shape DAT-008 used for its sandbox-local resolve route. It carries no target
 * identifier: the target comes from the authenticated principal, so "no other target is
 * reachable" is true by construction rather than by a check that could drift.
 *
 * The path is duplicated from the server route (`execution-targets.ts`) because the device
 * proof is signed OVER the path — a mismatch here is not a 404, it is a signature that can
 * never verify. Pinned by a parity test rather than by comment.
 */
export const SELF_MODEL_READ_PATH = "/api/execution-targets/self/placement-profile";

/** Local descriptor for the self-model read. A route without one silently has no size
 * ceiling and no timeout; the values mirror the smallest frozen op class (64 KiB / 15s). */
export const SELF_MODEL_READ_DESCRIPTOR = Object.freeze({
  maxRequestBytes: 64 * 1024,
  timeoutMs: 15_000,
});

/**
 * WRK-010 slice 2 — the device-proof session RENEWAL route.
 *
 * ★ NOT a frozen wire op (E4-D02 keeps `WORKER_PROTOCOL_OPERATIONS` a closed ten), so this
 * is a LOCAL operation with a LOCAL descriptor, the same shape slice 1 gave the server side
 * (`services/worker-session-renewal.ts` `SESSION_RENEW_DESCRIPTOR`). The path is duplicated
 * from the server route and the `/api` mount is PART of the signed contract — the device proof
 * is signed OVER this exact string, so a drift is a signature that can never verify, not a 404.
 * Pinned by `scripts/check-worker-path-parity.mjs`, never by comment.
 */
export const SESSION_RENEW_PATH = "/api/worker-control/session/renew";

/** Local descriptor for the renewal request: a version, an audience literal and one UUID —
 * larger is not one of ours. Mirrors the server descriptor (2 KiB / 10s). */
export const SESSION_RENEW_DESCRIPTOR = Object.freeze({
  maxRequestBytes: 2 * 1024,
  timeoutMs: 10_000,
});

/**
 * WRK-011 — the device-proof self-hello-REFRESH route.
 *
 * ★ NOT a frozen wire op (E4-D02 keeps the ten closed), so a LOCAL op with a LOCAL
 * descriptor, mounted beside the self-model read rather than under `/api/worker-control/`.
 * The path is duplicated from the server route and the `/api` mount is PART of the signed
 * contract — the device proof is signed OVER this exact string, so a drift is a signature
 * that can never verify, not a 404. Pinned by `scripts/check-worker-path-parity.mjs`.
 */
export const SELF_HELLO_PATH = "/api/execution-targets/self/hello";

/** Local descriptor for the refresh request (one hello). Mirrors the server descriptor
 * (`services/worker-hello-refresh.ts` SELF_HELLO_DESCRIPTOR) and the self-model read: 64 KiB / 15s. */
export const SELF_HELLO_DESCRIPTOR = Object.freeze({
  maxRequestBytes: 64 * 1024,
  timeoutMs: 15_000,
});

/** The worker execution-target heartbeat path. The device proof is signed OVER this exact
 * string (the `/api` mount included), pinned by scripts/check-worker-path-parity.mjs. Server
 * route: server/src/routes/execution-targets.ts `POST /execution-targets/heartbeat`; it seeds
 * both worker.lastSeenAt and target.lastSeenAt and returns 204. */
export const HEARTBEAT_PATH = "/api/execution-targets/heartbeat";

/** Local descriptor for the heartbeat request (a tiny `{status}` body). */
export const HEARTBEAT_DESCRIPTOR = Object.freeze({
  maxRequestBytes: 4 * 1024,
  timeoutMs: 15_000,
});

/**
 * DAT-008 slice 5 — the sandbox-local execution-secret RESOLVE route.
 *
 * ★ NOT a frozen wire op (E4-D02 keeps `WORKER_PROTOCOL_OPERATIONS` a closed ten), so a LOCAL op
 * with a LOCAL descriptor, mounted under `/api/worker-control/`. The path is duplicated from the
 * server route and the `/api` mount is PART of the signed contract — the device proof is signed
 * OVER this exact string, so a drift is a signature that can never verify, not a 404. Pinned by
 * `scripts/check-worker-path-parity.mjs`.
 *
 * Unlike renewal/self-hello, the resolved VALUE returns in the response BODY (not a header), so
 * this reuses `postOperation`. The worker MUST branch on the body's `outcome` — a `denied` outcome
 * is also HTTP 200 (server: `worker-control.ts` `denyMalformed`), so a status check would fail OPEN.
 */
export const EXECUTION_SECRET_RESOLVE_PATH = "/api/worker-control/execution-secrets/resolve";

/** Local descriptor for the resolve request. Mirrors the server descriptor
 * (`services/execution-secret-resolve.ts` EXECUTION_SECRET_RESOLVE_DESCRIPTOR): 4 KiB / 10s. */
export const EXECUTION_SECRET_RESOLVE_DESCRIPTOR = Object.freeze({
  maxRequestBytes: 4 * 1024,
  timeoutMs: 10_000,
});

/**
 * The lease-ack route path for `leaseId`. The device proof MUST be signed over
 * this EXACT string — it is the request path the server verifies against
 * (`req.originalUrl`). `leaseId` is a UUID, so encoding is a no-op, but we encode
 * defensively so a stray character can never break out of the path segment.
 */
export function leaseAckPath(leaseId: string): string {
  return `${LEASE_ACK_BASE_PATH}/${encodeURIComponent(leaseId)}/ack`;
}

/**
 * The lease-RENEW route path for `leaseId` (audience `worker_run`, WRK-005). The
 * device proof is signed over this EXACT string, exactly as `leaseAckPath`. It
 * shares the ack base but a distinct `/renew` action so the server can route the
 * frozen `lease_renew` op separately from `lease_ack`.
 */
export function leaseRenewPath(leaseId: string): string {
  return `${LEASE_ACK_BASE_PATH}/${encodeURIComponent(leaseId)}/renew`;
}

export type ControlPlaneTransportErrorKind = "timeout" | "network" | "request_too_large";

/** A transport-layer failure (no HTTP status) — retryable via backoff. */
export class ControlPlaneTransportError extends Error {
  constructor(
    public readonly kind: ControlPlaneTransportErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneTransportError";
  }
}

export interface EnrollHttpRequest {
  readonly bytes: Buffer;
  readonly enrollmentCode: string;
  /** The five `aoa-device-*` proof headers from `signDeviceProof`. */
  readonly proofHeaders: Readonly<Record<string, string>>;
  /** Optional `aoa-device-request-id` echo (tracing). */
  readonly requestId?: string;
}

export interface EnrollHttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly sessionHeader: string | null;
}

/**
 * A dual-authenticated worker operation request (poll / lease_ack). The caller
 * signs the device proof over the operation's EXACT path + these exact `bytes`
 * and presents the stored `aoa-worker-session` as the Bearer token; the server
 * verifies BOTH (`verifyWorkerOperationProof`) and binds the proof's device
 * thumbprint to the session's. HTTP method/path/status live HERE, out of the
 * frozen protocol package.
 */
export interface WorkerOperationHttpRequest {
  readonly bytes: Buffer;
  /** The opaque `aoa-worker-session` token → `authorization: Bearer <token>`. */
  readonly sessionToken: string;
  /** The five `aoa-device-*` proof headers from `signDeviceProof`. */
  readonly proofHeaders: Readonly<Record<string, string>>;
  /** Optional `aoa-device-request-id` echo (tracing). */
  readonly requestId?: string;
}

export interface WorkerOperationHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * A renewal response (WRK-010 slice 2). Like a dual-authed operation on the way OUT (Bearer
 * session + device proof), but like enroll on the way BACK: the NEW session token arrives in
 * the `aoa-worker-session` HEADER, so — unlike `postOperation` — this response carries it.
 */
export interface SessionRenewHttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly sessionHeader: string | null;
}

export interface ControlPlaneClient {
  /** The enroll path the proof must be signed over (equals the request path). */
  readonly path: string;
  /** The poll path the proof must be signed over (equals the request path). */
  readonly pollPath: string;
  /** The quarantine grant path (audience `device_session`; PROVISIONAL, WRK-005). */
  readonly quarantineGrantPath: string;
  /** The quarantine finalize path (audience `device_session`; PROVISIONAL, WRK-005). */
  readonly quarantineFinalizePath: string;
  /** The event-upload path the proof must be signed over (equals the request path, WRK-006). */
  readonly eventUploadPath: string;
  /** The artifact-commit path the proof must be signed over (CLI-003/D4). */
  readonly artifactCommitPath: string;
  /** The artifact-transfer-grant path the proof must be signed over (CLI-003/D4). */
  readonly artifactTransferGrantPath: string;
  /** The self-model read path the proof must be signed over (WRK-008 slice 2, LOCAL op). */
  readonly selfModelReadPath: string;
  /** The session-renewal path the proof must be signed over (WRK-010 slice 2, LOCAL op). */
  readonly sessionRenewPath: string;
  /** The self-hello-refresh path the proof must be signed over (WRK-011, LOCAL op). */
  readonly selfHelloRefreshPath: string;
  /** The execution-secret resolve path the proof must be signed over (DAT-008 slice 5, LOCAL op). */
  readonly executionSecretResolvePath: string;
  /** The heartbeat path the proof must be signed over (Wave-4 session-lifetime, LOCAL op). */
  readonly heartbeatPath: string;
  /** The lease-ack path for `leaseId` (the proof must be signed over it). */
  leaseAckPath(leaseId: string): string;
  /** The lease-renew path for `leaseId` (the proof must be signed over it, WRK-005). */
  leaseRenewPath(leaseId: string): string;
  enroll(request: EnrollHttpRequest): Promise<EnrollHttpResponse>;
  /** POST a signed poll request (audience `worker_poll`, 64 KiB / 30s). */
  poll(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse>;
  /** POST a signed lease ACK to `:leaseId` (audience `worker_run`, 64 KiB / 15s). */
  leaseAck(leaseId: string, request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse>;
  /** POST a signed lease RENEW to `:leaseId` (audience `worker_run`, 64 KiB / 15s, WRK-005). */
  leaseRenew(leaseId: string, request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse>;
  /** POST a device-authenticated quarantine grant request (audience `device_session`,
   * 64 KiB / 15s, WRK-005). Survives lease loss — it is NOT a lease grant. */
  quarantineGrant(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse>;
  /** POST a device-authenticated quarantine finalize (audience `device_session`,
   * 256 KiB / 15s, WRK-005). */
  quarantineFinalize(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse>;
  /** POST a signed event batch (audience `worker_run`, 4 MiB / 30s, WRK-006). */
  eventUpload(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse>;
  /** POST a signed artifact commit (audience `worker_run`, 256 KiB / 15s, CLI-003/D4). */
  artifactCommit(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse>;
  /** POST the frozen `control_command` ACK (JOB-015). */
  controlAck(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse>;
  /** POST a signed artifact transfer grant (audience `worker_run`, 64 KiB / 15s, CLI-003/D4). */
  artifactTransferGrant(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse>;
  /** POST a device-authenticated read of this worker's own self-model (LOCAL op, 64 KiB / 15s).
   * A 304 is a legitimate outcome (the caller sent a matching `knownSelfModelHash`). */
  selfModelRead(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse>;
  /** POST a device-proof session RENEWAL (LOCAL op, 2 KiB / 10s, WRK-010 slice 2). Presents the
   * live session as Bearer + a fresh device proof; on 200 the NEW session token is in the
   * `aoa-worker-session` response header. */
  sessionRenew(request: WorkerOperationHttpRequest): Promise<SessionRenewHttpResponse>;
  /** POST a device-proof self-hello REFRESH (LOCAL op, 64 KiB / 15s, WRK-011). Presents the
   * live session as Bearer + a fresh device proof; on 200 the NEW session token is in the
   * `aoa-worker-session` response header (like renewal). A 204 means the refresh was a no-op. */
  selfHelloRefresh(request: WorkerOperationHttpRequest): Promise<SessionRenewHttpResponse>;
  /** POST a device-authenticated execution-secret resolve (LOCAL op, 4 KiB / 10s, DAT-008 slice 5).
   * Presents the live session as Bearer + a fresh device proof; on 200 the body carries either
   * `{outcome:"resolved", envTarget, value}` OR `{outcome:"denied", reason}` — the caller MUST
   * branch on `outcome`, since a denial is ALSO HTTP 200. The value returns in the body (not a
   * header), so this reuses `postOperation`. */
  resolveExecutionSecret(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse>;
  /** POST a device-proof heartbeat (LOCAL op, 4 KiB / 15s, Wave-4). Presents the live session as
   * Bearer + a fresh device proof; the server seeds worker.lastSeenAt + target.lastSeenAt and
   * returns 204. Returns the HTTP status only (no session header). */
  heartbeat(request: WorkerOperationHttpRequest): Promise<{ status: number }>;
}

export interface ControlPlaneClientOptions {
  readonly baseUrl: string;
  readonly path?: string;
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Client timeout for enroll; defaults to the enrollment descriptor's 15s. */
  readonly timeoutMs?: number;
  /** Client timeout for poll; defaults to the poll descriptor's 30s. */
  readonly pollTimeoutMs?: number;
  /** Client timeout for lease_ack; defaults to the lease_ack descriptor's 15s. */
  readonly leaseAckTimeoutMs?: number;
  /** Client timeout for lease_renew; defaults to the lease_renew descriptor's 15s. */
  readonly leaseRenewTimeoutMs?: number;
  /** Client timeout for quarantine_grant; defaults to the descriptor's 15s. */
  readonly quarantineGrantTimeoutMs?: number;
  /** Client timeout for quarantine_finalize; defaults to the descriptor's 15s. */
  readonly quarantineFinalizeTimeoutMs?: number;
  /** Client timeout for event_upload; defaults to the event_upload descriptor's 30s. */
  readonly eventUploadTimeoutMs?: number;
  /** Client timeout for artifact_commit; defaults to the descriptor's 15s. */
  readonly artifactCommitTimeoutMs?: number;
  /** Client timeout for artifact_transfer_grant; defaults to the descriptor's 15s. */
  readonly artifactTransferGrantTimeoutMs?: number;
  /** JOB-015 control-ACK op timeout (default: the frozen `control_command` descriptor). */
  readonly controlAckTimeoutMs?: number;
  /** Client timeout for session_renew; defaults to the renewal descriptor's 10s (WRK-010 slice 2). */
  readonly sessionRenewTimeoutMs?: number;
}

export function createControlPlaneClient(opts: ControlPlaneClientOptions): ControlPlaneClient {
  const path = opts.path ?? ENROLL_PATH;
  const timeoutMs = opts.timeoutMs ?? OPERATION_DESCRIPTORS.enrollment.timeoutMs;
  const maxRequestBytes = OPERATION_DESCRIPTORS.enrollment.maxRequestBytes;
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = new URL(path, opts.baseUrl).toString();
  const pollTimeoutMs = opts.pollTimeoutMs ?? OPERATION_DESCRIPTORS.poll.timeoutMs;
  const leaseAckTimeoutMs = opts.leaseAckTimeoutMs ?? OPERATION_DESCRIPTORS.lease_ack.timeoutMs;
  const leaseRenewTimeoutMs = opts.leaseRenewTimeoutMs ?? OPERATION_DESCRIPTORS.lease_renew.timeoutMs;
  const quarantineGrantTimeoutMs = opts.quarantineGrantTimeoutMs ?? OPERATION_DESCRIPTORS.quarantine_grant.timeoutMs;
  const quarantineFinalizeTimeoutMs =
    opts.quarantineFinalizeTimeoutMs ?? OPERATION_DESCRIPTORS.quarantine_finalize.timeoutMs;
  const eventUploadTimeoutMs = opts.eventUploadTimeoutMs ?? OPERATION_DESCRIPTORS.event_upload.timeoutMs;
  const artifactCommitTimeoutMs = opts.artifactCommitTimeoutMs ?? OPERATION_DESCRIPTORS.artifact_commit.timeoutMs;
  const artifactTransferGrantTimeoutMs =
    opts.artifactTransferGrantTimeoutMs ?? OPERATION_DESCRIPTORS.artifact_transfer_grant.timeoutMs;
  const controlAckTimeoutMs = opts.controlAckTimeoutMs ?? OPERATION_DESCRIPTORS.control_command.timeoutMs;
  const sessionRenewTimeoutMs = opts.sessionRenewTimeoutMs ?? SESSION_RENEW_DESCRIPTOR.timeoutMs;
  const selfHelloTimeoutMs = SELF_HELLO_DESCRIPTOR.timeoutMs;
  const heartbeatTimeoutMs = HEARTBEAT_DESCRIPTOR.timeoutMs;

  /** POST a dual-authed worker operation (poll / lease_ack / lease_renew /
   * quarantine_*); classify transport failures the same way the enroll path does
   * (timeout vs network). The device-session quarantine ops reuse this exact
   * signed-bytes + proof-header path; only the audience literal + auth binding
   * differ (server-side, E5/DAT). */
  async function postOperation(
    operation:
      | "poll"
      | "lease_ack"
      | "lease_renew"
      | "quarantine_grant"
      | "quarantine_finalize"
      | "event_upload"
      | "artifact_commit"
      | "artifact_transfer_grant"
      | "self_model_read"
      | "execution_secret_resolve"
      // JOB-015 — the worker's ACK upload rides the frozen `control_command` op.
      | "control_command",
    targetPath: string,
    perOpTimeoutMs: number,
    maxBytes: number,
    request: WorkerOperationHttpRequest,
  ): Promise<WorkerOperationHttpResponse> {
    if (request.bytes.byteLength > maxBytes) {
      throw new ControlPlaneTransportError(
        "request_too_large",
        `${operation} request exceeds the ${maxBytes}-byte descriptor ceiling`,
      );
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${request.sessionToken}`,
      ...request.proofHeaders,
    };
    if (request.requestId !== undefined) {
      headers[WORKER_CONTROL_HEADERS.requestId] = request.requestId;
    }
    let response: Response;
    try {
      response = await doFetch(new URL(targetPath, opts.baseUrl).toString(), {
        method: "POST",
        headers,
        body: new Uint8Array(request.bytes),
        signal: AbortSignal.timeout(perOpTimeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ControlPlaneTransportError("timeout", `${operation} request timed out`);
      }
      throw new ControlPlaneTransportError("network", `${operation} request transport failure`);
    }
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  }

  return {
    path,
    pollPath: POLL_PATH,
    quarantineGrantPath: QUARANTINE_GRANT_PATH,
    quarantineFinalizePath: QUARANTINE_FINALIZE_PATH,
    eventUploadPath: EVENT_UPLOAD_PATH,
    artifactCommitPath: ARTIFACT_COMMIT_PATH,
    artifactTransferGrantPath: ARTIFACT_TRANSFER_GRANT_PATH,
    selfModelReadPath: SELF_MODEL_READ_PATH,
    sessionRenewPath: SESSION_RENEW_PATH,
    selfHelloRefreshPath: SELF_HELLO_PATH,
    heartbeatPath: HEARTBEAT_PATH,
    executionSecretResolvePath: EXECUTION_SECRET_RESOLVE_PATH,
    leaseAckPath,
    leaseRenewPath,
    resolveExecutionSecret(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse> {
      return postOperation(
        "execution_secret_resolve",
        EXECUTION_SECRET_RESOLVE_PATH,
        EXECUTION_SECRET_RESOLVE_DESCRIPTOR.timeoutMs,
        EXECUTION_SECRET_RESOLVE_DESCRIPTOR.maxRequestBytes,
        request,
      );
    },
    selfModelRead(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse> {
      return postOperation(
        "self_model_read",
        SELF_MODEL_READ_PATH,
        SELF_MODEL_READ_DESCRIPTOR.timeoutMs,
        SELF_MODEL_READ_DESCRIPTOR.maxRequestBytes,
        request,
      );
    },
    async sessionRenew(request: WorkerOperationHttpRequest): Promise<SessionRenewHttpResponse> {
      // Dual-authed like poll on the way out (Bearer session + device proof), but the NEW
      // session arrives in the response HEADER like enroll — so this reads that header rather
      // than reusing `postOperation`, which discards it.
      if (request.bytes.byteLength > SESSION_RENEW_DESCRIPTOR.maxRequestBytes) {
        throw new ControlPlaneTransportError(
          "request_too_large",
          `session_renew request exceeds the ${SESSION_RENEW_DESCRIPTOR.maxRequestBytes}-byte descriptor ceiling`,
        );
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${request.sessionToken}`,
        ...request.proofHeaders,
      };
      if (request.requestId !== undefined) {
        headers[WORKER_CONTROL_HEADERS.requestId] = request.requestId;
      }
      let response: Response;
      try {
        response = await doFetch(new URL(SESSION_RENEW_PATH, opts.baseUrl).toString(), {
          method: "POST",
          headers,
          body: new Uint8Array(request.bytes),
          signal: AbortSignal.timeout(sessionRenewTimeoutMs),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          throw new ControlPlaneTransportError("timeout", "session_renew request timed out");
        }
        throw new ControlPlaneTransportError("network", "session_renew request transport failure");
      }
      const sessionHeader = response.headers.get(WORKER_CONTROL_HEADERS.session);
      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, body, sessionHeader };
    },
    async selfHelloRefresh(request: WorkerOperationHttpRequest): Promise<SessionRenewHttpResponse> {
      // Dual-authed like poll on the way out (Bearer session + device proof), but the NEW
      // session arrives in the response HEADER like renewal — so this reads that header rather
      // than reusing `postOperation`, which discards it. Same shape as `sessionRenew`.
      if (request.bytes.byteLength > SELF_HELLO_DESCRIPTOR.maxRequestBytes) {
        throw new ControlPlaneTransportError(
          "request_too_large",
          `self_hello_refresh request exceeds the ${SELF_HELLO_DESCRIPTOR.maxRequestBytes}-byte descriptor ceiling`,
        );
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${request.sessionToken}`,
        ...request.proofHeaders,
      };
      if (request.requestId !== undefined) {
        headers[WORKER_CONTROL_HEADERS.requestId] = request.requestId;
      }
      let response: Response;
      try {
        response = await doFetch(new URL(SELF_HELLO_PATH, opts.baseUrl).toString(), {
          method: "POST",
          headers,
          body: new Uint8Array(request.bytes),
          signal: AbortSignal.timeout(selfHelloTimeoutMs),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          throw new ControlPlaneTransportError("timeout", "self_hello_refresh request timed out");
        }
        throw new ControlPlaneTransportError("network", "self_hello_refresh request transport failure");
      }
      const sessionHeader = response.headers.get(WORKER_CONTROL_HEADERS.session);
      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, body, sessionHeader };
    },
    async heartbeat(request: WorkerOperationHttpRequest): Promise<{ status: number }> {
      // Dual-authed like poll (Bearer session + device proof). The server returns 204 and no
      // session header, so this needs only the status — it does not reuse `postOperation`
      // (which parses a body) nor read a session header (like selfHelloRefresh).
      if (request.bytes.byteLength > HEARTBEAT_DESCRIPTOR.maxRequestBytes) {
        throw new ControlPlaneTransportError(
          "request_too_large",
          `heartbeat request exceeds the ${HEARTBEAT_DESCRIPTOR.maxRequestBytes}-byte descriptor ceiling`,
        );
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${request.sessionToken}`,
        ...request.proofHeaders,
      };
      if (request.requestId !== undefined) {
        headers[WORKER_CONTROL_HEADERS.requestId] = request.requestId;
      }
      let response: Response;
      try {
        response = await doFetch(new URL(HEARTBEAT_PATH, opts.baseUrl).toString(), {
          method: "POST",
          headers,
          body: new Uint8Array(request.bytes),
          signal: AbortSignal.timeout(heartbeatTimeoutMs),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          throw new ControlPlaneTransportError("timeout", "heartbeat request timed out");
        }
        throw new ControlPlaneTransportError("network", "heartbeat request transport failure");
      }
      return { status: response.status };
    },
    poll(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse> {
      return postOperation("poll", POLL_PATH, pollTimeoutMs, OPERATION_DESCRIPTORS.poll.maxRequestBytes, request);
    },
    leaseAck(leaseId: string, request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse> {
      return postOperation(
        "lease_ack",
        leaseAckPath(leaseId),
        leaseAckTimeoutMs,
        OPERATION_DESCRIPTORS.lease_ack.maxRequestBytes,
        request,
      );
    },
    leaseRenew(leaseId: string, request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse> {
      return postOperation(
        "lease_renew",
        leaseRenewPath(leaseId),
        leaseRenewTimeoutMs,
        OPERATION_DESCRIPTORS.lease_renew.maxRequestBytes,
        request,
      );
    },
    quarantineGrant(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse> {
      return postOperation(
        "quarantine_grant",
        QUARANTINE_GRANT_PATH,
        quarantineGrantTimeoutMs,
        OPERATION_DESCRIPTORS.quarantine_grant.maxRequestBytes,
        request,
      );
    },
    quarantineFinalize(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse> {
      return postOperation(
        "quarantine_finalize",
        QUARANTINE_FINALIZE_PATH,
        quarantineFinalizeTimeoutMs,
        OPERATION_DESCRIPTORS.quarantine_finalize.maxRequestBytes,
        request,
      );
    },
    eventUpload(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse> {
      return postOperation(
        "event_upload",
        EVENT_UPLOAD_PATH,
        eventUploadTimeoutMs,
        OPERATION_DESCRIPTORS.event_upload.maxRequestBytes,
        request,
      );
    },
    artifactCommit(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse> {
      return postOperation(
        "artifact_commit",
        ARTIFACT_COMMIT_PATH,
        artifactCommitTimeoutMs,
        OPERATION_DESCRIPTORS.artifact_commit.maxRequestBytes,
        request,
      );
    },
    controlAck(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse> {
      return postOperation(
        "control_command",
        CONTROL_ACK_PATH,
        controlAckTimeoutMs,
        OPERATION_DESCRIPTORS.control_command.maxRequestBytes,
        request,
      );
    },
    artifactTransferGrant(request: WorkerOperationHttpRequest): Promise<WorkerOperationHttpResponse> {
      return postOperation(
        "artifact_transfer_grant",
        ARTIFACT_TRANSFER_GRANT_PATH,
        artifactTransferGrantTimeoutMs,
        OPERATION_DESCRIPTORS.artifact_transfer_grant.maxRequestBytes,
        request,
      );
    },
    async enroll(request: EnrollHttpRequest): Promise<EnrollHttpResponse> {
      if (request.bytes.byteLength > maxRequestBytes) {
        throw new ControlPlaneTransportError(
          "request_too_large",
          `enrollment request exceeds the ${maxRequestBytes}-byte descriptor ceiling`,
        );
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
        [WORKER_CONTROL_HEADERS.enrollmentCode]: request.enrollmentCode,
        ...request.proofHeaders,
      };
      if (request.requestId !== undefined) {
        headers[WORKER_CONTROL_HEADERS.requestId] = request.requestId;
      }

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers,
          // A plain Uint8Array view (not a branded Buffer) satisfies `BodyInit`
          // and sends the exact signed bytes byte-for-byte.
          body: new Uint8Array(request.bytes),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          throw new ControlPlaneTransportError("timeout", "enrollment request timed out");
        }
        throw new ControlPlaneTransportError("network", "enrollment request transport failure");
      }

      const sessionHeader = response.headers.get(WORKER_CONTROL_HEADERS.session);
      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, body, sessionHeader };
    },
  };
}
