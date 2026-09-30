/**
 * DAT-008 slice 5 — worker-side redemption of a `sandbox_local_only` / `env` secret handle.
 *
 * The lease envelope carries opaque `secretHandles[]` refs (frozen `secretHandleRefSchema`); the
 * VALUE never crosses the wire. This module turns a handle into `env[target] = value` by calling
 * the LOCAL resolve route (`ControlPlaneClient.resolveExecutionSecret`) with the run's fence + a
 * device proof, then classifying the reply and synthesising the sandbox env — FAIL CLOSED on any
 * outcome that is not a clean `resolved` with a non-empty value.
 *
 * ★ THE FAIL-OPEN TRAP. The resolve route returns HTTP 200 for BOTH a resolved value AND a denial
 * (server `denyMalformed`). A status-only check would therefore treat a denied credential as a
 * success and start the sandbox with no key. Every classifier branch here keys on the BODY's
 * `outcome`, and anything but a clean `resolved` fails the attempt.
 *
 * Runtime imports: `@armyofagents/worker-protocol` (the frozen handle type) + relative modules —
 * the E4-D01 boundary. The server's request schema is NOT importable across that boundary, so the
 * request body is built as a plain object mirroring `executionSecretResolveRequestSchema` and pinned
 * by `scripts/check-worker-path-parity.mjs` (path) + a contract test (descriptor).
 */

import { randomUUID } from "node:crypto";

import type { SecretHandleRef } from "@armyofagents/worker-protocol";

import type { DeviceKey } from "../identity/device-key.js";
import { signDeviceProof } from "../identity/device-proof.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import {
  isOwnedLabelsCapabilityShape,
  ownedLabelsCapabilityIdentity,
  type OwnedLabelsCapabilityLike,
} from "./owned-labels-capability.js";
import {
  ControlPlaneTransportError,
  type ControlPlaneClient,
  type WorkerOperationHttpResponse,
} from "../transport/client.js";

/**
 * The env-var NAMES the worker will materialise a provider credential into. `envTargetSchema`
 * (`policy.ts`) admits ANY uppercase POSIX name — it would accept `PATH`, `LD_PRELOAD`,
 * `NODE_OPTIONS` — so the worker enforces its OWN allowlist rather than trusting the mint.
 *
 * ★ Source of truth: `packages/shared/src/providers/provider-catalog.ts` (anthropic →
 * `ANTHROPIC_API_KEY`, openai → `OPENAI_API_KEY`). E4-D01 forbids importing that catalog into the
 * daemon, so this set is vendored and pinned by the contract test. CLI-001 v1 scope is
 * `claude_local` + `codex_local` only (DAT-008 §8); widen this set when that scope widens.
 */
// CLI-008 Unit C — AOA_API_KEY is the run_jwt tool-surface bearer's env target (minted at
// resolve, delivered to the sandbox env like a provider key). Added in lockstep with the
// mint (DAT-007/CLI-008 S3b) so a minted run_jwt handle is never dropped by an older worker.
export const PROVIDER_AUTH_ENV_TARGETS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AOA_API_KEY",
]);

/** The classification of ONE resolve round-trip. Only `resolved` proceeds; everything else fails
 * the attempt closed. Modelled on `RenewAttempt` (lease-renewal.ts). */
export type ResolveClassification =
  | {
      readonly kind: "resolved";
      readonly envTarget: string;
      readonly value: string;
      /**
       * DEP-011 Slice 2a — the control-plane-minted owned-labels capability the server (Slice 1)
       * now rides on the `resolved` reply. OPTIONAL + OPAQUE: read through the vendored shape-guard
       * (a malformed one is treated as ABSENT, never carried as junk), verified server-side. Absent
       * on desktop/self-hosted (no CP key) — byte-identical pre-DEP-011 behaviour.
       */
      readonly ownedLabelsCapability?: OwnedLabelsCapabilityLike;
    }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "transport" }
  | { readonly kind: "malformed" };

/** A run-fatal secret-materialisation failure. Carries a coarse, non-disclosing reason (mirrors the
 * broker's vocabulary) so a caller can log WHY without leaking the handle or value. */
export class SecretMaterializationError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? `secret materialization failed: ${reason}`);
    this.name = "SecretMaterializationError";
    this.reason = reason;
  }
}

