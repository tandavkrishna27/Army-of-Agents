// server/src/services/secret-broker.ts
//
// DAT-004 — the lease-scoped secret broker: it maps an OPAQUE execution secret handle
// onto one of the four existing value stores and resolves the value ONLY behind an
// active, per-request fence. It is a PURE control-plane orchestrator — there is NO
// `secret_resolve` wire op (the frozen 10-op list is closed); resolution is in-band +
// behind the fence proxy. It mirrors `artifact-commit.ts` / `patch-apply.ts`'s one-tx,
// fence-first, no-early-broker-access template.
//
// Ordering + precedence (the hard invariant, mirroring the DAT-002 no-early-probe lesson):
//   1. ONE `runInTenant` tx: `resolveWorkerFenceContext` resolves the fence IDENTITY
//      first — a foreign/unresolvable fence throws `JobLeasingError` BEFORE any handle
//      row OR any broker/value store is ever touched, so neither is a cross-tenant oracle.
//   2. The guarded `resolveExecutionSecret` mutator runs `guardActiveFence` FIRST (a
//      stale/terminal/revoked fence surfaces as `stale_fence`/`attempt_terminal`/
//      `target_revoked`), then re-derives the LOCKED job owner + re-checks the owner's
//      ACTIVE company membership + re-verifies the materialization×use_policy /
//      sandbox-vs-network-destination / bound_target_generation invariants
//      (`authorizeSecretResolve`), and writes the audit-as-columns. It returns the
//      AUTHORIZED non-secret binding ONLY — NEVER a value.
//   3. ONLY AFTER the fence + authorization: dispatch by `ref_kind` to the legacy broker
//      to obtain the value, returned to the fence-aware proxy / remote-service seam —
//      NEVER onto a wire message, NEVER into the sandbox for a network-use handle.
//      `device_local` returns a HANDOFF DESCRIPTOR (no value) — the value never leaves
//      the OS keystore (DSK/E10 reads it via this descriptor).
//
// Every non-fence refusal is coarse, non-disclosing `malformed` (a resolve refusal must
// never disclose which invariant a foreign caller tripped, nor whether a foreign handle
// exists). DAT-004 BINDS the destination + authorizes + resolves; the fence-aware egress
// proxy that MATERIALIZES the value + enforces the destination is DAT-005 (non-goal here).

import type { KeyObject } from "node:crypto";

import type { AuthorizedSecretResolution, Db } from "@armyofagents/db";
import type { OwnedLabelsCapability } from "@armyofagents/provider-capability";
import {
  JobFenceError as DbJobFenceError,
  SecretResolveRejection,
  type JobFenceErrorCode,
} from "@armyofagents/db";
import { runInTenant } from "../db/tenant-context.js";
import { JobLeasingError, type VerifiedWorkerOperation } from "./job-leasing.js";
import { resolveWorkerFenceContext, type ResolvedFenceContext } from "./worker-fence-context.js";
import {
  createWorkerDenialSink,
  drainWorkerDenial,
} from "./worker-denial-audit.js";
import {
  captureFenceGuardDenial,
  createFenceGuardDenialSink,
  drainFenceGuardDenialSink,
} from "./fence-denial-audit.js";
import {
  captureSecretResolveDenial,
  createSecretResolveDenialSink,
  drainSecretResolveDenialSink,
} from "./secret-resolve-denial-audit.js";
import type { JobControlMetrics } from "./job-control-metrics.js";
import { applyOwnedLabelsCapability, OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS } from "./owned-labels-mint.js";

/** A guarded-fence refusal → the frozen protocol reason vocabulary. */
function fenceReason(code: JobFenceErrorCode): "stale_fence" | "attempt_terminal" | "target_revoked" {
  return code;
}

/** The resolve request. Not a frozen wire op — the caller presents the same complete
 * active fence as a commit plus the opaque handle id to resolve. */
export interface SecretResolveRequestV1 {
  workerId: string;
  jobId: string;
  attempt: number;
  leaseId: string;
  fenceToken: string;
  /** The opaque execution-secret handle id (the `handle` column value). */
  handleId: string;
  /** DAT-005-D3 — the network-policy version to persist in the audit UPDATE for a
   * governed egress resolve. Omitted for a non-egress resolve (column untouched). */
  appliedPolicyVersion?: number | null;
}

