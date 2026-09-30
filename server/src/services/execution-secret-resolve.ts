// server/src/services/execution-secret-resolve.ts
//
// DAT-008 slice 4 — the sandbox-local execution-secret RESOLVE surface.
//
// This is the boot root the DAT-004 broker never had: `resolveExecutionSecret` is a
// shipped, hardened, fence-first mutator whose only constructor chain
// (`createFenceAwareEgressProxy` -> `createSecretBrokerService`) has zero callers, so
// none of it has ever run. The route in `worker-control.ts` calls THIS, which calls
// the broker, which calls that mutator.
//
// The operation is NOT a frozen wire op. `WORKER_PROTOCOL_OPERATIONS` is a closed list
// of ten and E4-D02 forbids extending it; E4's own WRK-005 non-goals assign "the live
// secret-materialization transport ops and their server routes" to E5/DAT, and
// DAT-004/DAT-005 already declared their request shapes "Not a frozen wire op". So the
// descriptor below is LOCAL — but it exists, because every other worker route gets its
// audience, size ceiling and timeout from a frozen descriptor and a route without one
// silently has none of them.
//
// TWO refusals are load-bearing, and both are enforced HERE rather than only at mint:
//
//   1. Only `env` + `sandbox_local_only` may be redeemed on this channel. A
//      `fence_proxy` handle's value is rendered into request headers inside the egress
//      proxy and must NEVER reach a worker. Because the check lives at the transport,
//      a handle minted wrong — or minted later by another ticket — still cannot leak
//      through this door.
//   2. A `device_handoff` outcome is refused, not coerced. `device_local` returns a
//      descriptor with NO value; treating a missing value as an empty one would hand a
//      sandbox an empty credential and turn a hard authorization boundary into a
//      confusing runtime failure.
//
// Every refusal is the broker's coarse, non-disclosing vocabulary. A caller learns that
// the resolve was refused, never which invariant it tripped.

import { z } from "zod";
import type { AuthAudience } from "@armyofagents/worker-protocol";
import type { OwnedLabelsCapability } from "@armyofagents/provider-capability";
import type { SecretResolveOutcome } from "./secret-broker.js";

/**
 * The request shape. Not a frozen wire op — the same declaration DAT-004's
 * `SecretResolveRequestV1` and DAT-005's `EgressRequestV1` already make. `.strict()`
 * so an unknown field is a rejection rather than something silently ignored, and the
 * audience is pinned by literal exactly as the frozen operations pin theirs.
 */
export const executionSecretResolveRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    audience: z.literal("worker_run"),
    correlationId: z.string().min(1).max(200),
    workerId: z.string().min(1),
    jobId: z.string().uuid(),
    attempt: z.number().int().positive(),
    leaseId: z.string().uuid(),
    fenceToken: z.string().min(1),
    handleId: z.string().uuid(),
  })
  .strict();
export type ExecutionSecretResolveRequest = z.infer<typeof executionSecretResolveRequestSchema>;

/**
 * The LOCAL descriptor for this operation. Shaped like `OperationDescriptorV1` on
 * purpose so the route reads the same way the frozen ten do, but it lives here: the
 * frozen package is not extended.
 *
 * `audience` is `worker_run` — the fence-bearing audience every other fence operation
 * uses (`artifact_commit`, `lease_ack`, `event_upload`).
 *
 * Precisely what an audience is here, since it is easy to overstate: sessions are NOT
 * audience-scoped. `verifyWorkerOperationProof` returns no audience at all, and the
 * frozen operations pin theirs as a `z.literal` on the REQUEST. Cross-route replay is
 * already prevented by the device proof, which signs over method, path and body digest.
 * The audience literal is the explicit declaration of which operation class a request
 * belongs to, and this route pins it the same way rather than omitting it.
 *
 * The protections a descriptor-less route genuinely loses are concrete: the request-size
 * ceiling, the timeout, the typed protocol-error emitter (`sendWorkerOperationProtocolError`
 * is keyed on an operation name), and this audience declaration.
 */
export const EXECUTION_SECRET_RESOLVE_DESCRIPTOR = {
  operation: "execution_secret_resolve",
  audience: "worker_run" as AuthAudience,
  idempotent: false,
  /** Six ids and a fence token; a request larger than this is not one of ours. */
  maxRequestBytes: 4 * 1024,
  timeoutMs: 10_000,
} as const;

export type ExecutionSecretResolveDenial =
  | "stale_fence"
  | "attempt_terminal"
  | "target_revoked"
  | "malformed";

export type ExecutionSecretResolveResult =
  | {
      readonly outcome: "resolved";
      /** The env var NAME the worker must set. */
      readonly envTarget: string;
      /** The secret VALUE. Server-side until this point; the worker holds it only
       * between here and `provider.create`, and registers it as a redaction canary. */
      readonly value: string;
      /** DEP-011 Slice 1 — the INERT owned-labels capability, passed through from the broker
       * `resolved` arm UNTOUCHED (present only when a control-plane key is configured — absent
       * today). It carries ONLY the 7 owned labels + expiry, never the `value`/fence token. */
      readonly ownedLabelsCapability?: OwnedLabelsCapability;
    }
  | { readonly outcome: "denied"; readonly reason: ExecutionSecretResolveDenial };

/**
 * Admit a broker outcome onto the sandbox-local channel, or refuse it.
 *
 * Pure, so both refusals are directly unit- and mutation-testable without a fence, a
 * database, or a route.
 */
export function admitSandboxLocalResolution(
  outcome: SecretResolveOutcome,
): ExecutionSecretResolveResult {
  if (outcome.outcome === "denied") return { outcome: "denied", reason: outcome.reason };

  // Refusal 2 — a device_local handoff carries no value and must not be coerced into one.
  if (outcome.outcome !== "resolved") return { outcome: "denied", reason: "malformed" };

  // Refusal 1 — the credential-CLASS boundary, enforced at the transport.
  if (outcome.seam !== "sandbox_local_only") return { outcome: "denied", reason: "malformed" };
  if (outcome.material.materialization !== "env") return { outcome: "denied", reason: "malformed" };

  // A sandbox-local handle may never carry a network destination. `authorizeSecretResolve`
  // enforces this already; re-checking here means a defect there cannot become a leak here.
  if (outcome.material.destination !== null) return { outcome: "denied", reason: "malformed" };

  const envTarget = outcome.material.materializationTarget;
  // Without a target the worker would not know which variable to set, and guessing
  // (or defaulting) would put a live credential somewhere nobody declared.
  if (typeof envTarget !== "string" || envTarget.length === 0) {
    return { outcome: "denied", reason: "malformed" };
  }

  // DEP-011 Slice 1 — carry the (optional) minted capability through the pure assembler
  // untouched. It is `undefined` unless the broker minted it on this sandbox-local arm.
  return { outcome: "resolved", envTarget, value: outcome.material.value, ownedLabelsCapability: outcome.ownedLabelsCapability };
}