/** A handle whose env target is not an allowlisted provider-auth name. A dropped credential would
 * surface much later as an opaque CLI auth error, so this fails the run instead (DAT-008 guard 1). */
export class UnknownSecretTargetError extends SecretMaterializationError {
  constructor(target: string) {
    super("unknown_target", `env target ${JSON.stringify(target)} is not an allowlisted provider-auth name`);
    this.name = "UnknownSecretTargetError";
  }
}

/** Redeem ONE handle → its classification. Injected so `synthesiseRunSecrets` is pure over it and
 * the client interaction is tested separately. */
export type RedeemFn = (handleId: string) => Promise<ResolveClassification>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Classify a resolve response. BOTH success and denial are HTTP 200, so this keys on the body's
 * `outcome`, never the status. A non-200, a null/shapeless body, an empty value, or an empty
 * envTarget all fail closed (`malformed`).
 */
export function classifyResolveResponse(res: WorkerOperationHttpResponse): ResolveClassification {
  if (res.status !== 200 || !isRecord(res.body)) return { kind: "malformed" };
  const body = res.body;
  if (body.outcome === "denied") {
    return { kind: "denied", reason: typeof body.reason === "string" && body.reason.length > 0 ? body.reason : "malformed" };
  }
  if (body.outcome === "resolved") {
    const envTarget = body.envTarget;
    const value = body.value;
    if (typeof envTarget === "string" && envTarget.length > 0 && typeof value === "string" && value.length > 0) {
      // DEP-011 Slice 2a — carry a PRESENT + WELL-SHAPED capability through; a malformed one is
      // treated as ABSENT (never carried as junk, never failing the resolve — it is optional).
      const cap = body.ownedLabelsCapability;
      if (isOwnedLabelsCapabilityShape(cap)) {
        return { kind: "resolved", envTarget, value, ownedLabelsCapability: cap };
      }
      return { kind: "resolved", envTarget, value };
    }
    return { kind: "malformed" }; // resolved-but-empty is not a usable credential
  }
  return { kind: "malformed" };
}

/**
 * Synthesise the sandbox env from the envelope's handles, redeeming each `env` /
 * `sandbox_local_only` handle EXACTLY ONCE. Fails the whole run (throws) on:
 *   - an env target not in the allowlist (checked BEFORE redeeming — no wasted round-trip/audit),
 *   - a response envTarget that disagrees with the handle's `materialization.target`,
 *   - any redeem outcome that is not `resolved`.
 * Other handle classes (`proxy`/`fence_proxy`, `file`, `remote_server_fenced`) are SKIPPED — this
 * slice owns only the model-provider `env` class (DAT-008 §11).
 */
export async function synthesiseRunSecrets(
  handles: readonly SecretHandleRef[],
  redeem: RedeemFn,
): Promise<{ env: Record<string, string>; canaries: string[]; capability?: OwnedLabelsCapabilityLike }> {
  const env: Record<string, string> = {};
  const canaries: string[] = [];
  // DEP-011 Slice 2a — the run mints N times (once per resolvable handle), so N caps ride the N
  // resolves. They share ONE fence identity, so their `ownedLabels`/`v`/`audience` are provably
  // identical; only `expiresAt`/`sig` can differ by a few ms. DEDUP + fail-closed on that identity
  // tuple ONLY (review MED-3): a DIVERGENT `ownedLabels` is a mint/fence bug and fails the run
  // closed; a benign ms-delta keeps the LONGER-LIVED (max `expiresAt`) cap. All-absent (desktop,
  // no CP key) → undefined, a no-op the supervisor's networked branch treats as fail-closed and the
  // desktop branch ignores.
  let capability: OwnedLabelsCapabilityLike | undefined;
  for (const handle of handles) {
    if (handle.materialization.kind !== "env" || handle.usePolicy !== "sandbox_local_only") continue;
    const target = handle.materialization.target;
    if (!PROVIDER_AUTH_ENV_TARGETS.has(target)) throw new UnknownSecretTargetError(target);
    const outcome = await redeem(handle.handleId);
    if (outcome.kind !== "resolved") throw new SecretMaterializationError(outcome.kind === "denied" ? outcome.reason : outcome.kind);
    if (outcome.envTarget !== target) {
      throw new SecretMaterializationError("target_mismatch", "resolve response env target disagrees with the handle");
    }
    env[target] = outcome.value;
    canaries.push(outcome.value);
    if (outcome.ownedLabelsCapability !== undefined) {
      capability = foldCapability(capability, outcome.ownedLabelsCapability);
    }
  }
  return capability === undefined ? { env, canaries } : { env, canaries, capability };
}

