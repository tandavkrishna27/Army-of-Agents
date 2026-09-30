/**
 * @fileoverview Install the AoA crew from the marketplace at company creation
 * (T2.3 / P8, P8c).
 *
 * Before this existed, every company was seeded by the hand-written legacy
 * `ensure-*` seeders, whose rows are stamped `…@legacy` by
 * `backfill-template-origin.ts`. `crew-updater.ts` skips `@legacy` rows
 * forever, so every company was permanently frozen out of the update pipeline
 * that was already built and running. Installing `team:aoa-curated/default-crew`
 * at create time is what makes a company *born updateable*.
 *
 * Three hard rules:
 *
 * 1. **This never blocks or fails company creation.** Every failure mode —
 *    no catalog, item missing, fetch failure, deadline, DB error — returns a
 *    result the caller degrades on. It does not throw.
 * 2. **It is bounded.** The real roster is 10 CDN fetches plus 17 bundle
 *    materializations; unbounded and sequential, that is many minutes inside an
 *    interactive POST. See {@link CREW_INSTALL_DEADLINE_MS}.
 * 3. **It goes through the orchestrator**, not straight to `installTeam`, so
 *    the install is recorded in `marketplace_install_operations` with its
 *    cascade results and idempotency key. T2.7 (diff/merge) and T2.8
 *    (re-materialization) build on that record; a second, divergent bootstrap
 *    path would fork them.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { teams } from "@armyofagents/db";
import type { CatalogItem, MarketplaceCatalogFile } from "@armyofagents/shared";
import { logger } from "../../middleware/logger.js";
import { publishLiveEvent as defaultPublishLiveEvent } from "../live-events.js";
import {
  resolveCatalogForBootstrap,
  type CatalogAvailability,
  type CatalogUnavailableReason,
} from "../aoa-marketplace.js";
import { dispatchInstall, startInstallOperation, type Installers, type PublishLiveEventFn } from "./orchestrator.js";
import { claimOperationForDispatch, updateOperation } from "./operation-store.js";
import { installSkill } from "./skill-installer.js";
import { installTeam } from "./team-installer.js";
import {
  catalogPublishesStewardInDefaultCrew,
  DEFAULT_CREW_TEAM_ITEM_ID,
} from "./crew-constants.js";

export { DEFAULT_CREW_TEAM_ITEM_ID } from "./crew-constants.js";

/**
 * Aggregate wall-clock budget for the whole team install (resource fetches +
 * skill installs + the team-body transaction).
 *
 * Sizing, MEASURED rather than estimated (2026-07-24, live GitHub, two runs).
 * The published roster is 10 CDN fetches — `team.json` and 9 `agent.json` —
 * plus 17 skill installs. All 17 carry a `skill.bundle`, so since T2.3c each is
 * a git fetch of the bundle's repo rather than a CDN GET (their bodies are no
 * longer fetched separately; the bundle carries its own SKILL.md). Those 17
 * bundles draw on only 4 distinct repos, and at
 * {@link CREW_INSTALL_FETCH_CONCURRENCY} = 6 the bundle phase costs **5.2-5.6s**
 * — one depth-1 fetch per distinct repo, shared through a per-install
 * `BundleCheckoutCache`.
 *
 * Both of those matter to this number and neither is optional: full clones with
 * no cache measured **67.5-69.3s**, i.e. more than double this budget, which
 * would have degraded every live company create to the legacy seeders. See the
 * table on `BundleCheckoutCache`.
 *
 * What this deadline does and does NOT bound, precisely:
 * - it aborts in-flight CDN fetches, and (since T2.3c) the `git` subprocesses
 *   too — `installTeam` forwards the signal into `installSkill`, which forwards
 *   it into the bundle materializer's `execFile` calls;
 * - it is re-checked before each skill install, so at most one in-flight batch
 *   continues past it;
 * - a clone that is slow rather than stalled can therefore still push the
 *   install past 30s by up to one `git` process's abort latency.
 *
 * Blowing the deadline is not data loss: the install fails, company create
 * degrades to the legacy seeders with a loud log, and T2.3b's repair pass
 * recovers the company later. Skill rows written before the abort survive and
 * are re-used by that repair.
 *
 * Worst case for company create is `CATALOG_AVAILABILITY_TIMEOUT_MS` (12s) +
 * this (30s) ≈ 42s, versus ~13.5 minutes before — and comfortably inside Node's
 * 300s default `requestTimeout`, which was previously the real (socket-error)
 * ceiling.
 */
export const CREW_INSTALL_DEADLINE_MS = 30_000;

/**
 * Resource fetches in flight during pre-flight. 6 keeps the healthy path ~5×
 * faster than sequential without hammering `raw.githubusercontent.com`.
 * Sequential (1) remains the default for every other `installTeam` caller —
 * the public install route is 202-accepted and does not pay this latency
 * synchronously, so there is no reason to change its behaviour in this fix.
 */
