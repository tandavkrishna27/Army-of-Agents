/**
 * Adopt the legacy NULL-origin Steward left behind when Steward joined the
 * published default-crew package.
 *
 * This is deliberately separate from `diagnoseCrewProvisioning`: a managed
 * company is healthy even while this historical row is unlinked, and changing
 * that diagnosis would turn a cheap no-network check into fleet-wide repair.
 * The pass instead uses only the already-loaded catalog and performs one
 * pointer-only, transactionally locked adoption.
 */
import { and, eq, inArray, isNotNull, isNull, notLike } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { activityLog, agents, teams, teamMembers } from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";
import { logger } from "../../middleware/logger.js";
import { serializeSafeError } from "../safe-error.js";
import {
  acquireCrewRepairAdvisoryLock,
  adoptLegacyCrewAgentPointer,
} from "./crew-adoption.js";
import {
  catalogPublishesStewardInDefaultCrew,
  CREW_REPAIR_MAX_PER_PASS,
  DEFAULT_CREW_TEAM_ITEM_ID,
  STEWARD_CATALOG_ITEM_ID,
} from "./crew-constants.js";

export { STEWARD_CATALOG_ITEM_ID } from "./crew-constants.js";
export const STEWARD_RECONCILE_ENV = "AOA_STEWARD_RECONCILE_ENABLED";
export const STEWARD_RECONCILE_ACTIVITY_ACTION =
  "marketplace.legacy_steward_adopted";

export interface LegacyStewardReconcilePassResult {
  disabled: boolean;
  catalogReady: boolean;
  inspected: number;
  adopted: number;
  skippedOverBudget: number;
  failed: number;
}

export interface LegacyStewardReconcilePassFailure {
  companyId: string;
  error: unknown;
}

type CompanyReconcileResult =
  | {
      status: "adopted";
      agentId: string;
      teamId: string;
      memberInserted: boolean;
      previousTemplateVersion: string | null;
      auditId: string;
    }
  | { status: "not-applicable" };

/**
 * Default-on runtime switch. Set `AOA_STEWARD_RECONCILE_ENABLED=false` to stop
 * only this reconciliation branch without disabling ordinary crew repair or
 * catalog update checks.
 */
export function isLegacyStewardReconcileEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[STEWARD_RECONCILE_ENV]?.trim().toLowerCase() !== "false";
}

/**
 * Reconcile one company under the same advisory lock used by crew repair.
 *
 * Exact eligibility:
 * - exactly one installed default-crew team row;
 * - exactly one `kind='aoa'`, name=`Steward`, NULL-origin row;
 * - no other row already carries Steward's published origin.
 *
 * The update and membership insert commit together. All instructions, skill
 * keys, triggers, adapter/runtime configuration, and the three-state
 * `instructions_customized` flag remain untouched.
 */
export async function reconcileLegacyStewardOrigin(
  db: Db,
  companyId: string,
): Promise<CompanyReconcileResult> {
  return db.transaction(async (tx) => {
    const lockedDb = tx as unknown as Db;
    await acquireCrewRepairAdvisoryLock(lockedDb, companyId);

    const crewTeams = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(eq(teams.companyId, companyId), eq(teams.templateOrigin, DEFAULT_CREW_TEAM_ITEM_ID)),
      )
      .limit(2);
    if (crewTeams.length !== 1) {
      if (crewTeams.length > 1) {
        logger.warn(
          { companyId, teamCount: crewTeams.length },
          "Steward reconcile: multiple default-crew teams found; refusing ambiguous adoption",
        );
      }
      return { status: "not-applicable" };
    }

    const managedCrewRows = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.kind, "aoa"),
          isNotNull(agents.templateOrigin),
          notLike(agents.templateOrigin, "%@legacy"),
        ),
      )
      .limit(1);
    if (managedCrewRows.length === 0) {
      logger.warn(
        { companyId, teamId: crewTeams[0].id },
        "Steward reconcile: default-crew team has no managed crew rows; refusing partial install",
      );
      return { status: "not-applicable" };
    }

    const stewardRows = await tx
      .select({
        id: agents.id,
        templateOrigin: agents.templateOrigin,
        templateVersion: agents.templateVersion,
      })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.kind, "aoa"),
          eq(agents.name, "Steward"),
        ),
      )
      .limit(2);
    if (stewardRows.length !== 1 || stewardRows[0].templateOrigin !== null) {
      return { status: "not-applicable" };
    }
    const steward = stewardRows[0];

    const existingPublishedRows = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.templateOrigin, STEWARD_CATALOG_ITEM_ID),
        ),
      )
      .limit(1);
    if (existingPublishedRows.length > 0) {
      logger.warn(
        {
          companyId,
          legacyStewardId: steward.id,
          publishedStewardId: existingPublishedRows[0].id,
        },
        "Steward reconcile: a second row already carries the published origin; refusing adoption",
      );
      return { status: "not-applicable" };
    }

    const adopted = await adoptLegacyCrewAgentPointer(lockedDb, {
      companyId,
      agentId: steward.id,
      expectedName: "Steward",
      expectedTemplateOrigin: null,
      templateOrigin: STEWARD_CATALOG_ITEM_ID,
    });
    if (!adopted) {
      throw new Error(
        `Steward reconcile: agent ${steward.id} changed before pointer adoption; rolling back`,
      );
    }

    const insertedMembers = await tx
      .insert(teamMembers)
      .values({ teamId: crewTeams[0].id, agentId: steward.id, role: "member" })
      .onConflictDoNothing()
      .returning({ id: teamMembers.id });
    const memberInserted = insertedMembers.length === 1;

    // This record is the source of truth for surgical backout. Keep it in the
    // same transaction as the pointer and membership changes: an application
    // log emitted after commit is useful observability, but cannot be the only
    // rollback record because the process may exit between commit and logging.
    const [audit] = await tx
      .insert(activityLog)
      .values({
        companyId,
        actorType: "system",
        actorId: "legacy-steward-reconcile",
        action: STEWARD_RECONCILE_ACTIVITY_ACTION,
        entityType: "agent",
        entityId: steward.id,
        agentId: steward.id,
        details: {
          teamId: crewTeams[0].id,
          memberInserted,
          previousTemplateVersion: steward.templateVersion,
          templateOrigin: STEWARD_CATALOG_ITEM_ID,
        },
      })
      .returning({ id: activityLog.id });
    if (!audit) {
      throw new Error(
        `Steward reconcile: failed to persist rollback audit for agent ${steward.id}`,
      );
    }

    return {
      status: "adopted",
      agentId: steward.id,
      teamId: crewTeams[0].id,
      memberInserted,
      previousTemplateVersion: steward.templateVersion,
      auditId: audit.id,
    };
  });
}

