import type { Db } from "@armyofagents/db";
import type { Environment, EnvironmentLease } from "@armyofagents/shared";
import { environmentService, type EnvironmentService } from "./environments.js";
import {
  environmentRuntimeService,
  normalizeEnvironmentLease,
  type EnvironmentRuntimeService,
} from "./environment-runtime.js";
import { instanceSettingsService } from "./instance-settings.js";
import { normalizeWarmIdleTtlMinutes } from "./warm-sandbox-constants.js";
import type { SandboxRuntimeProvider } from "./sandbox-provider-runtime.js";
import { logger } from "../middleware/logger.js";

/**
 * Warm-sandbox idle reaper + per-company cap eviction (Wave 6 / U7.6).
 *
 * Modeled on `workspace-ttl-sweeper.ts`: a periodic best-effort sweep that
 * destroys paused (`reuse_by_agent`) E2B snapshots left idle past the instance
 * TTL, plus the `evictOldestPausedSandbox` primitive the acquire path calls
 * when the per-company warm cap is hit. Both destroy via the SAME force-kill
 * path (`releaseRunLease({ forceDestroy: true })`, which forces
 * `reuseLease: false`) so a reaped/evicted lease is killed, never re-paused.
 */

type RuntimeKeysOption = NonNullable<Parameters<typeof environmentRuntimeService>[1]>["runtimeProviderKeys"];

export interface WarmReaperDeps {
  /** DI seam for tests: inject a stub environment service (list/get/release). */
  environments?: EnvironmentService;
  /** DI seam for tests: inject fake sandbox providers so no live E2B is hit. */
  sandboxProviders?: SandboxRuntimeProvider[];
  runtimeProviderKeys?: RuntimeKeysOption;
  /** DI seam for tests: control the reaper flag + idle TTL without a DB row. */
  getExperimental?: () => Promise<{ enableWarmSandboxReaper: boolean; warmSandboxIdleTtlMinutes: number }>;
}

function resolveDeps(db: Db, deps: WarmReaperDeps): {
  environments: EnvironmentService;
  runtime: Pick<EnvironmentRuntimeService, "releaseRunLease">;
} {
  const environments = deps.environments ?? environmentService(db);
  const runtime = environmentRuntimeService(db, {
    environments,
    sandboxProviders: deps.sandboxProviders,
    runtimeProviderKeys: deps.runtimeProviderKeys,
  });
  return { environments, runtime };
}

/** Force-kill (never re-pause) a single paused lease's sandbox and retire its
 *  DB row (status → expired). Best-effort: the environment may be gone, in which
 *  case we still retire the row so it stops being counted/resumed.
 *
 *  TOCTOU guard: the row is CLAIMED via a status-guarded compare-and-swap
 *  (`expireLeaseIfPaused`, paused → expired) BEFORE any provider kill. If a
 *  concurrent org/Commander run resumed the lease (paused → active) between the
 *  caller's scan and this destroy, the CAS matches 0 rows → returns null → we
 *  SKIP the kill and leave the now-LIVE sandbox untouched. Returns
 *  `{ destroyed }`: false = we lost the race to a concurrent resume (or a
 *  co-running destroyer), true = we own the row and killed it. */
async function destroyPausedLease(
  lease: EnvironmentLease,
  ctx: {
    environments: Pick<EnvironmentService, "get" | "releaseLease" | "expireLeaseIfPaused">;
    runtime: Pick<EnvironmentRuntimeService, "releaseRunLease">;
  },
): Promise<{ destroyed: boolean }> {
  // Claim the row FIRST. Losing this CAS means someone else (a resume, or the
  // sibling over-cap evictor) already owns it — never force-kill in that case.
  const claimed = await ctx.environments.expireLeaseIfPaused(lease.id);
  if (!claimed) {
    logger.info(
      { leaseId: lease.id, environmentId: lease.environmentId },
      "warm-sandbox reaper: lease no longer paused (concurrent resume/evict won the CAS) — skipping destroy",
    );
    return { destroyed: false };
  }

  const envRow = typeof ctx.environments.get === "function"
    ? await ctx.environments.get(lease.companyId, lease.environmentId)
    : null;
  if (!envRow) {
    await ctx.environments.releaseLease(lease.id, "expired", {
      cleanupStatus: "failed",
      failureReason: "environment missing during warm reap",
    });
    return { destroyed: true };
  }
  // releaseRunLease(forceDestroy) kills the provider sandbox AND flips the row
  // to `expired` (status passed here). We already set `expired` above via the
  // CAS; re-setting it here is idempotent/harmless.
  await ctx.runtime.releaseRunLease({
    environment: envRow as unknown as Environment,
    lease,
    status: "expired",
    forceDestroy: true,
  });
  return { destroyed: true };
}