export type SecretDeliverySeam = "fence_proxy" | "remote_server_fenced" | "sandbox_local_only";

/**
 * The resolved secret material handed to the DAT-005 fence-aware proxy (`fence_proxy`),
 * the fenced remote service (`remote_server_fenced`), or the fenced sandbox-local
 * materializer (`sandbox_local_only`, non-network). It is an IN-PROCESS control-plane
 * handoff: it is NEVER serialized onto the worker protocol (the frozen
 * `FORBIDDEN_WIRE_KEYS` rejects any nested token) and, for a network-use handle
 * (`fence_proxy` / `remote_server_fenced`), NEVER placed into the sandbox env.
 */
export interface FenceResolvedMaterial {
  value: string;
  materialization: "proxy" | "env" | "file";
  /** DAT-008 — where the value belongs (an env-var NAME for `env`). Non-secret. */
  materializationTarget: string | null;
  /** The bound egress destination (null for a sandbox-local, non-network handle). */
  destination: string | null;
}

/**
 * `device_local`: the control-plane REFERENCE + authorization ONLY. The value never
 * leaves the OS keystore — DSK/E10 reads it via this descriptor. There is NO value
 * field here (invariant #1: device_local returns a handoff descriptor, never a value).
 */
export interface DeviceLocalHandoff {
  refKind: "device_local";
  /** For `device_local` this is `provider_credentials.id` — a uuid, never a slug. */
  refId: string;
  ownerPrincipalKind: string | null;
  ownerPrincipalId: string | null;
  materialization: "proxy" | "env" | "file";
  usePolicy: SecretDeliverySeam;
  /**
   * The LOCKED lease's company. It comes from the fence, never from the wire — a
   * consumer that had to re-derive it would be trusting the request for the one
   * fact the fence exists to pin.
   */
  companyId: string;
  /** The handle this activation is bound to, so it can be revoked by identity. */
  handleId: string;
  /** The placed generation the handle is pinned to (null = unpinned). */
  boundTargetGeneration: number | null;
  /**
   * The bound egress destination. Load-bearing on exactly the `fence_proxy` seam:
   * rule 4b guarantees it non-null for a network-use handle, and that is the seam
   * D10's `proxy_endpoint` arm exists to serve. It was dropped here while every
   * other consumer received it, which would have forced DSK-002 to widen this type
   * on day one.
   */
  destination: string | null;
}

export type SecretResolveOutcome =
  | {
      outcome: "resolved";
      seam: SecretDeliverySeam;
      material: FenceResolvedMaterial;
      /**
       * DEP-011 Slice 1 — the INERT owned-labels capability minted on the
       * `sandbox_local_only` ALLOW path when a control-plane signing key is configured
       * (`applyOwnedLabelsCapability`, `owned-labels-mint.ts`). Absent otherwise (no key,
       * or a non-sandbox-local seam). It carries ONLY the caller's 7 owned labels + expiry
       * (Decision #104 — never the redeemed `value` or the fence token). Nothing consumes
       * it yet (Slice 2). It rides the `resolved` arm out through the pure reply assembler
       * and the route JSON UNTOUCHED.
       */
      ownedLabelsCapability?: OwnedLabelsCapability;
    }
  | { outcome: "device_handoff"; handoff: DeviceLocalHandoff }
  | { outcome: "denied"; reason: "stale_fence" | "attempt_terminal" | "target_revoked" | "malformed" };

/**
 * The legacy value-store brokers the resolver dispatches to. Injected so the service is
 * testable without live secret infra, and so DAT-005 can wire the real chokepoints:
 *   - `connector_oauth` → the existing MCP-OAuth path (`mcp:oauth:<id>` company secret);
 *     the token is rendered into fence-proxy request HEADERS at delivery — never a spec.
 *   - `provider_key` / `company_secret` → `resolveSecretValue` (secrets.ts) / the
 *     provider resolver.
 * A broker is invoked ONLY after the fence + authorization admit the resolve.
 */