export const CREW_INSTALL_FETCH_CONCURRENCY = 6;

/**
 * Deterministic idempotency key. `startInstallOperation` returns the EXISTING
 * operation on a key hit within 24h, and {@link claimOperationForDispatch} then
 * decides — atomically — whether this caller owns the dispatch. Together they
 * make a concurrent or repeated bootstrap incapable of double-installing.
 *
 * (Note: company create's issue-prefix retry loop does NOT reach this — it only
 * re-enters on a conflict at the company INSERT, before a companyId exists. The
 * reachable repeat caller is the T2.3b repair path.)
 */
export function crewBootstrapIdempotencyKey(companyId: string): string {
  return `bootstrap-crew:${companyId}`;
}

export type CrewBootstrapResult =
  | { status: "installed"; teamId: string | null; operationId: string; catalogSource: "cache" | "sync" }
  /** Another caller holds (or completed) this install — do NOT seed over it. */
  | { status: "already-dispatched"; operationId: string; operationStatus: string }
  | {
    status: "unavailable";
    reason: "no-catalog" | "team-not-in-catalog" | "default-crew-missing-steward";
    detail: CatalogUnavailableReason | null;
    catalog: MarketplaceCatalogFile | null;
  }
  | { status: "failed"; reason: string; operationId: string | null; catalog: MarketplaceCatalogFile | null };

export interface CrewBootstrapDeps {
  /** Who to attribute the install operation to. Free text column, no FK. */
  requestedByUserId?: string | null;
  /** Override catalog resolution (tests). Default: cache → bounded sync → snapshot. */
  resolveCatalog?: () => Promise<CatalogAvailability>;
  /** Override the catalog-availability budget (tests). */
  catalogTimeoutMs?: number;
  /** Override the aggregate install budget (tests). */
  installDeadlineMs?: number;
  publishLiveEvent?: PublishLiveEventFn;
}

/**
 * Plugin installs are not reachable from the bootstrap path: the loader lives
 * at the route layer, and company create runs far below it.
 * `team:aoa-curated/default-crew` requires no plugins today. If a future
 * catalog revision adds one, this throws — which fails the team install, which
 * degrades the company to the legacy seeders WITH a loud log, rather than
 * silently installing a half-configured plugin.
 */
const bootstrapPluginInstaller = async (opts: { catalogItem: CatalogItem }): Promise<never> => {
  throw new Error(
    `crew bootstrap cannot install plugin dependency ${opts.catalogItem.id} — ` +
      "the plugin loader is route-scoped. Install it from the Marketplace after onboarding.",
  );
};

function buildBootstrapInstallers(signal: AbortSignal): Installers {
  return {
    installSkill,
    installTeam: (opts) =>
      installTeam({
        ...opts,
        installPlugin: bootstrapPluginInstaller,
        signal,
        fetchConcurrency: CREW_INSTALL_FETCH_CONCURRENCY,
      }),
    // Unreachable for a team item — dispatchInstall only calls these on
    // `agent` / `plugin` roots. Fail loudly rather than pretend to work.
    installAgent: () => {
      throw new Error("crew bootstrap does not install standalone agents");
    },
    installPlugin: bootstrapPluginInstaller,
  };
}

/**
 * Install `team:aoa-curated/default-crew` for a freshly created company.
 *
 * @returns a discriminated result. NEVER throws.
 */