/**
 * Cheap steady-state discovery. The transaction below still revalidates every
 * predicate under the lock, so this query is only a broad work filter and can
 * safely race with ordinary writes.
 */
async function legacyStewardCandidateCompanyIds(
  db: Db,
  companyIds: readonly string[],
): Promise<string[]> {
  if (companyIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ companyId: agents.companyId })
    .from(agents)
    .innerJoin(
      teams,
      and(
        eq(teams.companyId, agents.companyId),
        eq(teams.templateOrigin, DEFAULT_CREW_TEAM_ITEM_ID),
      ),
    )
    .where(
      and(
        inArray(agents.companyId, [...companyIds]),
        eq(agents.kind, "aoa"),
        eq(agents.name, "Steward"),
        isNull(agents.templateOrigin),
      ),
    );
  const candidates = new Set(rows.map((row) => row.companyId));
  return companyIds.filter((companyId) => candidates.has(companyId));
}

/**
 * Fleet pass invoked by the existing boot/24-hour crew update cycle.
 *
 * The catalog gate is intentionally before every DB query. A stale snapshot
 * missing either the published Steward item or its default-crew requirement
 * fails closed and leaves curation untouched.
 */
export async function runLegacyStewardReconcilePass(opts: {
  db: Db;
  companyIds: readonly string[];
  catalogItems: readonly CatalogItem[];
  maxPerPass?: number;
  env?: NodeJS.ProcessEnv;
  onFailure?: (failure: LegacyStewardReconcilePassFailure) => void;
}): Promise<LegacyStewardReconcilePassResult> {
  const result: LegacyStewardReconcilePassResult = {
    disabled: false,
    catalogReady: false,
    inspected: 0,
    adopted: 0,
    skippedOverBudget: 0,
    failed: 0,
  };

  if (!isLegacyStewardReconcileEnabled(opts.env)) {
    result.disabled = true;
    return result;
  }
  if (!catalogPublishesStewardInDefaultCrew(opts.catalogItems)) {
    return result;
  }
  result.catalogReady = true;

  const candidateCompanyIds = await legacyStewardCandidateCompanyIds(opts.db, opts.companyIds);
  let budget = opts.maxPerPass ?? CREW_REPAIR_MAX_PER_PASS;
  for (const companyId of candidateCompanyIds) {
    if (budget <= 0) {
      result.skippedOverBudget += 1;
      continue;
    }
    result.inspected += 1;
    try {
      const outcome = await reconcileLegacyStewardOrigin(opts.db, companyId);
      if (outcome.status === "adopted") {
        result.adopted += 1;
        budget -= 1;
        logger.info(
          {
            companyId,
            agentId: outcome.agentId,
            teamId: outcome.teamId,
            memberInserted: outcome.memberInserted,
            previousTemplateVersion: outcome.previousTemplateVersion,
            templateOrigin: STEWARD_CATALOG_ITEM_ID,
            auditId: outcome.auditId,
          },
          "legacy Steward adopted in place",
        );
      }
    } catch (err) {
      result.failed += 1;
      opts.onFailure?.({ companyId, error: err });
      logger.warn(
        { error: serializeSafeError(err), companyId },
        "Steward reconcile failed for company",
      );
    }
  }

  if (result.adopted > 0 || result.failed > 0) {
    logger.info(result, "legacy Steward reconciliation pass complete");
  }
  return result;
}
