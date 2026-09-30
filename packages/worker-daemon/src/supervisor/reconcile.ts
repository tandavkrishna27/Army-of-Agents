/**
 * Idempotent orphan reconciliation (WRK-004).
 *
 * `reconcile` lists provider resources by OWNERSHIP LABEL (the coarse
 * org/target/worker selector), then idempotently destroys every resource NOT
 * backed by a live lease. It is safe to run repeatedly: a resource already gone
 * (or destroyed on a prior pass) is skipped, so repeated passes converge. A
 * resource that IS backed by a live lease is never touched.
 *
 * This is the worker-side orchestration around the provider's `list` +
 * `reconcile_cleanup` core ops. Provider-resource kill/cleanup against a REAL
 * provider is E6/E7; CORE reconciles against the in-process fake only.
 *
 * Runtime imports: relative modules only — the E4-D01 boundary.
 */

import { createHash } from "node:crypto";

import type { Logger } from "../logging/logger.js";
import { CLEANUP_OUTCOME_METRIC, RECONCILE_ORPHANS_METRIC, type Metrics } from "../metrics/metrics.js";
import {
  hashResourceLabels,
  type OwnershipSelector,
  type ProviderOpContext,
  type ResourceSummary,
  type SandboxProvider,
} from "./provider.js";

/**
 * The structured operator-alert event name emitted (via `logger.error`) when a
 * reconciliation sweep records ≥1 FAILED cleanup — a provider outage the swept
 * resources survive to the next bounded sweep. Reused as both the pino message
 * and a queryable `event` field. (CLI-004/D2.)
 */
export const RECONCILE_PROVIDER_OUTAGE_EVENT = "reconcile_provider_outage";

/**
 * A stable lowercase-hex SHA-256 over the canonical (org, target, worker) scope —
 * the ONLY form of the ownership selector that may enter the outage alert. Raw
 * selector VALUES never leave the supervisor (mirrors `hashResourceLabels`).
 */
function hashOwnershipSelector(selector: OwnershipSelector): string {
  const canonical = [selector.organizationId, selector.targetId, selector.workerId].join(" ");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface ReconcileDeps {
  readonly provider: SandboxProvider;
  readonly ownershipSelector: OwnershipSelector;
  /** Mints a fresh op context (deadline + STABLE-per-attempt idempotency key). */
  readonly makeCtx: () => ProviderOpContext;
  /** Orphan predicate. Default: a resource with no live lease is an orphan. */
  readonly isOrphan?: (summary: ResourceSummary) => boolean;
  readonly pageSize?: number;
  readonly metrics?: Metrics;
  readonly logger?: Logger;
}

export interface ReconcileOutcomeRecord {
  readonly sandboxId: string;
  readonly resourceLabelsHash: string;
  readonly cleanupStatus: "success" | "failed";
}

export interface ReconcileResult {
  readonly scanned: number;
  readonly orphansDestroyed: number;
  readonly orphansFailed: number;
  readonly outcomes: readonly ReconcileOutcomeRecord[];
}

const DEFAULT_PAGE_SIZE = 50;
const defaultIsOrphan = (summary: ResourceSummary): boolean => !summary.hasLiveLease;

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  const isOrphan = deps.isOrphan ?? defaultIsOrphan;
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const outcomes: ReconcileOutcomeRecord[] = [];
  let scanned = 0;
  let orphansDestroyed = 0;
  let orphansFailed = 0;

  let pageToken: string | null = null;
  do {
    const page = await deps.provider.list(
      { ownershipSelector: deps.ownershipSelector, pageSize, pageToken },
      deps.makeCtx(),
    );
    for (const summary of page.resources) {
      scanned += 1;
      if (!isOrphan(summary)) continue; // backed by a live lease — never touched
      const labelsHash = hashResourceLabels(summary.resourceLabels);
      const result = await deps.provider.reconcileCleanup(summary.sandboxId, deps.makeCtx());
      outcomes.push({ sandboxId: summary.sandboxId, resourceLabelsHash: labelsHash, cleanupStatus: result.cleanupStatus });
      if (result.cleanupStatus === "success") {
        orphansDestroyed += 1;
        deps.metrics?.inc(RECONCILE_ORPHANS_METRIC);
        deps.metrics?.inc(CLEANUP_OUTCOME_METRIC, { outcome: "success" });
      } else {
        orphansFailed += 1;
        deps.metrics?.inc(CLEANUP_OUTCOME_METRIC, { outcome: "failed" });
      }
      deps.logger?.info(
        {
          sandboxId: summary.sandboxId,
          resourceLabelsHash: labelsHash,
          providerOpId: result.providerOpId,
          cleanupStatus: result.cleanupStatus,
        },
        "reconcile: orphan cleanup",
      );
    }
    pageToken = page.nextPageToken;
  } while (pageToken !== null);

  // CLI-004/D2 — provider-outage backoff + ALERT. A sweep that reported ≥1 FAILED
  // cleanup (a transient provider/transport fault the resource survives) raises a
  // structured OPERATOR alert so "provider outage backs off with an alert" holds.
  // The BACKOFF itself is the provider's bounded retry + the resource surviving to
  // the next sweep (the live periodic delay is E4-D12); this only surfaces the
  // outage. It carries ONLY the HASHED ownership scope + the failed count — never a
  // raw org/target/worker id, command, env, or secret byte. Read-only: after the
  // sweep, it does not alter convergence.
  if (orphansFailed > 0) {
    deps.logger?.error(
      {
        event: RECONCILE_PROVIDER_OUTAGE_EVENT,
        ownershipHash: hashOwnershipSelector(deps.ownershipSelector),
        orphansFailed,
        scanned,
      },
      RECONCILE_PROVIDER_OUTAGE_EVENT,
    );
  }

  return { scanned, orphansDestroyed, orphansFailed, outcomes };
}
