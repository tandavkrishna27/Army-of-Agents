// -----------------------------------------------------------------------------
// DEP-011 Slice A — the pure, INERT sandbox REAPER (Option-A reclamation).
//
// The adapter-manager is the E2B key-holder and the sandbox OWNER. A worker that
// created a tenant sandbox but could NOT tear it down (its lease-bound cleanup cap
// expired — Slice 2a's honest `{outcome:"orphaned"}`) leaves an ORPHAN. This module
// is the server-local reconcile that reclaims those orphans DIRECTLY through the raw
// in-process `provider` — mirroring `create-gate.ts` `teardownLoser` and the worker
// `reconcile.ts`/`startup-reconcile.ts` precedents — NOT through the gated wire (the
// gate is for UNTRUSTED workers; the reaper is inside the trust boundary, and the AM
// holds only the control-plane PUBLIC key so it cannot mint a capability anyway).
//
// ★ THE SAFETY SPINE — POSITIVE CONFIRMATION OF DEATH. A wrong answer mass-kills LIVE
// tenant sandboxes across the whole instance (the sweep is GLOBAL — the real provider's
// `list` ignores `ownershipSelector`). So the oracle is a POSITIVE confirmed-dead set:
// a summary is reclaimed ONLY on an explicit `"orphan"` verdict. EVERY other state —
// a structurally-uninterpretable label set, an oracle "unknown", an absent map row —
// DEFAULTS to skip. There is NO negative `leaseId ∉ live-set` inference anywhere.
//
// ★ INERT BY DEFAULT. The production caller is Slice C's `startReaperLoop` — the AM bin arms
// it ONLY when `AOA_ADAPTER_MANAGER_REAPER_ENABLED=1` (unset/`0`/`false` ⇒ never called). The
// real liveness oracle (the AM→control-plane lease-truth channel) is Slice B — injected here
// as `resolveTruth` (`makeControlPlaneResolveTruth`). This function returns counts and LOGS
// them; Slice C's bin accumulates them onto the AM-local `/metrics` counter, so this module
// deliberately emits NO closed-label metric of its own (worker-daemon's `outcome` label set is
// CLOSED and would throw on `reaped`/`skipped`).
//
// Runtime imports: `@armyofagents/worker-daemon` ONLY (the abstract `SandboxProvider`
// port types + `hashResourceLabels`) — NO new dependency, so the AM boundary stays green,
// and the concrete `E2bSandboxProvider` is never named in this non-test source, so
// `check-gate-clause-wiring` keeps E7-1 at 4.
// -----------------------------------------------------------------------------

import {
  hashResourceLabels,
  type ProviderOpContext,
  type ResourceSummary,
  type SandboxProvider,
} from "@armyofagents/worker-daemon";

/**
 * The oracle's per-sandbox verdict. `"orphan"` is the ONLY verdict that authorizes a
 * reclaim, and it means POSITIVE, CONFIRMED death — a terminal lease/attempt OR a
 * confirmed superseded generation. `"live"` is a confirmed-live sandbox. `"unknown"`
 * is EVERY ambiguous state (row absent, leaseId unresolvable, query indeterminate, CP
 * unreachable) — fail closed to skip. Slice B's real oracle MUST preserve this: never
 * classify `"orphan"` on a field that can flip back to live.
 */
export type ReaperVerdict = "orphan" | "live" | "unknown";

/**
 * The injected liveness oracle (Slice B provides the real implementation). It is a
 * BATCH prefetch — ONE query over the snapshot's leaseIds — because the real channel
 * is an async control-plane round-trip. It receives ONLY structurally-valid summaries
 * (the structural pre-filter runs BEFORE it). The returned map is a POSITIVE
 * confirmed-dead set: an id it omits DEFAULTS to `"unknown"` at the call site.
 */
export type ResolveTruth = (
  summaries: readonly ResourceSummary[],
) => Promise<ReadonlyMap<string, ReaperVerdict>>;

/** The minimal pino-shaped logger the reaper writes to (no worker-daemon coupling). */
export interface ReaperLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ReconcileReaperDeps {
  /** The raw, in-process provider. The reaper touches ONLY `list` + `reconcileCleanup`
   * — the exact subset that makes it a server-local reconcile and nothing more. */
  readonly provider: Pick<SandboxProvider, "list" | "reconcileCleanup">;
  /** The injected liveness oracle (Slice B). Positive-confirmed-dead; batch. */
  readonly resolveTruth: ResolveTruth;
  /** Mints a fresh op context (deadline + idempotencyKey) for every provider op —
   * both `list(input, ctx)` and `reconcileCleanup(id, ctx)` require one. */
  readonly makeCtx: () => ProviderOpContext;
  /** ms-epoch clock (observability: sweep duration). */
  readonly now: () => number;
  readonly pageSize?: number;
  readonly logger?: ReaperLogger;
}

/**
 * The sweep tally. Disjoint over the snapshot: `reaped + failed + skipped + unknown`
 * equals the number of sandboxes scanned.
 *   - `reaped`:  an `"orphan"` whose `reconcileCleanup` reported `success` (an
 *                already-gone sandbox is an idempotent success).
 *   - `failed`:  an `"orphan"` whose `reconcileCleanup` reported `failed` (a transient
 *                fault — the LIVE sandbox SURVIVES; retried next pass) or THREW.
 *   - `skipped`: a confirmed `"live"` sandbox — never touched.
 *   - `unknown`: an oracle `"unknown"` (incl. a map-absent id) OR a structurally-invalid
 *                summary the pre-filter skipped WITHOUT consulting the oracle.
 */
