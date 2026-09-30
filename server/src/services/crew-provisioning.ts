/**
 * @fileoverview Company-create crew provisioning (T2.3).
 *
 * One entry point, {@link provisionCompanyCrew}, with one job: get a new
 * company its crew, preferring the marketplace so the company is born
 * *updateable* (`crew-updater.ts` skips `…@legacy` origins forever), and
 * falling back to the legacy `ensure-*` seeders so a marketplace outage can
 * never break onboarding.
 *
 * The fallback is LOSSY and the log says so — see
 * {@link LEGACY_CREW_SEEDER_COVERAGE}.
 */

import type { Db } from "@armyofagents/db";
import type { MarketplaceCatalogFile } from "@armyofagents/shared";
import { logger } from "../middleware/logger.js";
import { ensureCrewAgents } from "./internal-agent/aoa-agents/crew-seeding.js";
import {
  DEFAULT_CREW_TEAM_ITEM_ID,
  bootstrapCrewFromMarketplace,
  inspectCrewTeamInstall,
  type CrewBootstrapDeps,
  type CrewBootstrapResult,
} from "./marketplace-install/crew-bootstrap.js";
import { updateOperation } from "./marketplace-install/operation-store.js";

/**
 * Which legacy `ensure-*` seeder (if any) can stand in for each agent the
 * marketplace crew team declares.
 *
 * `null` means **no legacy seeder exists** — a company that degrades to the
 * fallback simply will not have that agent, with nothing in the resulting data
 * to distinguish it from a complete roster. That is why the degrade log names
 * these explicitly instead of saying "install failed, using legacy seeders".
 *
 * Verified 2026-07-24 against `server/src/services/internal-agent/aoa-agents/`:
 * there is no `ensure-reviewer.ts` anywhere in the tree, while
 * `team:aoa-curated/default-crew` requires `agent:aoa-curated/aoa-reviewer`.
 *
 * Keep this in sync when the catalog team's `requires[]` changes. Unknown
 * (unlisted) catalog agent ids are treated as UNCOVERED — fail loud, not
 * silent, so a new roster member shows up in the log the first time it degrades.
 */
export const LEGACY_CREW_SEEDER_COVERAGE: Readonly<Record<string, string | null>> = {
  "agent:aoa-curated/aoa-adjutant": "ensureAdjutant",
  "agent:aoa-curated/aoa-scout": "ensureScout",
  "agent:aoa-curated/aoa-engineer": "ensureEngineer",
  "agent:aoa-curated/aoa-chronicler": "ensureChronicler",
  "agent:aoa-curated/aoa-librarian": "ensureLibrarian",
  "agent:aoa-curated/aoa-navigator": "ensureCommandStaff",
  "agent:aoa-curated/aoa-planner": "ensureCommandStaff",
  "agent:aoa-curated/aoa-memory-keeper": "ensureCommandStaff",
  "agent:aoa-curated/aoa-steward": "ensureSteward",
  // No seeder. A degraded company is permanently missing its Reviewer.
  "agent:aoa-curated/aoa-reviewer": null,
};

export interface LegacyCoverageGap {
  /** Catalog ids of crew agents the legacy seeders cannot provide. */
  itemIds: string[];
  /**
   * `catalog` — computed from the live team item's `requires[]` (authoritative).
   * `last-known` — no catalog was available, so derived from the static map.
   */
  source: "catalog" | "last-known";
}

/**
 * Which crew roles the legacy fallback cannot provide.
 *
 * When a catalog is in hand the answer comes from the team item's `requires[]`
 * — that is authoritative and catches a roster the static map has drifted from.
 * With no catalog (the common degrade cause) it falls back to the map's known
 * gaps, flagged as `last-known` so a reader knows it may be incomplete.
 */