/**
 * Fold a freshly-redeemed capability into the run's accumulator: on the FIRST one, take it; on a
 * later one, its identity tuple (`ownedLabels`/`v`/`audience`) MUST match — a divergence fails the
 * run CLOSED (a mint/fence integrity failure) — and the LONGER-LIVED (`expiresAt`) survives so the
 * worker keeps the most non-expired cap for teardown.
 */
function foldCapability(
  current: OwnedLabelsCapabilityLike | undefined,
  next: OwnedLabelsCapabilityLike,
): OwnedLabelsCapabilityLike {
  if (current === undefined) return next;
  if (ownedLabelsCapabilityIdentity(current) !== ownedLabelsCapabilityIdentity(next)) {
    throw new SecretMaterializationError(
      "capability_identity_divergence",
      "two per-handle capabilities disagree on ownedLabels/v/audience — a mint/fence integrity failure",
    );
  }
  return next.expiresAt > current.expiresAt ? next : current;
}

// --- The client-backed redeemer -----------------------------------------------

/** The run's fence identity, echoed into every resolve request (the same tuple the fence ops sign). */
export interface RunFenceContext {
  readonly workerId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly leaseId: string;
  readonly fenceToken: string;
}

export interface CreateRedeemerDeps {
  readonly client: Pick<ControlPlaneClient, "resolveExecutionSecret" | "executionSecretResolvePath">;
  readonly key: DeviceKey;
  /** The live session presented as Bearer (fetched once at redemption — Sprint 2.5 keeps it fresh). */
  readonly session: WorkerSession;
  readonly fence: RunFenceContext;
  readonly now?: () => number;
  readonly newCorrelationId?: () => string;
  readonly newProofId?: () => string;
}

function defaultProofId(): string {
  return `prf_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** Build the signed request bytes for ONE handle (mirrors `executionSecretResolveRequestSchema`). */
function buildResolveRequest(deps: CreateRedeemerDeps, handleId: string): { bytes: Buffer; sessionToken: string; proofHeaders: Readonly<Record<string, string>>; requestId: string } {
  const now = deps.now ?? (() => Date.now());
  const correlationId = (deps.newCorrelationId ?? randomUUID)();
  const issuedAt = new Date(now()).toISOString();
  const body = {
    protocolVersion: 1 as const,
    audience: "worker_run" as const,
    correlationId,
    workerId: deps.fence.workerId,
    jobId: deps.fence.jobId,
    attempt: deps.fence.attempt,
    leaseId: deps.fence.leaseId,
    fenceToken: deps.fence.fenceToken,
    handleId,
  };
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  const proof = signDeviceProof({
    method: "POST",
    path: deps.client.executionSecretResolvePath,
    rawBody: bytes,
    correlationId,
    issuedAt,
    proofId: (deps.newProofId ?? defaultProofId)(),
    key: deps.key,
  });
  return { bytes, sessionToken: deps.session.token, proofHeaders: proof.headers, requestId: correlationId };
}

/**
 * A redeemer bound to one run's fence. Retries AT MOST ONCE, and ONLY on a transport error — never
 * on a denial (R7: a blind retry inflates `resolve_count` and makes it useless as a signal). A
 * denial is terminal; a second transport failure is terminal.
 */
export function createRedeemer(deps: CreateRedeemerDeps): RedeemFn {
  return async (handleId: string): Promise<ResolveClassification> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let res: WorkerOperationHttpResponse;
      try {
        const req = buildResolveRequest(deps, handleId);
        res = await deps.client.resolveExecutionSecret(req);
      } catch (err) {
        if (err instanceof ControlPlaneTransportError) {
          if (attempt === 0) continue; // one retry, transport only
          return { kind: "transport" };
        }
        throw err;
      }
      return classifyResolveResponse(res);
    }
    return { kind: "transport" };
  };
}