export async function bootstrapCrewFromMarketplace(
  db: Db,
  companyId: string,
  deps: CrewBootstrapDeps = {},
): Promise<CrewBootstrapResult> {
  let catalog: MarketplaceCatalogFile | null = null;
  const deadline = new AbortController();
  const deadlineMs = deps.installDeadlineMs ?? CREW_INSTALL_DEADLINE_MS;
  let deadlineTimer: NodeJS.Timeout | undefined;

  try {
    const resolve =
      deps.resolveCatalog ?? (() => resolveCatalogForBootstrap(db, deps.catalogTimeoutMs));
    const resolved = await resolve();
    if (resolved.status !== "ok") {
      return { status: "unavailable", reason: "no-catalog", detail: resolved.reason, catalog: null };
    }
    catalog = resolved.catalog;

    const teamItem = catalog.items.find(
      (item) => item.id === DEFAULT_CREW_TEAM_ITEM_ID && item.type === "team",
    );
    if (!teamItem) {
      return { status: "unavailable", reason: "team-not-in-catalog", detail: null, catalog };
    }
    if (!catalogPublishesStewardInDefaultCrew(catalog.items)) {
      return {
        status: "unavailable",
        reason: "default-crew-missing-steward",
        detail: null,
        catalog,
      };
    }

    const operation = await startInstallOperation({
      request: {
        catalogItemId: teamItem.id,
        idempotencyKey: crewBootstrapIdempotencyKey(companyId),
      },
      catalogItem: teamItem,
      companyId,
      requestedByUserId: deps.requestedByUserId ?? "system:crew-bootstrap",
      db,
    });

    // Ownership is decided by a conditional UPDATE, not by reading `status`.
    // A read is check-then-act: two concurrent bootstraps can both see
    // `pending` (the loser's conflict-fetch returns the winner's row before the
    // winner writes `running`) and both dispatch, minting a renamed duplicate
    // roster ("Scout 2"). `failure` IS claimable — nobody owns a failed install
    // and nothing was installed, so a repair pass must be able to retry it.
    const claimed = await claimOperationForDispatch(db, operation.id);
    if (!claimed) {
      return {
        status: "already-dispatched",
        operationId: operation.id,
        operationStatus: operation.status,
      };
    }

    deadlineTimer = setTimeout(() => deadline.abort(), deadlineMs);
    deadlineTimer.unref?.();

    // dispatchInstall swallows its own errors onto the operation row, so the
    // terminal patch is the only in-process signal of success/failure.
    //
    // ⚠️ It can also write `success` and THEN throw (the success DB write at
    // orchestrator.ts, or a throwing live-event subscriber), land in its own
    // catch, and overwrite that with `failure`. So a `failed` result here does
    // NOT prove nothing was installed — `provisionCompanyCrew` re-checks the
    // marketplace gate before it seeds anything.
    let terminalStatus: string | null = null;
    let terminalError: string | null = null;
    let resultEntityId: string | null = null;

    await dispatchInstall({
      operation,
      catalogItem: teamItem,
      catalog,
      db,
      installers: buildBootstrapInstallers(deadline.signal),
      publishLiveEvent: deps.publishLiveEvent ?? defaultPublishLiveEvent,
      updateOperation: async (id, patch) => {
        if (patch.status === "success" || patch.status === "failure") {
          terminalStatus = patch.status;
          terminalError = patch.errorMessage ?? null;
          resultEntityId = patch.resultEntityId ?? null;
        }
        await updateOperation(db, id, patch);
      },
    });

    if (terminalStatus === "success") {
      return {
        status: "installed",
        teamId: resultEntityId,
        operationId: operation.id,
        catalogSource: resolved.source,
      };
    }

    return {
      status: "failed",
      reason: terminalError ?? "install did not reach a terminal state",
      operationId: operation.id,
      catalog,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, companyId }, "crew bootstrap threw before dispatch");
    return { status: "failed", reason, operationId: null, catalog };
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    // Abort, don't just stop the clock. On ANY exit — deadline, a 503, a parse
    // error, or success — every fetch still in flight must be cancelled.
    // Clearing the timer alone left ~26 orphan requests running at
    // FETCH_TIMEOUT_MS apiece (~2.5 minutes of network work per failed create)
    // while the caller was already writing legacy rows, which falsified this
    // module's own "aborts rather than abandons" claim.
    deadline.abort();
  }
}

/**
 * The three answers to "did THIS company's crew-team install actually commit?"
 *
 * `unknown` is NOT folded into `installed`: they are failing closed for the
 * same reason but they are different facts, and a log line that reports a DB
 * outage as "the install committed" is a false statement (standing rule 4).
 */
export type CrewTeamInstallState =
  | { state: "installed"; teamId: string }
  | { state: "absent" }
  | { state: "unknown"; error: unknown };

/**
 * Look for the `teams` row this company's crew install would have written.
 *
 * That row is created inside the same phase-3 transaction as the crew agents,
 * and `installTeam` now refuses to write it with zero agents, so it is an exact
 * witness in both directions: team row ⇔ crew agents committed.
 *
 * Deliberately NOT `isCrewMarketplaceManaged`. That predicate matches **any**
 * `kind='aoa'` row with a non-`@legacy` origin, including Commander if the
 * infrastructure seeder ever starts stamping an origin.
 * `aoa-bootstrap-wiring.test.ts` (`stampsOriginOnSeed`) exists precisely
 * because nothing *enforces* today's NULL-origin behavior, and using the broad
 * predicate here would make a company skip its own crew entirely that day.
 * (It did: that test failed when this guard was first written that way.)
 *
 * Callers must treat `unknown` as "do not seed". The asymmetry is deliberate: a
 * crewless company is visible and repairable (T2.3b), a marketplace crew
 * silently overwritten by the legacy seeders is neither.
 */
export async function inspectCrewTeamInstall(
  db: Db,
  companyId: string,
): Promise<CrewTeamInstallState> {
  try {
    const [row] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(eq(teams.companyId, companyId), eq(teams.templateOrigin, DEFAULT_CREW_TEAM_ITEM_ID)),
      )
      .limit(1);
    return row ? { state: "installed", teamId: row.id } : { state: "absent" };
  } catch (err) {
    logger.warn(
      { err, companyId },
      "crew-team install check failed — treating as UNKNOWN and refusing to seed, " +
        "so the legacy seeders cannot clobber an install we simply could not see",
    );
    return { state: "unknown", error: err };
  }
}