export interface SecretBrokerSet {
  resolveConnectorOAuth(input: { companyId: string; refId: string }): Promise<string>;
  resolveProviderOrCompanySecret(input: {
    companyId: string;
    refKind: "provider_key" | "company_secret";
    refId: string;
    /** DAT-008 — the pinned version selector for `refId`; null = latest. Non-secret. */
    refVersion: string | null;
    /** DAT-008 — the resolving handle, for the secret-access audit's consumer id. */
    handleId: string;
  }): Promise<string>;
  /**
   * DAT-007 / CLI-008 — the mint-at-resolve `run_jwt` bearer. Unlike the stores above it
   * fetches NO stored value: it MINTS a fresh agent JWT server-side (where the HS256
   * secret lives), binding `run_id` to the distributed `heartbeat_runs` row DAT-007's
   * currency gate probes so the token can never outlive the run. Fail-closed by throwing
   * (a coarse `malformed` at the wire) when no distributed run backs the job, the
   * re-derived run's agent disagrees with the handle owner, or no signing key is set.
   */
  resolveRunJwt(input: {
    /** The LOCKED lease's company (fence-derived, never the wire). */
    companyId: string;
    /** The run_jwt handle's `ref_id` = the distributed jobId; the run id is re-derived. */
    refId: string;
    /** The handle's denormalized owner (= the executing agent id), cross-checked. */
    ownerPrincipalId: string | null;
    /** The resolving handle id, for the secret-access audit's consumer id. */
    handleId: string;
  }): Promise<string>;
}

/** The default fail-closed broker set: every store throws until DAT-005 wires the real
 * chokepoints. Resolution is authorized but cannot leak a value through an unwired seam. */
export const failClosedSecretBrokers: SecretBrokerSet = {
  async resolveConnectorOAuth() {
    throw new Error("connector_oauth broker not wired (DAT-005)");
  },
  async resolveProviderOrCompanySecret() {
    throw new Error("provider/company secret broker not wired (DAT-005)");
  },
  async resolveRunJwt() {
    throw new Error("run_jwt broker not wired (DAT-007/CLI-008)");
  },
};

/**
 * Dispatch an AUTHORIZED resolution to its legacy broker + delivery seam. PURE of the
 * fence/DB layer (it runs AFTER the fenced authorization), so it is unit-testable
 * directly. `device_local` short-circuits to a handoff descriptor (NO value) BEFORE any
 * broker is touched — the value stays in the OS keystore regardless of its use policy.
 */
export async function dispatchResolvedSecret(
  authorized: AuthorizedSecretResolution,
  brokers: SecretBrokerSet,
): Promise<SecretResolveOutcome> {
  // device_local: never resolve a value — return the control-plane handoff descriptor.
  if (authorized.refKind === "device_local") {
    return {
      outcome: "device_handoff",
      handoff: {
        refKind: "device_local",
        refId: authorized.refId,
        ownerPrincipalKind: authorized.ownerPrincipalKind,
        ownerPrincipalId: authorized.ownerPrincipalId,
        materialization: authorized.materialization,
        usePolicy: authorized.usePolicy,
        // A pure pass-through: every one of these was already on the authorized
        // resolution and was simply not copied across. No new query, no new read.
        companyId: authorized.companyId,
        handleId: authorized.handleId,
        boundTargetGeneration: authorized.boundTargetGeneration,
        destination: authorized.destination,
      },
    };
  }

  let value: string;
  if (authorized.refKind === "run_jwt") {
    // Mint-at-resolve: the run_jwt handle stores no value. The broker mints a fresh agent
    // JWT server-side, binding run_id to the distributed heartbeat_runs row DAT-007 probes.
    value = await brokers.resolveRunJwt({
      companyId: authorized.companyId,
      refId: authorized.refId,
      ownerPrincipalId: authorized.ownerPrincipalId,
      handleId: authorized.handleId,
    });
  } else if (authorized.refKind === "connector_oauth") {
    value = await brokers.resolveConnectorOAuth({ companyId: authorized.companyId, refId: authorized.refId });
  } else {
    // provider_key | company_secret
    value = await brokers.resolveProviderOrCompanySecret({
      companyId: authorized.companyId,
      refKind: authorized.refKind,
      refId: authorized.refId,
      refVersion: authorized.refVersion,
      handleId: authorized.handleId,
    });
  }

  return {
    outcome: "resolved",
    seam: authorized.usePolicy,
    material: {
      value,
      materialization: authorized.materialization,
      materializationTarget: authorized.materializationTarget,
      destination: authorized.destination,
    },
  };
}