export interface ReconcileReaperResult {
  readonly reaped: number;
  readonly skipped: number;
  readonly unknown: number;
  readonly failed: number;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * A placeholder ownership scope. `ListInput.ownershipSelector` is a REQUIRED field, but
 * the sole real implementation (`E2bSandboxProvider.list`) IGNORES it, so the sweep is
 * GLOBAL across all tenants. This is an IMPL behavior, not a port guarantee (a true
 * fleet-list affordance is owed — DEP-011 §R.2 F-selector); a provider that HONORED the
 * selector would list nothing here, which is fail-SAFE (nothing to reclaim → no kill).
 */
const FLEET_SELECTOR = { organizationId: "*", targetId: "*", workerId: "*" } as const;

/**
 * ★ The structural pre-filter — the mass-kill guard that needs no Slice B. A summary the
 * provider cannot coherently label is NEVER reclaimed on inference. On a metadata parse
 * failure `E2bSandboxProvider.list` defaults `resourceLabels` to `{}` (so leaseId /
 * organizationId / jobId are absent) and `generation` to the `0` sentinel — either shape
 * fails here and is skipped WITHOUT calling the oracle.
 */
function isStructurallyInterpretable(summary: ResourceSummary): boolean {
  const labels = summary.resourceLabels;
  if (!labels) return false;
  if (!labels.leaseId || !labels.organizationId || !labels.jobId) return false;
  if (summary.generation === 0) return false;
  return true;
}

/**
 * One reconcile pass. Snapshot the fleet, pre-filter, ask the oracle, reclaim ONLY the
 * confirmed orphans — each reclaim contained so no single failure aborts the sweep.
 * Inert by default: the caller is Slice C's `startReaperLoop`, armed only when the reaper
 * flag is set (`AOA_ADAPTER_MANAGER_REAPER_ENABLED=1`).
 */
export async function reconcileReaper(deps: ReconcileReaperDeps): Promise<ReconcileReaperResult> {
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const startedAt = deps.now();

  // 1. Snapshot the FULL fleet FIRST, read-only, BEFORE any destroy. The provider's page
  //    cursor is a sandboxId (`findIndex(pageToken)+1`) and `list` excludes destroyed
  //    rows, so reclaiming mid-scan would shift the cursor and skip/double-handle
  //    survivors. Snapshot, then mutate. (`startup-reconcile.ts:341-344`.)
  const summaries: ResourceSummary[] = [];
  let pageToken: string | null = null;
  do {
    const page = await deps.provider.list(
      { ownershipSelector: FLEET_SELECTOR, pageSize, pageToken },
      deps.makeCtx(),
    );
    summaries.push(...page.resources);
    pageToken = page.nextPageToken;
  } while (pageToken !== null);

  // 2. Structural pre-filter — BEFORE the oracle. Invalid summaries never reach it.
  const interpretable: ResourceSummary[] = [];
  let unknown = 0;
  for (const summary of summaries) {
    if (isStructurallyInterpretable(summary)) {
      interpretable.push(summary);
    } else {
      unknown += 1;
      deps.logger?.info(
        { sandboxId: summary.sandboxId, disposition: "unknown" },
        "reaper: skip structurally-invalid sandbox (no oracle call)",
      );
    }
  }

  // 3. The oracle — ONE batch query over the interpretable snapshot. Positive-confirmed-
  //    dead: a verdict absent from the map defaults to "unknown"/skip at the call site.
  const truth = await deps.resolveTruth(interpretable);

  // 4. Reclaim ONLY confirmed orphans; per-target containment so one failure never aborts.
  let reaped = 0;
  let skipped = 0;
  let failed = 0;
  for (const summary of interpretable) {
    const verdict: ReaperVerdict = truth.get(summary.sandboxId) ?? "unknown";
    if (verdict === "live") {
      skipped += 1;
      continue;
    }
    if (verdict !== "orphan") {
      // "unknown" (or any unexpected value) — fail closed to skip.
      unknown += 1;
      continue;
    }

    // Confirmed orphan → reclaim. Any-generation (no gate owned-check): safe because
    // `provider.create` mints a FRESH sandboxId, so a superseded-gen orphan's distinct
    // id can never be the live new-gen run.
    const labelsHash = hashResourceLabels(summary.resourceLabels);
    try {
      const result = await deps.provider.reconcileCleanup(summary.sandboxId, deps.makeCtx());
      // Read cleanupStatus: `success` (incl. already-gone, an idempotent success) → reaped;
      // a transient `failed` → the failed bucket, NEVER reaped (the LIVE sandbox survives,
      // retried next pass). Copying `teardownLoser`'s swallow-and-succeed would MASK it.
      if (result.cleanupStatus === "success") {
        reaped += 1;
      } else {
        failed += 1;
      }
      deps.logger?.info(
        {
          sandboxId: summary.sandboxId,
          resourceLabelsHash: labelsHash,
          providerOpId: result.providerOpId,
          cleanupStatus: result.cleanupStatus,
        },
        "reaper: orphan reclaim",
      );
    } catch (err) {
      failed += 1;
      deps.logger?.error(
        { sandboxId: summary.sandboxId, resourceLabelsHash: labelsHash, err },
        "reaper: orphan reclaim threw (contained; retried next pass)",
      );
    }
  }

  const result: ReconcileReaperResult = { reaped, skipped, unknown, failed };
  deps.logger?.info(
    { ...result, scanned: summaries.length, durationMs: deps.now() - startedAt },
    "reaper: sweep complete",
  );
  return result;
}
