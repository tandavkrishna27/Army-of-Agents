/**
 * JOB-015 slice (c) — the worker's control-command ACK upload.
 *
 * The mirror image of `renewLeaseOnce`: build the thin worker→server envelope the
 * service defines (there is no frozen envelope for this direction — the frozen half is
 * the ACK PAYLOAD, `controlCommandAckV1Schema`), sign a device proof over the exact
 * path + bytes, POST, classify.
 *
 * ★ THE ACK IS WHAT STOPS REDELIVERY, so the failure semantics matter more than usual.
 * Nothing here retries, and nothing here escalates a failed ACK to a lease loss: the
 * server keeps the command `ack_status IS NULL`, the next renewal redelivers it, and
 * the worker's local `applied` set stops it being applied twice. A failed ACK is
 * therefore a delay, never a lost command — which is why it may be, and is, treated as
 * best-effort by the renewal driver instead of being allowed to kill a healthy run.
 *
 * ★★ "BEST-EFFORT" HAS TO COVER A SLOW ACK, NOT ONLY A FAILED ONE — and that is a
 * property of WHERE the driver calls this, not of anything in this file. Nothing here
 * retries, but the call is awaited, the driver runs them SEQUENTIALLY, and up to
 * `CONTROL_EXTENSION_MAX_COMMANDS` = 16 run per delivery at this operation's frozen
 * 15 s timeout — 240 s of worst-case blocking against ~150 s of headroom on a 300 s
 * lease renewing at 50 % lead. So `lease-renewal.ts` arms the next renewal BEFORE the
 * apply/ACK pass. Invert that ordering and this paragraph becomes false: a control
 * plane that is merely SLOW starts losing healthy leases.
 *
 * ★ `commandSeq` IS ECHOED BECAUSE THE SERVER NOW CHECKS IT. The frozen ACK schema has
 * always carried it and its docstring always said the worker echoes it, but
 * `ackControlCommand` matched on `(organizationId, leaseId, commandId)` alone and threw
 * the sequence away — a frozen validation field the server never checked. JOB-015 adds
 * it to the mutator's WHERE clause, so an ACK naming a real command with the wrong
 * sequence now matches zero rows and the command stays pending.
 *
 * Runtime imports: `@armyofagents/worker-protocol` + `node:crypto` + relative modules.
 */

import { randomUUID } from "node:crypto";

import {
  controlCommandAckV1Schema,
  type ControlCommandAckStatus,
  type LeaseOfferV1,
} from "@armyofagents/worker-protocol";

import type { DeviceKey } from "../identity/device-key.js";
import { signDeviceProof } from "../identity/device-proof.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import {
  ControlPlaneTransportError,
  CONTROL_ACK_PATH,
  type ControlPlaneClient,
} from "../transport/client.js";

/** How ONE ACK round-trip ended. `sent` means the server accepted the upload; whether
 * it MATCHED a row is `applied` (a mismatched sequence is a legitimate `false`). */
export type ControlAckAttempt =
  | { readonly kind: "sent"; readonly applied: boolean }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "transient"; readonly label: string };

export interface SendControlAckDeps {
  readonly client: ControlPlaneClient;
  readonly session: WorkerSession;
  readonly offer: LeaseOfferV1;
  readonly key: DeviceKey;
  readonly commandId: string;
  readonly commandSeq: number;
  readonly status: ControlCommandAckStatus;
  readonly detail: string | null;
  readonly now?: () => number;
  readonly newCorrelationId?: () => string;
  readonly newProofId?: () => string;
  readonly newNonce?: () => string;
}

function defaultProofId(): string {
  return `prf_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** Send ONE control ACK. Never throws for a transport or protocol failure — an ACK that
 * does not land leaves the command pending, which is the safe direction. */
export async function sendControlAck(deps: SendControlAckDeps): Promise<ControlAckAttempt> {
  const now = deps.now ?? (() => Date.now());
  const correlationId = (deps.newCorrelationId ?? randomUUID)();
  const nonce = (deps.newNonce ?? randomUUID)();
  const observedAt = new Date(now()).toISOString();

  // Validate the frozen payload BEFORE it is signed. An ACK the server would reject as
  // malformed is a wasted round trip that looks like a delivery failure.
  const ack = controlCommandAckV1Schema.parse({
    protocolVersion: 1,
    correlationId,
    commandId: deps.commandId,
    commandSeq: deps.commandSeq,
    status: deps.status,
    observedAt,
    detail: deps.detail,
  });

  const request = {
    protocolVersion: 1 as const,
    correlationId,
    issuedAt: new Date(now()).toISOString(),
    nonce,
    audience: "worker_run" as const,
    body: {
      organizationId: String(deps.offer.job.organizationId),
      companyId: String(deps.offer.job.companyId),
      workerId: String(deps.offer.workerId),
      jobId: String(deps.offer.job.jobId),
      attempt: deps.offer.job.attempt,
      leaseId: deps.offer.leaseId,
      fenceToken: String(deps.offer.fenceToken),
      ack,
    },
  };
  const bytes = Buffer.from(JSON.stringify(request), "utf8");
  const proof = signDeviceProof({
    method: "POST",
    path: CONTROL_ACK_PATH,
    rawBody: bytes,
    correlationId,
    issuedAt: new Date(now()).toISOString(),
    proofId: (deps.newProofId ?? defaultProofId)(),
    key: deps.key,
  });

  try {
    const response = await deps.client.controlAck({
      bytes,
      sessionToken: deps.session.token,
      proofHeaders: proof.headers,
      requestId: correlationId,
    });
    if (response.status === 200) {
      const body = response.body;
      const applied =
        typeof body === "object" && body !== null && (body as { applied?: unknown }).applied === true;
      return { kind: "sent", applied };
    }
    const code =
      typeof response.body === "object"
        && response.body !== null
        && typeof (response.body as { code?: unknown }).code === "string"
        ? (response.body as { code: string }).code
        : `http_${response.status}`;
    if (response.status === 429 || response.status === 503) return { kind: "transient", label: code };
    return { kind: "refused", code };
  } catch (err) {
    if (err instanceof ControlPlaneTransportError) return { kind: "transient", label: err.kind };
    throw err;
  }
}
