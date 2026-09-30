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
import { EXECUTION_TARGET_KINDS } from "./execution-target-resolver.js";
import { killedProviders } from "./execution-kill-switches.js";
import { createKillSwitchPolicyReader } from "./execution-kill-switch-policy.js";
import { deriveE2bKeyGeneration } from "./e2b-credential-authority-wiring.js";
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
  /**
   * DI seam for tests ONLY. Production builds the reader from `db` inside the sweep — Lane C
   * §2.2's lesson, with the hazard INVERTED: there a permissive injected reader disabled a stop
   * button; here an aggressive one force-kills virtual machines.
   */
  readKillSwitchDocument?: () => Promise<unknown>;
  /** DI seam for tests: the company's CURRENT e2b key generation (REL-004 Lane D §5). */
  currentKeyGeneration?: (companyId: string) => Promise<string | null>;
}

/**
 * REL-004 Lane D (D2a) — the floor grace applied to a reclaim pass.
 *
 * NOT zero. A cutoff of exactly `now` races a resume that is already in flight, and the codebase
 * already refuses zero as an operator intent: `normalizeWarmIdleTtlMinutes` clamps to [1, 1440]
 * and returns the default for any non-positive input. One minute is that same floor.
 */
export const KILL_SWITCH_RECLAIM_GRACE_MS = 60_000;

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
async function destroyClaimedLease(
  lease: EnvironmentLease,
  ctx: {
    environments: Pick<EnvironmentService, "get" | "releaseLease" | "expireLeaseIfPaused">;
    runtime: Pick<EnvironmentRuntimeService, "releaseRunLease">;
  },
  claim: () => Promise<unknown | null>,
  /** Why a lost claim happened, for the log. REL-004 Lane D added a SECOND cause; a
   *  hard-coded "concurrent resume" message would now misattribute a structural refusal. */
  lostClaimReason: string,
): Promise<{ destroyed: boolean }> {
  // Claim the row FIRST. Losing this CAS means someone else (a resume, the sibling
  // over-cap evictor, or a co-running sweep) already owns it — never force-kill then.
  const claimed = await claim();
  if (!claimed) {
    logger.info(
      { leaseId: lease.id, environmentId: lease.environmentId, lostClaimReason },
      "warm-sandbox reaper: lost the claim — skipping destroy",
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

/** The paused-lease arm: claim via the `WHERE status='paused'` CAS, then force-kill. */
function destroyPausedLease(
  lease: EnvironmentLease,
  ctx: {
    environments: Pick<EnvironmentService, "get" | "releaseLease" | "expireLeaseIfPaused">;
    runtime: Pick<EnvironmentRuntimeService, "releaseRunLease">;
  },
): Promise<{ destroyed: boolean }> {
  return destroyClaimedLease(
    lease, ctx,
    () => ctx.environments.expireLeaseIfPaused(lease.id),
    "lease no longer paused (concurrent resume or over-cap evict won the paused CAS)",
  );
}

/**
 * REL-004 Lane D (D3) — the STRANDED arm: claim a terminal row that still holds a provider
 * handle, then force-kill. A separate claim is not a nicety: the paused CAS is
 * `WHERE status='paused'` and can never match these rows, so reusing it would have made this
 * whole arm inert.
 */
function destroyStrandedLease(
  lease: EnvironmentLease,
  ctx: {
    environments: Pick<EnvironmentService, "get" | "releaseLease" | "expireLeaseIfPaused"> &
      Pick<EnvironmentService, "claimTerminalUncleaned">;
    runtime: Pick<EnvironmentRuntimeService, "releaseRunLease">;
  },
): Promise<{ destroyed: boolean }> {
  return destroyClaimedLease(
    lease, ctx,
    () => ctx.environments.claimTerminalUncleaned(lease.id),
    "lease already cleaned or claimed by a co-running sweep (terminal CAS lost)",
  );
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
  const { environments, runtime } = resolveDeps(db, deps);
  let reaped = 0;

  // REL-004 Lane D (D2 / D2a arm 2) — the RECLAIM arm, ABOVE the flag gate on purpose (J12).
  //
  // `enableWarmSandboxReaper` is a warm-ECONOMY default: "do not bother reaping idle snapshots".
  // An operator who has thrown a kill switch carrying `reclaim: true` has expressed a stronger and
  // far more specific intent, and an incident-response reclaim must not be silently disabled by a
  // background toggle that has no UI. The two ROUTINE arms below stay subordinate to it.
  //
  // Destructive and therefore opt-in: a plain deny-list stops placement and touches nothing,
  // because the paused population is the IN-USE population (warm leases pause at the end of every
  // Commander turn) and destroying it is irreversible.
  //
  // Provider-SCOPED, one pass per killed value, rather than a global cutoff of zero.
  const readDocument = deps.readKillSwitchDocument
    ?? (() => createKillSwitchPolicyReader({ appDb: db }).read());
  // Fail-OPEN, inverted from leasing: `killedProviders` returns the empty set for an absent,
  // malformed or unreadable document, and a read that THROWS must not be able to trigger a
  // fleet-wide teardown.
  let reclaimProviders: ReadonlySet<string> = new Set();
  try {
    reclaimProviders = killedProviders(await readDocument(), EXECUTION_TARGET_KINDS);
  } catch (err) {
    logger.warn({ err }, "warm-sandbox reaper: kill-switch policy unreadable — reclaiming nothing");
  }
  let reclaimScanned = 0;
  for (const provider of reclaimProviders) {
    const reclaimCutoff = new Date(Date.now() - KILL_SWITCH_RECLAIM_GRACE_MS);
    const doomed = await environments.listPausedLeasesForProvider(provider, reclaimCutoff);
    reclaimScanned += doomed.length;
    for (const row of doomed) {
      const lease = normalizeEnvironmentLease(row);
      try {
        const outcome = await destroyPausedLease(lease, { environments, runtime });
        if (outcome.destroyed) reaped++;
      } catch (err) {
        logger.warn(
          { err, leaseId: lease.id, provider },
          "warm-sandbox reaper: failed to reclaim a killed provider's paused lease (best-effort)",
        );
      }
    }
  }

  // REL-004 Lane D (§5) — inherited deferral #5, "old-key kill-switch enforcement".
  //
  // A paused snapshot created under a SUPERSEDED e2b key generation is dead weight by this
  // system's own policy: `e2b-credential-authority` refuses to resolve or inject a superseded
  // generation, so AoA will never resume it. Reclaiming it destroys nothing anyone can use.
  //
  // Above the flag gate for the same reason as the reclaim arm: this is credential hygiene after
  // a rotation, not warm economy. Fail-OPEN throughout — an unknown generation, a null current
  // generation (no BYO key), or a lookup that throws all reclaim NOTHING. Absence must never be
  // read as supersession, or the first deploy after this ships would reap every pre-existing
  // warm snapshot.
  const currentKeyGeneration = deps.currentKeyGeneration
    ?? ((companyId: string) => deriveE2bKeyGeneration(db, companyId));
  let supersededScanned = 0;
  try {
    const graceCutoff = new Date(Date.now() - KILL_SWITCH_RECLAIM_GRACE_MS);
    const pausedE2b = await environments.listPausedLeasesWithKeyGeneration(graceCutoff);
    const generationByCompany = new Map<string, string | null>();
    for (const row of pausedE2b) {
      const lease = normalizeEnvironmentLease(row);
      const recorded = (lease.metadata as Record<string, unknown> | null)?.keyGeneration;
      if (typeof recorded !== "string" || recorded.length === 0) continue;
      if (!generationByCompany.has(lease.companyId)) {
        generationByCompany.set(lease.companyId, await currentKeyGeneration(lease.companyId));
      }
      const current = generationByCompany.get(lease.companyId) ?? null;
      if (current === null || current === recorded) continue;
      supersededScanned++;
      try {
        const outcome = await destroyPausedLease(lease, { environments, runtime });
        if (outcome.destroyed) reaped++;
      } catch (err) {
        logger.warn(
          { err, leaseId: lease.id, recorded, current },
          "warm-sandbox reaper: failed to reclaim a superseded-key snapshot (best-effort)",
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "warm-sandbox reaper: superseded-key scan failed — reclaiming nothing");
  }

  if (!experimental.enableWarmSandboxReaper) {
    logger.info(
      { scanned: reclaimScanned + supersededScanned, reclaimProviders: [...reclaimProviders], supersededScanned, reaped },
      "Warm sandbox reap complete (routine arms disabled by enableWarmSandboxReaper)",
    );
    return { scanned: reclaimScanned + supersededScanned, reaped };
  }

  const ttlMinutes = normalizeWarmIdleTtlMinutes(experimental.warmSandboxIdleTtlMinutes);
  const cutoff = new Date(Date.now() - ttlMinutes * 60 * 1000);

  const stale = await environments.listPausedLeasesOlderThan(cutoff);
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

  // REL-004 Lane D (D3 / D2a arm 1) — the STRANDED arm, deliberately switch-INDEPENDENT.
  // A terminal row still holding a provider handle is pure waste with no user-visible state:
  // there is nothing for an operator to opt into. This is also the arm that closes MIG-008's
  // orphan, which would otherwise leave a billing sandbox unreachable forever.
  const stranded = await environments.listTerminalUncleanedLeases();
  for (const row of stranded) {
    const lease = normalizeEnvironmentLease(row);
    try {
      const outcome = await destroyStrandedLease(lease, { environments, runtime });
      if (outcome.destroyed) reaped++;
    } catch (err) {
      logger.warn(
        { err, leaseId: lease.id, environmentId: lease.environmentId },
        "warm-sandbox reaper: failed to reclaim stranded lease (best-effort)",
      );
    }
  }

  const scanned = stale.length + stranded.length + reclaimScanned + supersededScanned;
  logger.info(
    {
      scanned, stalePaused: stale.length, stranded: stranded.length,
      reclaimScanned, reclaimProviders: [...reclaimProviders], supersededScanned, reaped, ttlMinutes,
    },
    "Warm sandbox idle reap complete",
  );
  return { scanned, reaped };
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