export function createSecretBrokerService(input: {
  appDb: Db;
  brokers?: SecretBrokerSet;
  maxHeartbeatAgeMs?: number;
  /** DEP-007 — count-only, id-free secret-read telemetry. Emits ONLY the resolve
   * OUTCOME token (resolved | device_handoff | denied) — never a value, ref, host, or
   * destination (invariant #7). Defaults to no-op; best-effort, never alters resolve. */
  metrics?: JobControlMetrics;
  /** DEP-011 Slice 1 — the control-plane Ed25519 PRIVATE key used to MINT the inert
   * owned-labels capability on the `sandbox_local_only` ALLOW reply. Absent (the default
   * today — no real keypair until deploy/Slice 5) ⇒ the capability is OMITTED and the
   * resolve is byte-identical to pre-DEP-011. A TEST keypair is injected in the component. */
  controlPlaneSigningKey?: KeyObject;
  /** DEP-011 Slice 1 — the capability TTL ceiling (clamped to the lease deadline). */
  ownedLabelsCapabilityTtlMs?: number;
}) {
  const brokers = input.brokers ?? failClosedSecretBrokers;
  const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300_000);
  // Optional-chained (no NOOP VALUE import) so this inert-seam module carries no
  // runtime dependency on job-control-metrics on any load path (dormancy gate).
  const metrics = input.metrics;
  const controlPlaneSigningKey = input.controlPlaneSigningKey;
  const ownedLabelsCapabilityTtlMs = input.ownedLabelsCapabilityTtlMs ?? OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS;

  return {
    async resolve(resolveInput: {
      auth: VerifiedWorkerOperation;
      request: SecretResolveRequestV1;
    }): Promise<SecretResolveOutcome> {
      const { auth, request } = resolveInput;
      if (request.workerId !== auth.workerId) throw new JobLeasingError("unauthorized");

      // DEP-011 Slice 1 — the device-proof-verified fence context, captured out of the tenant-tx
      // closure so the MINT can read it at the finalize point (§1.2). It is set ONLY after
      // `resolveWorkerFenceContext` succeeds; a fence auth failure throws out of `runInTenant`
      // (the route maps it to a coarse denial) and leaves this undefined, so no capability is minted.
      let fenceCtx: ResolvedFenceContext | undefined;

      // ★ DE-06 — THE FIRST DENIAL RECORD ON THIS SERVICE. Before this, a refused
      // secret resolve left only the count-only `metrics.secretRead({outcome:"denied"})`
      // tick that `E0-F013` files against DE-29 as forensically indistinguishable.
      // This holder now covers ALL SIX throw sites inside `resolveWorkerFenceContext`
      // — the tuple-integrity branch with an FK-valid company, the other five with a
      // token-attested organization and a null company (`worker-denial-audit.ts`;
      // `E0-F013` Decision 2 (a2) made the latter storable). An earlier version of
      // this comment said the other five were still unaudited; that is no longer true.
      // The `{ denied: … }` returns below now have their own recorders too — the two
      // sinks declared under this one — so an earlier "STILL UNAUDITED" note here is
      // also no longer true. STILL UNRECORDED, deliberately: the top-of-function
      // `workerId !== auth.workerId` throw (a malformed request, pre-auth, with no
      // fence in hand) and the post-broker coarse `malformed` on a broker FETCH
      // failure (an infra fault after an ADMITTED resolve, not a refusal).
      const fenceDenial = createWorkerDenialSink();
      // ★ DE-04 / DE-18 + DE-29 — the two refusal classes the guarded mutator can
      // take AFTER the fence context resolves, each captured at the inner catch
      // (the refusal is converted to a coarse wire outcome there, so an outer
      // catch can never type it) and drained on the pool handle in the `.finally`
      // below. `resolveWorkerFenceContext` deliberately does NOT gate on the
      // fence being ACTIVE, so `guardActiveFence` inside `resolveExecutionSecret`
      // genuinely refuses in production — an expired lease resolving late is a
      // `stale_fence` here, not at the pre-check.
      const fenceGuardDenial = createFenceGuardDenialSink();
      const resolveDenial = createSecretResolveDenialSink();

      // Fence identity + authorization inside ONE tenant tx, BEFORE any broker access.
      const authorized = await runInTenant(input.appDb, auth.organizationId, async (repos):
        Promise<AuthorizedSecretResolution | { denied: SecretResolveOutcome & { outcome: "denied" } }> => {
        const ctx = await resolveWorkerFenceContext(repos, auth, {
          leaseId: request.leaseId,
          jobId: request.jobId,
          attempt: request.attempt,
          fenceToken: request.fenceToken,
        }, maxHeartbeatAgeMs, fenceDenial);
        fenceCtx = ctx;
        try {
          return await repos.jobControl.resolveExecutionSecret({
            ...ctx.fenceIdentity,
            handle: request.handleId,
            appliedPolicyVersion: request.appliedPolicyVersion,
          });
        } catch (error) {
          if (error instanceof DbJobFenceError) {
            captureFenceGuardDenial(fenceGuardDenial, ctx.fenceIdentity, error);
            return { denied: { outcome: "denied", reason: fenceReason(error.code) } };
          }
          if (error instanceof SecretResolveRejection) {
            // Coarse + non-disclosing ON THE WIRE: never reveal which invariant
            // tripped. The audit row records the real reason (capture above the
            // wire coarsening — non-disclosure is a protocol property, not an
            // audit-trail one).
            captureSecretResolveDenial(resolveDenial, ctx.fenceIdentity, request.handleId, error);
            return { denied: { outcome: "denied", reason: "malformed" } };
          }
          throw error;
        }
      })
        // Drain on the POOL handle once the tenant transaction has unwound. A fence
        // refusal REJECTS `runInTenant` and skips everything below, so this has to be
        // `.finally` (whose thenable callback IS awaited) rather than a statement.
        .finally(async () => {
          await drainWorkerDenial(input.appDb, fenceDenial, {
            control: "server/src/services/worker-fence-context.ts:resolveWorkerFenceContext",
            workerId: auth.workerId,
            operation: "secret_resolve",
          });
          // ★ DE-04 / DE-18 — the governed-fence refusal (stale_fence / target_revoked /
          // attempt_terminal from resolveExecutionSecret's guardActiveFence), on the
          // pool handle.
          await drainFenceGuardDenialSink(input.appDb, fenceGuardDenial, {
            control: "server/src/services/secret-broker.ts:resolve",
            operation: "secret_resolve",
          });
          // ★ DE-29 — the owner-routing refusal (authorizeSecretResolve's verdict,
          // thrown as SecretResolveRejection), on the pool handle.
          await drainSecretResolveDenialSink(input.appDb, resolveDenial, {
            control: "server/src/services/secret-broker.ts:resolve",
          });
        });

      // Resolve to the final control-plane outcome, THEN emit the count-only outcome
      // token. A broker fetch failure is a coarse, non-disclosing `malformed` (never a
      // value leak, never a disclosing error) — e.g. an unwired seam or a broker-side
      // revocation.
      let outcome: SecretResolveOutcome;
      if ("denied" in authorized) {
        outcome = authorized.denied;
      } else {
        try {
          outcome = await dispatchResolvedSecret(authorized, brokers);
        } catch {
          outcome = { outcome: "denied", reason: "malformed" };
        }
      }

      // DEP-011 Slice 1 — mint the INERT owned-labels capability onto the
      // `resolved ∧ sandbox_local_only` reply (a no-op on every other outcome, and when no
      // control-plane key is configured — the default today). Riding the `resolved` arm, it
      // passes through the pure reply assembler + route JSON untouched. Never fails the resolve.
      if (fenceCtx) {
        outcome = applyOwnedLabelsCapability(
          outcome,
          {
            fenceIdentity: fenceCtx.fenceIdentity,
            authorityNow: fenceCtx.authorityNow,
            leaseDeadline: fenceCtx.leaseDeadline,
          },
          { controlPlaneSigningKey, shortTtlMs: ownedLabelsCapabilityTtlMs },
        );
      }

      // DEP-007 — count-only secret-read telemetry: the OUTCOME discriminant only, never
      // the value/ref/destination. Best-effort so a failing metric never alters resolve.
      try {
        metrics?.secretRead({ outcome: outcome.outcome, count: 1 });
      } catch {
        /* best-effort telemetry */
      }
      return outcome;
    },
  };
}