export function describeLegacyCoverageGap(
  catalog: MarketplaceCatalogFile | null,
): LegacyCoverageGap {
  const teamItem = catalog?.items.find(
    (item) => item.id === DEFAULT_CREW_TEAM_ITEM_ID && item.type === "team",
  );

  if (teamItem) {
    const requiredAgentIds = (teamItem.requires ?? [])
      .filter((req) => req.type === "agent")
      .map((req) => req.id);
    return {
      itemIds: requiredAgentIds.filter((id) => !LEGACY_CREW_SEEDER_COVERAGE[id]),
      source: "catalog",
    };
  }

  return {
    itemIds: Object.entries(LEGACY_CREW_SEEDER_COVERAGE)
      .filter(([, seeder]) => !seeder)
      .map(([id]) => id),
    source: "last-known",
  };
}

export type CrewProvisioningOutcome =
  | { mode: "marketplace"; operationId: string; teamId: string | null }
  | { mode: "marketplace-already-dispatched"; operationId: string }
  /**
   * The bootstrap reported failure, but the crew team IS on disk — the install
   * committed and only its bookkeeping failed. Seeding was skipped, and the
   * lying operation row was repaired to `success` (see `operationRepaired`).
   */
  | { mode: "marketplace-clobber-averted"; reason: string; operationRepaired: boolean }
  /**
   * The witness query itself failed, so we cannot tell whether a crew exists.
   * Failing closed: nothing was seeded, nothing was repaired.
   */
  | { mode: "unknown-skipped-seeding"; reason: string }
  | { mode: "legacy"; reason: string; unprovidedItemIds: string[] };

/**
 * Provision a newly created company's crew. Marketplace first, legacy seeders
 * as the degrade. Never throws — company creation must not depend on the
 * marketplace being reachable.
 */
