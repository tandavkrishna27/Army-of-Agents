// WRK-008 slice 2b — read the worker's own self-model over the control plane.
//
// ★ NOTHING HERE THROWS. A daemon that throws on a bad server response dies instead of
// staying up inert (2a's Q3 state). Every outcome is a discriminated result the dispatch
// decision consumes (Step 4): `ok{selfModel}` or one of four coarse refusals.
//
// ★ 401/403/404 ALL COLLAPSE TO `no_profile`, deliberately. The route answers the same
// coarse code for "no such target", "never configured", "revoked" and "stale generation",
// so the worker cannot distinguish them and must not pretend it can — the route is not an
// oracle for target existence/generation/revocation.
//
// ★ session_terminal is DISTINCT from no_profile, and Step 4 depends on it: a terminal
// identity (a lapsed code route / revoked-or-replaced device — surfaced by the
// SessionProvider as SessionTerminalError) maps to `no_session`, which points the operator
// at re-enrolling THIS device, NOT at an admin for a placement profile that is fine.

import { randomBytes, randomUUID } from "node:crypto";

import type { WorkerHelloV1 } from "@armyofagents/worker-protocol";

import type { ControlPlaneClient } from "../transport/client.js";
import type { DeviceKey } from "./device-key.js";
import type { SelfModelReadResult } from "../lifecycle/compose-dispatch.js";
import { SessionTerminalError, type SessionProvider } from "../poll/poll-loop.js";
import { assembleWorkerSelfModel } from "./self-model.js";
import { signDeviceProof } from "./device-proof.js";
import type { WorkerSession } from "../enrollment/enroll.js";

/** The strict self-model read body: `{protocolVersion:1, knownSelfModelHash?}`. A full read
 * omits the known hash; the correlation id travels in the request-id header (NOT the body). */
const READ_BODY = Buffer.from(JSON.stringify({ protocolVersion: 1 }), "utf8");

export interface ReadWorkerSelfModelDeps {
  readonly client: ControlPlaneClient;
  readonly session: SessionProvider;
  readonly key: DeviceKey;
  /** The worker's own hello, carried verbatim into the assembled model's `report`. */
  readonly report: WorkerHelloV1;
  readonly sha256Fn: (bytes: Uint8Array) => string | Promise<string>;
  readonly now?: () => number;
  readonly newProofId?: () => string;
  readonly newCorrelationId?: () => string;
}

export async function readWorkerSelfModel(deps: ReadWorkerSelfModelDeps): Promise<SelfModelReadResult> {
  const now = deps.now ?? (() => Date.now());
  const newProofId = deps.newProofId ?? (() => `prf_${randomBytes(24).toString("base64url")}`);
  const newCorrelationId = deps.newCorrelationId ?? (() => randomUUID());

  const attempt = async (session: WorkerSession): Promise<{ status: number; body: unknown } | null> => {
    const correlationId = newCorrelationId();
    // Sign a FRESH proof over the SAME path the request is POSTed to. Signing a different
    // path is a 401 (the parity guard's premise), which is exactly the sixth mutant.
    const proof = signDeviceProof({
      method: "POST",
      path: deps.client.selfModelReadPath,
      rawBody: READ_BODY,
      correlationId,
      issuedAt: new Date(now()).toISOString(),
      proofId: newProofId(),
      key: deps.key,
    });
    try {
      return await deps.client.selfModelRead({
        bytes: READ_BODY,
        sessionToken: session.token,
        proofHeaders: proof.headers,
        requestId: correlationId,
      });
    } catch {
      return null; // transport failure (timeout / network) — never a throw out of here
    }
  };

  let session: WorkerSession;
  try {
    session = await deps.session.get();
  } catch (err) {
    return { kind: "refused", reason: err instanceof SessionTerminalError ? "session_terminal" : "unavailable" };
  }

  let response = await attempt(session);
  if (response === null) return { kind: "refused", reason: "unavailable" };

  if (response.status === 401) {
    // ONE recovery, then give up. A recover→retry→recover spin with no backoff is how a worker
    // hammers a control plane with a dead identity.
    let recovered: WorkerSession;
    try {
      recovered = await deps.session.recover();
    } catch (err) {
      return { kind: "refused", reason: err instanceof SessionTerminalError ? "session_terminal" : "unavailable" };
    }
    response = await attempt(recovered);
    if (response === null) return { kind: "refused", reason: "unavailable" };
  }

  if (response.status === 200) {
    const selfModel = await assembleWorkerSelfModel({
      response: response.body,
      report: deps.report,
      sha256Fn: deps.sha256Fn,
    });
    if (selfModel === null) return { kind: "refused", reason: "unassemblable" };
    return { kind: "ok", selfModel };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return { kind: "refused", reason: "no_profile" };
  }
  return { kind: "refused", reason: "unavailable" };
}
