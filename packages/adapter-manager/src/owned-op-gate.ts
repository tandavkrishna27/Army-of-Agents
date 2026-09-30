// -----------------------------------------------------------------------------
// DEP-012 Slice 1 · Unit B2 — the generalized server-side OWNED-OP GATE.
//
// This generalizes B1's `gateExecute` into `gateOwnedOp`, the single ownership gate
// EVERY gate-required op crosses: `execute` + the 4 teardown ops
// (cancel/kill/destroy/reconcile_cleanup) + `inspect`. Over the wire an untrusted
// worker crafts the `sandboxId` itself, so each op needs a server-side
// `#requireOwned`-equivalent before it faces >1 worker. The caller's owned labels
// arrive in a signed capability; the gate mirrors `#requireOwned`
// (cleanup-authority.ts:154-167) FIELD-FOR-FIELD.
//
// ★ THE INSPECT-CATCH MIRRORS `#requireOwned` EXACTLY (cleanup-authority.ts:158-161):
//   SandboxNotFoundError -> the UNIFORM ResourceNotAvailableError (indistinguishable
//   from a label/generation mismatch — the oracle collapse); but ANY OTHER inspect
//   fault (transient / non-NotFound) is RETHROWN as ITS OWN class, NOT collapsed. This
//   CORRECTS B1's execute-gate.ts:78-80 collapse-ALL: for the IDEMPOTENT teardown ops,
//   collapsing a transient to ResourceNotAvailableError makes `CleanupAuthority.converge`
//   (cleanup-authority.ts:300-301) read it as "vanished -> success" and LEAK the sandbox.
//   A transient is existence-orthogonal, so surfacing it distinctly stays oracle-safe.
//
// ★ `dispatch()` runs OUTSIDE the inspect-collapse `try` — a dispatch-path fault
//   (egress denied, a mid-flight not-found) propagates as ITS OWN class; only the
//   OWNERSHIP decision (verify + inspect-resolve + label/generation compare) collapses
//   to the uniform error. `dispatch` receives the ALREADY-FETCHED detail so the
//   `inspect` route can redact it WITHOUT a second provider call.
//
// worker-daemon + cleanup-authority.ts are UNTOUCHED — this is new adapter-manager code
// using only exported symbols. The redaction IMPORTS `hashResourceLabels`. The
// worker-side CleanupAuthority coexistence (the (compose) direction) is DEP-011's.
// -----------------------------------------------------------------------------

import type { KeyObject } from "node:crypto";

import type {
  InspectResult,
  ListInput,
  ProviderOpContext,
  RedactedResourceProjection,
  ResourceLabels,
  SandboxProvider,
} from "@armyofagents/worker-daemon";
import {
  ResourceNotAvailableError,
  SandboxNotFoundError,
  hashResourceLabels,
  labelsEqual,
} from "@armyofagents/worker-daemon";
import type { OwnedLabelsCapability, RedactedListResult } from "@armyofagents/provider-wire";

import { verifyOwnedLabelsCapability } from "./capability-verify.js";
import type { KeyedMutex } from "./keyed-mutex.js";

export interface OwnedOpGateDeps {
  readonly provider: SandboxProvider;
  readonly controlPlanePublicKey: KeyObject;
  /** ms-epoch clock for the capability expiry check. */
  readonly now: () => number;
  /**
   * The AM-local per-`sandboxId` TOCTOU lock (DEP-012 Slice 3 · β1). `gateOwnedOp`
   * holds it across inspect -> dispatch so THIS instance can't interleave a
   * check-time-of-use gap on one sandbox. Acquired AFTER verify (an unauthenticated
   * caller must not acquire a lock). HONESTLY PARTIAL — no cross-replica / E2B-reassign
   * reach (deploy-owed, β1.6). `gateList` has no single-sandbox target, so it is unlocked.
   */
  readonly sandboxLock: KeyedMutex;
}

/**
 * Verify a capability or throw the UNIFORM ResourceNotAvailableError. A missing
 * capability is refused exactly like an invalid one (NEVER trusted on absence — the
 * R2 fall-open). Every verify-failure cause collapses to the SAME error, so it leaks
 * nothing about the sandbox. Shared by `gateOwnedOp` and `gateList` so the fail-closed
 * posture is identical across every gate-required op.
 */
export function verifyOrUniform(
  capability: OwnedLabelsCapability | undefined,
  controlPlanePublicKey: KeyObject,
  now: number,
): ResourceLabels {
  try {
    if (capability === undefined) throw new ResourceNotAvailableError();
    return verifyOwnedLabelsCapability(capability, controlPlanePublicKey, now);
  } catch {
    throw new ResourceNotAvailableError();
  }
}

/**
 * The server-side `#redact` — an EXPLICIT 5-field literal (never a spread, so no
 * sensitive field can leak by accident). Identical to CleanupAuthority.#redact
 * (cleanup-authority.ts:169-183): the raw ownership labels become an unsalted
 * `resourceLabelsHash`, and command/env/logs/secrets/workspace/grants never appear.
 */
export function redactProjection(detail: {
  readonly sandboxId: string;
  readonly resourceLabels: ResourceLabels;
  readonly generation: number;
  readonly state: RedactedResourceProjection["state"];
  readonly providerOpId: string;
}): RedactedResourceProjection {
  return {
    sandboxId: detail.sandboxId,
    resourceLabelsHash: hashResourceLabels(detail.resourceLabels),
    generation: detail.generation,
    state: detail.state,
    providerOpId: detail.providerOpId,
  };
}