export async function provisionCompanyCrew(
  db: Db,
  companyId: string,
  deps: CrewBootstrapDeps = {},
): Promise<CrewProvisioningOutcome> {
  let result: CrewBootstrapResult;
  try {
    result = await bootstrapCrewFromMarketplace(db, companyId, deps);
  } catch (err) {
    // bootstrapCrewFromMarketplace documents that it never throws; this is the
    // belt to that suspenders, so a docblock going stale cannot break create.
    result = {
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
      operationId: null,
      catalog: null,
    };
  }

  if (result.status === "installed") {
    logger.info(
      {
        companyId,
        operationId: result.operationId,
        teamId: result.teamId,
        catalogSource: result.catalogSource,
        teamItemId: DEFAULT_CREW_TEAM_ITEM_ID,
      },
      "crew provisioned from the marketplace",
    );
    return { mode: "marketplace", operationId: result.operationId, teamId: result.teamId };
  }

  if (result.status === "already-dispatched") {
    logger.info(
      { companyId, operationId: result.operationId, operationStatus: result.operationStatus },
      "crew bootstrap already dispatched for this company (idempotency key hit) — not re-installing",
    );
    return { mode: "marketplace-already-dispatched", operationId: result.operationId };
  }

  // R7: keep the three unavailability causes distinguishable. `no-service-registered`
  // is a WIRING REGRESSION (nothing called registerMarketplaceCatalogService) and must
  // not read like a CDN blip; `sync-cooldown` means a recent attempt already failed.
  const reason =
    result.status === "unavailable"
      ? (result.detail ? `${result.reason}:${result.detail}` : result.reason)
      : `install failed: ${result.reason}`;
  const operationId = result.status === "failed" ? result.operationId : null;

  // ── The last gate before we write legacy rows ────────────────────────────
  //
  // A `failed` bootstrap result does NOT prove nothing was installed.
  // `dispatchInstall` can commit the team-body transaction, write `success`,
  // and THEN throw — the success DB write can fail, or `publishLiveEvent` is a
  // bare synchronous `EventEmitter.emit` (`live-events.ts`) so a throwing
  // subscriber propagates. Either lands in dispatchInstall's own catch, which
  // overwrites the terminal patch with `failure`.
  //
  // Seeding on top of that committed roster is silent and permanent:
  // `seedCrewAgent` hits ON CONFLICT DO NOTHING on every name-overlapping role,
  // takes the `!inserted` branch, and overwrites the MARKETPLACE rows'
  // `runtimeConfig.aoa.toolAllowlist` and possibly their adapter — while
  // `templateOrigin`/`templateVersion` survive. The instruction bundle seeder
  // is idempotent and preserves founder files, but the DB mutations alone are
  // enough to make the marketplace record lie about the active configuration.
  // company then looks marketplace-managed at the current catalog version, so
  // `crew-updater` will never repair it, and no duplicate rows are minted so
  // nothing in the data reveals the damage.
  //
  // The gate runs BEFORE the DEGRADED log, not after: logging "this company
  // will be stamped @legacy" and then not degrading emitted two contradictory
  // ERROR lines back to back.
  const witness = await inspectCrewTeamInstall(db, companyId);

  if (witness.state === "installed") {
    // F1: repair the row, don't just refuse to seed. Leaving it `failure`
    // leaves it CLAIMABLE, so the next `provisionCompanyCrew` (T2.3b repair)
    // would take it, re-run installTeam against a company that already has the
    // roster, and mint `Scout-2` / `Reviewer-2` / `default-crew-2` — every one
    // carrying the SAME templateOrigin, which also breaks the single-row
    // lookups in `resolver.ts` and `team-reconcile.ts`. `success` is not
    // claimable, so repairing closes the hole and corrects the audit record in
    // one move.
    let operationRepaired = false;
    if (operationId) {
      try {
        await updateOperation(db, operationId, {
          status: "success",
          resultEntityId: witness.teamId,
          errorMessage: null,
          completedAt: new Date(),
        });
        operationRepaired = true;
      } catch (err) {
        logger.error(
          { err, companyId, operationId, teamId: witness.teamId },
          "crew install committed but its operation row could NOT be repaired — it stays " +
            "`failure` and therefore CLAIMABLE, so a later repair pass may re-install and " +
            "mint a duplicate roster",
        );
      }
    }

    logger.error(
      {
        companyId,
        operationId,
        teamId: witness.teamId,
        operationRepaired,
        degradeReason: reason,
        teamItemId: DEFAULT_CREW_TEAM_ITEM_ID,
      },
      "crew bootstrap reported failure but the crew team IS installed — the install " +
        "committed and its bookkeeping failed. SKIPPING the legacy seeders (running them " +
        "would silently overwrite the marketplace crew's runtimeConfig and adapter " +
        "while leaving templateOrigin intact, putting the rows beyond the " +
        "reach of crew-updater).",
    );
    return { mode: "marketplace-clobber-averted", reason, operationRepaired };
  }

  if (witness.state === "unknown") {
    // Failing closed. Say so honestly — this is NOT "the install committed".
    logger.error(
      { companyId, operationId, degradeReason: reason, teamItemId: DEFAULT_CREW_TEAM_ITEM_ID },
      "crew bootstrap failed AND the crew-team witness query failed — cannot tell whether a " +
        "crew exists, so the legacy seeders were NOT run (a clobbered marketplace crew is " +
        "unrepairable; a crewless company is visible and repairable). This company may have " +
        "no crew — check it.",
    );
    return { mode: "unknown-skipped-seeding", reason };
  }

  const gap = describeLegacyCoverageGap(result.catalog);

  logger.error(
    {
      companyId,
      teamItemId: DEFAULT_CREW_TEAM_ITEM_ID,
      degradeReason: reason,
      operationId,
      unprovidedItemIds: gap.itemIds,
      unprovidedSource: gap.source,
    },
    gap.itemIds.length > 0
      ? `crew provisioning DEGRADED to the legacy seeders (${reason}). ` +
          "This company will be stamped `…@legacy` and excluded from marketplace crew updates, AND " +
          `these crew members have NO legacy seeder and will be MISSING entirely: ${gap.itemIds.join(", ")} ` +
          `(roster source: ${gap.source})`
      : `crew provisioning DEGRADED to the legacy seeders (${reason}). ` +
          "This company will be stamped `…@legacy` and excluded from marketplace crew updates. " +
          "The legacy seeders cover every declared crew member.",
  );

  await ensureCrewAgents(db, companyId);
  return { mode: "legacy", reason, unprovidedItemIds: gap.itemIds };
}