/**
 * Destroy every paused warm sandbox left idle past the instance TTL. No-ops
 * (scans nothing) when `enableWarmSandboxReaper` is off. Per-lease best-effort:
 * one failure logs a warning and never aborts the sweep.
 */
export async function sweepIdleWarmSandboxes(
  db: Db,
  deps: WarmReaperDeps = {},
): Promise<{ scanned: number; reaped: number }> {
  const getExperimental = deps.getExperimental ?? (() => instanceSettingsService(db).getExperimental());
  const experimental = await getExperimental();
  if (!experimental.enableWarmSandboxReaper) {
    return { scanned: 0, reaped: 0 };
  }

  const { environments, runtime } = resolveDeps(db, deps);
  const ttlMinutes = normalizeWarmIdleTtlMinutes(experimental.warmSandboxIdleTtlMinutes);
  const cutoff = new Date(Date.now() - ttlMinutes * 60 * 1000);

  const stale = await environments.listPausedLeasesOlderThan(cutoff);
  let reaped = 0;
  for (const row of stale) {
    const lease = normalizeEnvironmentLease(row);
    try {
      const outcome = await destroyPausedLease(lease, { environments, runtime });
      // A skipped destroy (lost the CAS to a concurrent resume) is not a reap —
      // the live sandbox is intact and stays counted until its own run ends.
      if (outcome.destroyed) reaped++;
    } catch (err) {
      logger.warn(
        { err, leaseId: lease.id, environmentId: lease.environmentId },
        "warm-sandbox reaper: failed to destroy idle paused lease (best-effort)",
      );
    }
  }

  logger.info({ scanned: stale.length, reaped, ttlMinutes }, "Warm sandbox idle reap complete");
  return { scanned: stale.length, reaped };
}

/**
 * Evict the oldest PAUSED provider sandbox for a company (frees a warm-cap slot
 * on acquire). Never touches active leases — the acquire path proceeds anyway
 * when all live leases are active (the cap is a soft ceiling, not a run gate).
 * Returns the evicted lease, or null when there was nothing paused to evict.
 */
export async function evictOldestPausedSandbox(
  db: Db,
  companyId: string,
  deps: WarmReaperDeps = {},
): Promise<EnvironmentLease | null> {
  const { environments, runtime } = resolveDeps(db, deps);
  const live = await environments.listLiveAndPausedProviderLeasesForCompany(companyId);
  // The query is ordered `pausedAt asc nulls last`, so the FIRST paused row is
  // the oldest; active leases (pausedAt NULL) sort last and are never picked.
  const oldestPaused = live.find((row) => normalizeEnvironmentLease(row).status === "paused");
  if (!oldestPaused) return null;
  const lease = normalizeEnvironmentLease(oldestPaused);
  // Lost the CAS (a concurrent resume or a sibling over-cap evictor claimed this
  // same oldest-paused row first) → nothing was actually evicted; return null so
  // the double-evict collapses to a single winner and no live VM is double-killed.
  const outcome = await destroyPausedLease(lease, { environments, runtime });
  return outcome.destroyed ? lease : null;
}

/**
 * Schedule the idle reaper on an interval (mirrors `scheduleTtlSweeper`). A
 * 5-minute tick against a ~30-minute TTL bounds idle cost while staying cheap.
 * No-ops when the reaper flag is off (checked inside `sweepIdleWarmSandboxes`).
 */
export function scheduleWarmSandboxReaper(db: Db, intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    void sweepIdleWarmSandboxes(db).catch((err) => {
      logger.error({ err }, "Warm sandbox idle reap failed");
    });
  }, intervalMs);
}