/**
 * Gate an owned single-sandbox op. Returns `dispatch(detail)` on the allow path, or
 * throws the UNIFORM ResourceNotAvailableError on ANY ownership refusal (absent/invalid
 * capability, foreign or not-found sandbox). A NON-NotFound inspect fault propagates as
 * its own class (surfaced distinctly), and so does any fault from `dispatch` itself.
 *
 * `dispatch` receives the fetched `InspectResult` so the `inspect` route can redact it
 * without re-fetching; teardown/execute dispatchers ignore it.
 */
export async function gateOwnedOp<R>(
  deps: OwnedOpGateDeps,
  sandboxId: string,
  ctx: ProviderOpContext,
  capability: OwnedLabelsCapability | undefined,
  dispatch: (detail: InspectResult) => Promise<R>,
): Promise<R> {
  const { provider, controlPlanePublicKey, now, sandboxLock } = deps;

  // 1. Verify FIRST, before any provider call AND OUTSIDE the lock (fail-closed — an
  //    unauthenticated caller must never acquire a per-sandboxId lock; the crafted
  //    sandboxId keys the lock map, so an unverified caller could otherwise grow it).
  const ownedLabels = verifyOrUniform(capability, controlPlanePublicKey, now());

  // 2. The TOCTOU lock spans inspect -> owned-check -> dispatch so THIS instance can't
  //    interleave the check-to-use gap on one sandbox. Released in runExclusive's finally
  //    (on resolve OR throw); the key evicts on drain. PARTIAL: no cross-replica / E2B
  //    TTL-reassign reach (deploy-owed, β1.6).
  //    ★ CAUTION for future dispatchers: every wired `dispatch` here is a direct
  //    `provider.*` call (never re-entering `gateOwnedOp` on the SAME sandboxId). A future
  //    dispatcher that re-entered this lock on the same key would self-deadlock — keep
  //    dispatchers non-re-entrant, or key any inner gate on a different id.
  return sandboxLock.runExclusive(sandboxId, async () => {
    // Resolve the target AM-local. MIRROR #requireOwned: SandboxNotFoundError -> the
    // uniform error; RETHROW any OTHER (transient) inspect fault as its own class.
    let detail: InspectResult;
    try {
      detail = await provider.inspect(sandboxId, ctx);
    } catch (err) {
      if (err instanceof SandboxNotFoundError) throw new ResourceNotAvailableError();
      throw err; // transient / non-NotFound — existence-orthogonal, surfaced distinctly
    }

    // Field-wise owned-check (BOTH clauses — labels AND generation). A mismatch is
    // refused IDENTICALLY to not-found.
    if (!labelsEqual(detail.resourceLabels, ownedLabels) || detail.generation !== ownedLabels.deviceGeneration) {
      throw new ResourceNotAvailableError();
    }

    // Allow — dispatch OUTSIDE the inspect-collapse try. A dispatch fault is ITS OWN class.
    return dispatch(detail);
  });
}

/**
 * Gate a `list` — a DISTINCT pattern from `gateOwnedOp` (no AM-local single inspect).
 * verify -> `provider.list` scoped to the caller's OWN coarse identity (never the
 * client-supplied selector) -> filter BOTH ownership clauses -> redact each row. Returns
 * the narrow single-tuple list of the caller's own resources only. A `provider.list`
 * fault propagates as its own class (existence-orthogonal; list is scoped to own
 * resources, so a fault reveals nothing about another tenant).
 */
export async function gateList(
  deps: OwnedOpGateDeps,
  _input: ListInput,
  ctx: ProviderOpContext,
  capability: OwnedLabelsCapability | undefined,
): Promise<RedactedListResult> {
  const { provider, controlPlanePublicKey, now } = deps;
  const ownedLabels = verifyOrUniform(capability, controlPlanePublicKey, now());

  // MIRROR CleanupAuthority.list (cleanup-authority.ts:190-205) EXACTLY: a single scoped
  // page, own rows only, NO cursor exposed. The client `_input` (pageSize/pageToken/selector)
  // is IGNORED on purpose — the scope is the capability's OWN coarse identity, and the page
  // size is fixed, so a worker can neither widen the scope nor drive pagination.
  const result = await provider.list(
    {
      ownershipSelector: {
        organizationId: ownedLabels.organizationId,
        targetId: ownedLabels.targetId,
        workerId: ownedLabels.workerId,
      },
      pageSize: 100,
    },
    ctx,
  );

  const resources = result.resources
    .filter((r) => labelsEqual(r.resourceLabels, ownedLabels) && r.generation === ownedLabels.deviceGeneration)
    .map((r): RedactedResourceProjection => redactProjection({ ...r, providerOpId: result.providerOpId }));

  // ★ nextPageToken is ALWAYS null (review skeptic F1). The provider does NOT push the
  // ownership selector into pagination (e2b-provider.ts:297-317 forwards only {pageSize,
  // pageToken}), so its real cursor walks the GLOBAL resource set and IS a foreign resource's
  // sandboxId — a cross-tenant enumeration oracle. Exposing it would leak other tenants' ids +
  // counts + ordering even though the ROWS are filtered. CleanupAuthority.list likewise exposes
  // no cursor; complete coarse-scope enumeration is the deferred reconcile / v:2 case (B2.6).
  return { providerOpId: result.providerOpId, resources, nextPageToken: null };
}
