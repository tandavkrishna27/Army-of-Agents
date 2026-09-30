/**
 * @fileoverview Repair a company whose crew provisioning degraded (T2.3b).
 *
 * **Why this exists.** `provisionCompanyCrew` runs at exactly one instant —
 * company creation — and `crew-updater.ts` skips `…@legacy` and NULL-origin
 * rows *forever*. So one CDN blip, cold cache, deadline, or process restart at
 * that instant permanently excludes the company from every future crew update.
 * T2.3's fail-open degrade is only an acceptable trade because this module
 * exists: the degraded state has to be recoverable, or "born updateable" is one
 * network call wide.
 *
 * ── What repair does, and the one thing it deliberately does NOT do ──────────
 *
 * Repair **adopts the pointer, never the content.** For a company whose crew is
 * `…@legacy`/NULL it rewrites two columns — `templateOrigin` and
 * `templateVersion` — and leaves instructions, `skillKeys`, `runtimeConfig`,
 * triggers and adapter exactly as the founder has them. That is enough to
 * un-freeze the company: `checkCrewUpdates` then sees a managed row at
 * {@link ADOPTED_TEMPLATE_VERSION}, which can never equal a published version,
 * so it routes the content change through the company's own `agentUpdatePolicy`
 * — auto-apply, or a founder-visible pending update + notification.
 *
 * **D22 amendment (Decision #114).** An adopted row leaves `agents`'
 * `instructions_customized` as NULL — repair genuinely cannot tell whether the
 * legacy bundle it just adopted was founder-edited. `crew-updater` treats NULL
 * as customized, so the follow-on content change routes to NOTIFY even under
 * `agentUpdatePolicy: "auto"`. That strengthens the pointer-only stance below
 * rather than replacing it: repair still adopts nothing but the pointer, and the
 * update path no longer has a mode in which it silently overwrites edits.
 *
 * The alternative — having repair call `applyCrewAgentUpdate` itself — was
 * built first and rejected. It runs
 * `materializeManagedBundle(..., { replaceExisting: true })`, whose first act is
 * `fs.rm(root, { recursive: true, force: true })` on the directory holding the
 * founder's instruction edits, **outside the transaction** and **without
 * consulting `agentUpdatePolicy`** (whose default is `notify`). An unattended
 * boot pass that deletes founder-edited files with no consent and no signal is
 * not a repair; and if the transaction then failed, the row stayed legacy while
 * the edits were already gone. Pointer-only adoption has none of that: the only
 * writes are DB writes, all inside one transaction.
 *
 * ── The three degraded shapes ───────────────────────────────────────────────
 *
 * The **roster** (`team.json`) is the authority on what counts as crew.
 * Everything is decided by matching it against this company's `kind='aoa'` rows,
 * on **name OR legacy-origin slug** — name alone is not a stable join key,
 * because a founder can rename a crew agent through `PATCH /agents/:id` without
 * touching `templateOrigin`:
 *
 * 1. **Some roster rows match** → adopt them. Re-running the provisioner here
 *    would be wrong: `installTeam` inserts a fresh row per roster entry and
 *    `resolveAgentNameConflict` renames each collision, minting `Scout-2` /
 *    `default-crew-2` sharing one `templateOrigin` while leaving the ORIGINAL
 *    rows — the ones tasks, runs and assignments point at by id — still frozen.
 * 2. **No roster row matches, and every remaining crew row is accounted for**
 *    (i.e. only Commander or a protected historical Steward is left) →
 *    genuinely crewless. This is the
 *    residual state T2.3's `unknown` witness leaves behind. Nothing can collide,
 *    so {@link provisionCompanyCrew} is re-run verbatim.
 * 3. **No roster row matches, but crew rows remain unaccounted for** → REFUSE.
 *    Those rows own real work; installing the roster beside them creates a
 *    second, parallel crew and the company then reads `healthy` forever. See
 *    {@link isInfrastructureRow} for why its residual exemption list is safe stale in
 *    both directions, unlike the classification list it replaced.
 * 4. **Installed, but the operation row still reads claimable** → seal it. The
 *    T2.3 averted-clobber repair writes that row on the connection that just
 *    failed; when the DB is what broke, it stays claimable and the next
 *    provisioning pass re-installs over a committed roster.
 *
 * **All-or-nothing.** If any roster member that HAS a local row cannot be
 * adopted, repair writes nothing at all. A partial adoption plus a team row is
 * the worst state available: `reconcileTeamMembers` cannot tell "no local
 * counterpart" from "adoption failed here", so it installs a duplicate under a
 * renamed name, and the original row is then permanently unreachable (the next
 * pass sees the origin already present and skips it).
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agents,
  companySkills,
  teams,
  teamMembers,
  marketplaceInstallOperations,
} from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";
import { logger } from "../middleware/logger.js";
import { marketplaceNotifications } from "./marketplace-notifications.js";
import { resolveTeamSlugConflict } from "./marketplace-install/conflict-resolver.js";
import {
  fetchCatalogResource,
  MarketplaceResourceFetchError,
} from "./marketplace-install/fetch-resource.js";
import { installSkill } from "./marketplace-install/skill-installer.js";
import {
  createBundleCheckoutCache,
  disposeBundleCheckoutCache,
} from "./marketplace-install/skill-bundle-materializer.js";
import {
  OPERATION_CLAIM_STALE_AFTER_MS,
  updateOperation,
} from "./marketplace-install/operation-store.js";
import {
  DEFAULT_CREW_TEAM_ITEM_ID,
  crewBootstrapIdempotencyKey,
} from "./marketplace-install/crew-bootstrap.js";
import { provisionCompanyCrew, type CrewProvisioningOutcome } from "./crew-provisioning.js";
import {
  sanitizeErrorText,
  serializeSafeError,
} from "./safe-error.js";
import {
  ADOPTED_TEMPLATE_VERSION,
  CREW_REPAIR_MAX_PER_PASS,
  crewLegacySlugCandidates,
} from "./marketplace-install/crew-constants.js";
import {
  acquireCrewRepairAdvisoryLock,
  adoptLegacyCrewAgentPointer,
} from "./marketplace-install/crew-adoption.js";

export {
  ADOPTED_TEMPLATE_VERSION,
  CREW_REPAIR_MAX_PER_PASS,
} from "./marketplace-install/crew-constants.js";

/**
 * Budget for the `team.json` fetch — the one resource repair fetches directly.
 *
 * Skill bodies do NOT run against this clock: they go through `installSkill`, at
 * {@link CREW_REPAIR_FETCH_CONCURRENCY} in flight. Sizing a single aggregate
 * deadline across 17 bundle materializations would either abort healthy work or
 * be so loose it bounded nothing.
 *
 * Stated exactly, because an earlier revision of this comment overclaimed it:
 * an `installSkill` body FETCH is bounded by `FETCH_TIMEOUT_MS`, but a bundle
 * `git clone` is bounded only by git's own network timeouts unless the caller
 * passes a signal — and repair deliberately passes none, because it is an
 * unattended background pass with no interactive budget to protect. The
 * interactive caller that does need the bound (company create) passes one.
 */
export const CREW_REPAIR_FETCH_DEADLINE_MS = 30_000;

/**
 * Skill-body fetches in flight during repair's pre-flight. Matches
 * `CREW_INSTALL_FETCH_CONCURRENCY` — same CDN, same politeness budget.
 */
export const CREW_REPAIR_FETCH_CONCURRENCY = 6;

/** A `templateOrigin` that puts the row inside the update pipeline. */
export function isMarketplaceManagedOrigin(origin: string | null): origin is string {
  return origin !== null && origin.length > 0 && !origin.endsWith("@legacy");
}

export interface CrewAgentSnapshot {
  id: string;
  name: string;
  templateOrigin: string | null;
  templateVersion: string | null;
}

export type CrewRepairVerdict =
  /** Crew team row + at least one managed crew agent, audit row honest. */
  | "healthy"
  /** Installed, but the bootstrap operation row is still claimable. */
  | "operation-row-stale"
  /**
   * Anything else. Deliberately NOT split into "crewless" vs "unmanaged" here:
   * that distinction can only be made against the roster, which costs a network
   * fetch, and a cheap diagnosis that guessed it would guess wrong exactly when
   * the roster changes (e.g. when T2.4 moves Steward into the crew).
   */
  | "degraded";

export interface CrewRepairDiagnosis {
  companyId: string;
  verdict: CrewRepairVerdict;
  /** The `teams` row for `team:aoa-curated/default-crew`, if it exists. */
  teamId: string | null;
  /** `kind='aoa'` rows already inside the update pipeline. */
  managedCrew: CrewAgentSnapshot[];
  /** `kind='aoa'` rows with a `…@legacy`/NULL origin. */
  unmanagedCrew: CrewAgentSnapshot[];
  /** The `bootstrap-crew:<companyId>` operation row, if one was ever written. */
  operation: { id: string; status: string; startedAt: Date } | null;
}

/**
 * Is this operation row a lie that a later provisioning pass could act on?
 *
 * Mirrors `claimOperationForDispatch` exactly, and that is the point: a row is
 * only worth sealing if it is CLAIMABLE, because claimable-over-a-committed-crew
 * is the whole hazard.
 * - `failure` — claimable now.
 * - `pending` — claimable now, at any age (nobody has started it).
 * - `running` older than {@link OPERATION_CLAIM_STALE_AFTER_MS} — owner died.
 * - a FRESH `running` — a live install owns it; sealing would declare someone
 *   else's in-flight work finished.
 * - `requested` — a founder-approval state; never hijack a pending decision.
 * - `success` — already honest.
 */
function isClaimableOverInstalledCrew(
  operation: { status: string; startedAt: Date },
  now: number,
): boolean {
  if (operation.status === "failure" || operation.status === "pending") return true;
  if (operation.status === "running") {
    return now - operation.startedAt.getTime() >= OPERATION_CLAIM_STALE_AFTER_MS;
  }
  return false;
}

/**
 * Classify a company's crew provisioning. Three indexed queries; no network.
 * Throws on a DB error — callers treat that as "skip this company", never as
 * "healthy" (a pass that silently reads an outage as health is the exact
 * failure class T2.3's `unknown` witness was written to avoid).
 */
export async function diagnoseCrewProvisioning(
  db: Db,
  companyId: string,
): Promise<CrewRepairDiagnosis> {
  const crewRows = (await db
    .select({
      id: agents.id,
      name: agents.name,
      templateOrigin: agents.templateOrigin,
      templateVersion: agents.templateVersion,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.kind, "aoa")))) as CrewAgentSnapshot[];

  const managedCrew = crewRows.filter((row) => isMarketplaceManagedOrigin(row.templateOrigin));
  const unmanagedCrew = crewRows.filter((row) => !isMarketplaceManagedOrigin(row.templateOrigin));

  const [teamRow] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.companyId, companyId), eq(teams.templateOrigin, DEFAULT_CREW_TEAM_ITEM_ID)))
    .limit(1);

  const [operationRow] = await db
    .select({
      id: marketplaceInstallOperations.id,
      status: marketplaceInstallOperations.status,
      startedAt: marketplaceInstallOperations.startedAt,
    })
    .from(marketplaceInstallOperations)
    .where(
      and(
        eq(marketplaceInstallOperations.companyId, companyId),
        eq(marketplaceInstallOperations.idempotencyKey, crewBootstrapIdempotencyKey(companyId)),
      ),
    )
    .limit(1);

  const teamId = teamRow?.id ?? null;
  const operation = operationRow
    ? {
        id: operationRow.id,
        status: operationRow.status,
        startedAt: new Date(operationRow.startedAt as unknown as string | Date),
      }
    : null;

  // "Installed" is team row AND at least one managed crew agent — the same
  // both-directions witness `installTeam` guarantees (it refuses to write a
  // team row with zero agents).
  const installed = teamId !== null && managedCrew.length > 0;

  let verdict: CrewRepairVerdict;
  if (installed) {
    verdict =
      operation && isClaimableOverInstalledCrew(operation, Date.now())
        ? "operation-row-stale"
        : "healthy";
  } else {
    verdict = "degraded";
  }

  return { companyId, verdict, teamId, managedCrew, unmanagedCrew, operation };
}

/** Why repair declined to act. Kept distinct so an operator can tell them apart. */
export type CrewRepairSkipReason =
  | "cooldown"
  | "install-in-flight"
  | "team-item-not-in-catalog"
  | "team-template-unavailable"
  | "empty-roster"
  | "unadoptable-roster-member"
  | "unaccounted-crew-rows"
  | "skill-install-failed";

export type CrewRepairSkillFailureCode =
  | "resource-temporarily-unavailable"
  | "resource-fetch-failed"
  | "resource-invalid"
  | "bundle-materialization-failed"
  | "bundle-missing"
  | "filesystem-permission-denied";

export interface CrewRepairSkillFailure {
  code: CrewRepairSkillFailureCode;
  catalogItemId: string;
  httpStatus?: number;
  filesystemOperation?: "read" | "write" | "rename" | "mkdir";
  notBefore?: string;
}

export type CrewRepairResult =
  | { action: "none"; verdict: CrewRepairVerdict }
  | { action: "operation-repaired"; operationId: string; teamId: string }
  | { action: "reprovisioned"; outcome: CrewProvisioningOutcome }
  | {
      action: "adopted";
      teamId: string;
      /** Catalog agent ids now stamped onto pre-existing rows. Never partial. */
      adoptedItemIds: string[];
      /**
       * Roster members with no local row at all. NOT a failure — repair writes
       * the team row + links, and `reconcileTeamMembers` installs these on its
       * own pass (e.g. Reviewer, which has no legacy seeder).
       */
      unmatchedItemIds: string[];
      /** Catalog skill ids installed so the roster's `skillKeys` can resolve. */
      installedSkillIds: string[];
    }
  /** Diagnosed as repairable, but deliberately not repaired. Always logged. */
  | {
      action: "skipped";
      verdict: CrewRepairVerdict;
      reason: CrewRepairSkipReason;
      detail: string;
      skillFailure?: CrewRepairSkillFailure;
      notBefore?: string;
    };

export interface CrewRepairDeps {
  /** Catalog items — the same array the boot update pass already loaded. */
  catalogItems: readonly CatalogItem[];
  /** Attribution for a repaired/synthesized install operation row. */
  requestedByUserId?: string | null;
  /**
   * Bypass {@link CREW_REPAIR_COOLDOWN_MS}. For a deliberate operator action
   * (the founder route with `force`), never for the unattended pass.
   */
  force?: boolean;
  /** Test seam. Default: the real {@link provisionCompanyCrew}. */
  provision?: typeof provisionCompanyCrew;
}

interface RosterEntry {
  templateOrigin: string;
  name: string;
}

interface TeamTemplateBody {
  slug: string;
  description?: string;
  manifest?: Record<string, unknown>;
  agents: RosterEntry[];
}

/**
 * Diagnose one company and repair it if it is degraded.
 *
 * Diagnosis ALWAYS runs first and gates everything. That ordering is
 * load-bearing, not stylistic: acting on a company that already has crew rows
 * is what mints a duplicate roster, and the only thing standing between the two
 * is this classification.
 *
 * @throws only from {@link diagnoseCrewProvisioning} (a DB failure). Every
 * repair action past that point is contained and reported in the result.
 */
export async function repairCompanyCrew(
  db: Db,
  companyId: string,
  deps: CrewRepairDeps,
): Promise<CrewRepairResult> {
  const diagnosis = await diagnoseCrewProvisioning(db, companyId);
  if (diagnosis.verdict === "healthy") {
    return { action: "none", verdict: "healthy" };
  }

  // The cooldown lives HERE, not in the pass, so every entry point is gated —
  // the founder route included. A loop on the route otherwise drives unbounded
  // fetches, and on a crewless company each call is a full provisioning attempt
  // (catalog wait + install deadline + ~10 fetches + ~17 bundle materializations).
  const minGapMs = deps.force ? CREW_REPAIR_FORCE_FLOOR_MS : CREW_REPAIR_COOLDOWN_MS;
  if (!claimRepairAttempt(companyId, minGapMs)) {
    return skip(
      diagnosis,
      "cooldown",
      `a repair for this company was attempted within the last ${Math.round(minGapMs / 1000)}s`,
    );
  }

  if (diagnosis.verdict === "operation-row-stale") {
    const operationId = await sealBootstrapOperation(db, {
      companyId,
      teamId: diagnosis.teamId!,
      existingOperationId: diagnosis.operation?.id ?? null,
      requestedByUserId: deps.requestedByUserId ?? null,
    });
    logger.warn(
      { companyId, operationId, teamId: diagnosis.teamId, priorStatus: diagnosis.operation?.status },
      "crew repair: the crew is installed but its install operation row was still claimable — " +
        "sealed to success so a later provisioning pass cannot re-install over it",
    );
    return { action: "operation-repaired", operationId, teamId: diagnosis.teamId! };
  }

  return repairDegradedCrew(db, diagnosis, deps);
}

async function repairDegradedCrew(
  db: Db,
  diagnosis: CrewRepairDiagnosis,
  deps: CrewRepairDeps,
): Promise<CrewRepairResult> {
  const { companyId } = diagnosis;

  // A live bootstrap owns this company's crew provisioning. Sealing the
  // operation row inside the repair transaction excludes a bootstrap that has
  // not created its row yet (it blocks on the unique idempotency index), but it
  // cannot un-do one that is ALREADY mid-install — that would leave two team
  // rows sharing one templateOrigin. `pending` and `failure` are claimable by
  // anyone and are safe to take; a fresh `running` and `requested` are not.
  const op = diagnosis.operation;
  if (
    op &&
    (op.status === "requested" ||
      (op.status === "running" && Date.now() - op.startedAt.getTime() < OPERATION_CLAIM_STALE_AFTER_MS))
  ) {
    return skip(
      diagnosis,
      "install-in-flight",
      `install operation ${op.id} is ${op.status} and not yet stale — leaving it to its owner`,
    );
  }

  const catalogById = new Map(deps.catalogItems.map((item) => [item.id, item]));
  const teamItem = catalogById.get(DEFAULT_CREW_TEAM_ITEM_ID);
  if (!teamItem || teamItem.type !== "team") {
    return skip(diagnosis, "team-item-not-in-catalog", `${DEFAULT_CREW_TEAM_ITEM_ID} is absent`);
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), CREW_REPAIR_FETCH_DEADLINE_MS);
  timer.unref?.();
  try {
    let teamBody: TeamTemplateBody;
    try {
      teamBody = JSON.parse(
        await fetchCatalogResource(teamItem, "team template (crew repair)", deadline.signal),
      ) as TeamTemplateBody;
    } catch (err) {
      return skip(diagnosis, "team-template-unavailable", errText(err));
    }

    const roster = Array.isArray(teamBody.agents) ? teamBody.agents : [];
    if (roster.length === 0) {
      // Same fail-closed stance as installTeam's empty-roster refusal: an empty
      // team.json must never become a team row that reads as a healthy install.
      return skip(diagnosis, "empty-roster", "team.json declares no agents");
    }

    // ── Partition the company's crew against the roster ────────────────────
    // Matched on name OR legacy-origin slug. Name alone is NOT a stable join
    // key: a founder may rename a crew agent through `PATCH /agents/:id`, which
    // leaves `templateOrigin` untouched. `backfillCrewTemplateOrigin` writes
    // `aoa-curated/standard-crew/<slug>@legacy` once, at boot, and nothing
    // rewrites it — so for any row that backfill has touched, the legacy slug
    // survives every rename and is the join key that actually holds.
    const byOrigin = new Map(
      diagnosis.managedCrew.map((row) => [row.templateOrigin as string, row]),
    );
    const allCrew = [...diagnosis.managedCrew, ...diagnosis.unmanagedCrew];
    const claimedRowIds = new Set<string>();

    const adoptable: Array<{ row: CrewAgentSnapshot; entry: RosterEntry }> = [];
    const alreadyAdopted: string[] = [];
    const unmatched: string[] = [];
    for (const entry of roster) {
      if (byOrigin.has(entry.templateOrigin)) {
        alreadyAdopted.push(entry.templateOrigin);
        claimedRowIds.add(byOrigin.get(entry.templateOrigin)!.id);
        continue;
      }
      const slugs = legacySlugsForRosterEntry(entry);
      const row = allCrew.find(
        (candidate) =>
          !claimedRowIds.has(candidate.id) &&
          (candidate.name === entry.name || matchesLegacySlug(candidate.templateOrigin, slugs)),
      );
      if (!row) {
        unmatched.push(entry.templateOrigin);
        continue;
      }
      claimedRowIds.add(row.id);
      // A row already managed under a DIFFERENT origin is not ours to re-point.
      if (isMarketplaceManagedOrigin(row.templateOrigin)) {
        return skip(
          diagnosis,
          "unadoptable-roster-member",
          `agent "${row.name}" is already managed as ${row.templateOrigin}, not ${entry.templateOrigin}`,
        );
      }
      const item = catalogById.get(entry.templateOrigin);
      if (!item || item.type !== "agent") {
        // ALL-OR-NOTHING. Adopting the rest and writing the team row would let
        // reconcileTeamMembers install a renamed duplicate for this one, after
        // which the original row is unreachable forever.
        return skip(
          diagnosis,
          "unadoptable-roster-member",
          `${entry.templateOrigin} (matched local agent "${row.name}") is not an agent in the catalog`,
        );
      }
      adoptable.push({ row, entry });
    }

    // ── The refusal that guards the crewless branch ─────────────────────────
    // Every crew row that is NOT a residual exemption and did NOT map to a
    // roster entry is unaccounted for. Provisioning on top installs a second,
    // parallel crew beside rows that own every task, run and assignment — and
    // the company then reads `healthy`, so nothing ever revisits it. Refuse.
    //
    // The residual exemption is safe in BOTH stale directions, unlike the
    // classification list it replaces: Steward remains here only for historical
    // NULL-origin companies. When the roster carries Steward it is claimed
    // above first; a missing exemption makes us refuse, which is fail-closed.
    // It is keyed on the legacy slug first so a renamed Commander is recognised.
    const rosterSlugs = new Set<string>();
    for (const entry of roster) {
      for (const slug of legacySlugsForRosterEntry(entry)) rosterSlugs.add(slug);
    }
    const unaccounted = allCrew.filter(
      (row) => !claimedRowIds.has(row.id) && !isAccountedFor(row, rosterSlugs),
    );
    if (unaccounted.length > 0 && adoptable.length === 0 && alreadyAdopted.length === 0) {
      return skip(
        diagnosis,
        "unaccounted-crew-rows",
        `this company has crew agent(s) that map to no roster entry by name or legacy origin ` +
          `(${unaccounted.map((r) => `${r.name}[${r.templateOrigin ?? "no-origin"}]`).join(", ")}) — ` +
          "installing the roster here would create a second, parallel crew beside rows that own " +
          "existing work",
      );
    }

    if (adoptable.length === 0 && alreadyAdopted.length === 0) {
      // Not one roster member has a local row, and nothing is unaccounted for:
      // genuinely crewless. This is the one shape where nothing can collide, so
      // the ordinary provisioning path is exactly right — degrade included.
      logger.warn({ companyId }, "crew repair: no roster member has a local row — re-provisioning");
      const provision = deps.provision ?? provisionCompanyCrew;
      const outcome = await provision(db, companyId, {
        requestedByUserId: deps.requestedByUserId ?? null,
      });
      logger.info({ companyId, mode: outcome.mode }, "crew repair: re-provisioning finished");
      return { action: "reprovisioned", outcome };
    }

    // ── The roster's skills, or the crew advertises keys it cannot load ──────
    // Without these rows `handleUseSkill` answers "Skill not found for this
    // company" for every declared key, and `reconcileTeamMembers` installs
    // Reviewer with the same dangling keys.
    //
    // Deliberately OUTSIDE the transaction, and deliberately through the real
    // `installSkill`. Outside, because `installSkill` materializes
    // `catalogItem.skill.bundle` with a git clone — every one of the 17 skills
    // the live crew team requires carries a bundle, and holding a transaction
    // plus an advisory lock across 17 clones is not acceptable. That is safe
    // here in a way the agent writes are not: these are additive, idempotent
    // (`installSkill` answers `alreadyInstalled` on retry), version-scoped
    // NEW-FILE writes — never a delete of founder data. If the transaction below
    // then fails, the rows simply survive and the next attempt re-uses them.
    //
    // Through the real installer, because a hand-rolled insert cannot produce a
    // materialized bundle, a derived `trustLevel`, a real `fileInventory` or the
    // `catalogSkillBundle`/`catalogBundleInstallPath` metadata — and stamping
    // `sourceRef` to the current version makes `installSkill`'s idempotency
    // guard answer `alreadyInstalled` for that key FOREVER, so the bundle would
    // never be materialized for the company. Worse than writing no row at all.
    let installedSkillIds: string[];
    try {
      installedSkillIds = await installMissingRosterSkills(db, {
        companyId,
        teamItem,
        catalogById,
      });
    } catch (err) {
      const skillFailure =
        err instanceof CrewSkillInstallError
          ? classifyCrewSkillFailure(err.catalogItemId, err.cause)
          : classifyCrewSkillFailure("unknown", err);
      logger.warn(
        {
          companyId,
          catalogItemId: skillFailure.catalogItemId,
          failureCode: skillFailure.code,
          error: serializeSafeError(
            err instanceof CrewSkillInstallError ? err.cause : err,
          ),
        },
        "crew repair skill installation failed",
      );
      return skip(
        diagnosis,
        "skill-install-failed",
        errText(err),
        skillFailure,
      );
    }

    const rosterOrigins = roster.map((entry) => entry.templateOrigin);
    const committed = await db.transaction(async (tx) => {
      // Serializes crew REPAIRS for this company across sessions and processes
      // (advisory locks are database-wide and released at transaction end).
      // `teams` has no unique index on (companyId, templateOrigin), so nothing
      // else prevents two team rows.
      //
      // ⚠️ Scope, precisely: this is NOT a general "one crew writer" invariant.
      // (a) The `install-in-flight` guard above reads the operation row taken
      //     BEFORE this lock, so a bootstrap that inserts `pending` and claims
      //     it inside that window is mid-`installTeam` when `sealBootstrapOperation`
      //     overwrites the row — both can then write a team row. Sealing here
      //     only excludes a bootstrap that has not created its row yet (it
      //     blocks on the unique idempotency index until this commits).
      // (b) The public marketplace install route takes no such lock at all.
      // A partial unique index on (companyId, templateOrigin) would cover both,
      // but it changes `installTeam` semantics for every caller — filed, not
      // done here.
      await acquireCrewRepairAdvisoryLock(tx as unknown as Db, companyId);

      // Re-read inside the lock: a racing repair may have finished since the
      // diagnosis, in which case there is nothing left to create.
      const [existingTeam] = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(
          and(eq(teams.companyId, companyId), eq(teams.templateOrigin, DEFAULT_CREW_TEAM_ITEM_ID)),
        )
        .limit(1);

      for (const { row, entry } of adoptable) {
        // POINTER ONLY. No instructions, no skillKeys, no runtimeConfig, no
        // triggers, no adapter — see this module's docblock.
        const adopted = await adoptLegacyCrewAgentPointer(tx as unknown as Db, {
          companyId,
          agentId: row.id,
          expectedName: row.name,
          expectedTemplateOrigin: row.templateOrigin,
          templateOrigin: entry.templateOrigin,
        });
        if (!adopted) {
          throw new Error(
            `crew repair: legacy agent ${row.id} changed before pointer adoption; rolling back`,
          );
        }
      }

      let teamId = existingTeam?.id ?? null;
      if (!teamId) {
        const slug = await resolveTeamSlugConflict({
          db: tx as unknown as Db,
          companyId,
          desiredSlug: teamBody.slug || "aoa-default-crew",
        });
        const [inserted] = await tx
          .insert(teams)
          .values({
            companyId,
            // D21: company-wide, no parent department — as the bootstrap install.
            parentProjectId: null,
            name: teamItem.name,
            slug,
            description: teamBody.description ?? teamItem.description,
            manifest: teamBody.manifest ?? {},
            templateOrigin: teamItem.id,
            // The PUBLISHED version, not ADOPTED_TEMPLATE_VERSION. The sentinel
            // cannot go here: `TeamManifestSchema` validates `^\d+\.\d+\.\d+$`
            // and `team-export.ts` feeds this field straight in, so a prerelease
            // string would throw on company export. Consequence to know about:
            // if the team-template update check behind
            // `marketplace-update-checker.ts`'s TODO ever lands, a repaired
            // company's TEAM row will read as up to date while its AGENT rows
            // honestly carry the sentinel. Agents are what the updater walks
            // today, so this is inert — revisit when that TODO is picked up.
            templateVersion: teamItem.version,
          })
          .returning({ id: teams.id });
        teamId = inserted.id;
      }

      await linkRosterMembers(tx as unknown as Db, { companyId, teamId, rosterOrigins });
      const operationId = await sealBootstrapOperation(tx as unknown as Db, {
        companyId,
        teamId,
        existingOperationId: diagnosis.operation?.id ?? null,
        requestedByUserId: deps.requestedByUserId ?? null,
      });
      return { teamId, operationId };
    });

    const adoptedItemIds = adoptable.map(({ entry }) => entry.templateOrigin);
    logger.info(
      {
        companyId,
        teamId: committed.teamId,
        operationId: committed.operationId,
        adoptedItemIds,
        unmatchedItemIds: unmatched,
        installedSkillIds,
        adoptedTemplateVersion: ADOPTED_TEMPLATE_VERSION,
      },
      "crew repair: adopted legacy crew rows into marketplace management (pointer only — content " +
        "is left to the policy-respecting update path). This company is now inside the crew " +
        "update pipeline.",
    );
    // Founder-visible, because a boot pass silently changing how their agents
    // are governed is exactly the kind of thing that should not be silent.
    await marketplaceNotifications
      .crewRepaired(db, companyId, adoptedItemIds.length)
      .catch((err: unknown) =>
        logger.warn(
          { error: serializeSafeError(err), companyId },
          "crew repair: founder notification failed",
        ),
      );

    return {
      action: "adopted",
      teamId: committed.teamId,
      adoptedItemIds,
      unmatchedItemIds: unmatched,
      installedSkillIds,
    };
  } finally {
    clearTimeout(timer);
    // Abort, don't merely stop the clock: on any exit every fetch still in
    // flight must be cancelled rather than left running against the CDN.
    deadline.abort();
  }
}

/**
 * Install the roster's required skills this company does not have yet, through
 * the real {@link installSkill}.
 *
 * Already-installed keys are dropped before any work, so a repair on a company
 * that already has them costs nothing. Bounded concurrency for the same reason
 * `installTeam` has it: the live crew team requires 17 skills, and doing them
 * sequentially at the ~2s/request "sluggish CDN" case `crew-bootstrap.ts` is
 * sized against would take ~34s before the git clones. Aggregate time is bounded
 * by concurrency x each item's own fetch/clone timeout rather than by a single
 * deadline — stated plainly rather than claimed tighter than it is.
 *
 * @throws if any skill cannot be installed. The caller fails the whole repair
 * closed: a crew advertising skill keys with no rows behind them is the defect
 * this exists to prevent, and a partially-skilled crew is no better than a
 * retryable one.
 */
async function installMissingRosterSkills(
  db: Db,
  opts: { companyId: string; teamItem: CatalogItem; catalogById: Map<string, CatalogItem> },
): Promise<string[]> {
  const { companyId, teamItem, catalogById } = opts;
  const required = (teamItem.requires ?? [])
    .filter((req) => req.type === "skill")
    .map((req) => catalogById.get(req.id))
    .filter((item): item is CatalogItem => !!item && item.type === "skill");
  if (required.length === 0) return [];

  const existing = (await db
    .select({ key: companySkills.key })
    .from(companySkills)
    .where(
      and(
        eq(companySkills.companyId, companyId),
        inArray(
          companySkills.key,
          required.map((item) => item.id),
        ),
      ),
    )) as Array<{ key: string }>;
  const have = new Set(existing.map((row) => row.key));
  const missing = required.filter((item) => !have.has(item.id));

  // Shared clone cache for this repair, same reasoning as installTeam's: the
  // roster's bundles cluster on a few repos and a `--no-checkout` clone still
  // pulls the whole object database.
  const checkoutCache = createBundleCheckoutCache();
  try {
    await mapWithConcurrency(missing, CREW_REPAIR_FETCH_CONCURRENCY, async (item) => {
      try {
        await installSkill({ catalogItem: item, companyId, db, checkoutCache });
      } catch (cause) {
        throw new CrewSkillInstallError(item.id, cause);
      }
    });
  } finally {
    await disposeBundleCheckoutCache(checkoutCache);
  }
  return missing.map((item) => item.id);
}

/**
 * The `…@legacy` origin slugs a roster entry could have been seeded under.
 * See {@link crewLegacySlugCandidates} — `team-reconcile` derives the identical
 * candidate set and used to carry its own copy of this.
 */
function legacySlugsForRosterEntry(entry: RosterEntry): Set<string> {
  return crewLegacySlugCandidates(entry);
}

/** Does this row's `…@legacy` origin name one of `slugs`? */
function matchesLegacySlug(origin: string | null, slugs: ReadonlySet<string>): boolean {
  if (!origin || !origin.endsWith("@legacy")) return false;
  const slug = origin.slice(0, -"@legacy".length).split("/").pop() ?? "";
  return slugs.has(slug.toLowerCase());
}

/**
 * Agents AoA seeds for itself rather than from the catalog, exempt from the
 * "unaccounted crew rows" refusal.
 *
 * ⚠️ This is NOT a classification input — it never decides whether a company has
 * a crew. It only suppresses a refusal, and it is consulted AFTER roster
 * matching, which makes both stale directions safe: Steward is retained as a
 * historical NULL-origin exemption, but a published roster claims it first; a
 * missing entry refuses, which is the fail-closed direction. An
 * earlier revision used a list like this to decide classification, and a stale
 * entry there minted a duplicate — do not move it back.
 *
 * Matched on the legacy origin slug first so a RENAMED Commander is still
 * recognised. A pre-adoption, renamed NULL-origin Steward falls through to the
 * refusal, which is correct because its identity can no longer be proven.
 *
 * ⚠️ **This membership is deliberately LOCAL, not shared with D23's
 * `PROTECTED_AGENT_ROLES`, even though the two sets are currently identical.**
 * They are safe in *opposite* directions, so aliasing one to the other turns a
 * one-line edit into a silent cross-file semantic change:
 *
 * - In the D23 uninstall guard, a **larger** set means **more** refusals. Its
 *   own docblock states the bias ("over-matching keeps an essential agent
 *   alive, under-matching destroys it"), so that set is under standing pressure
 *   to grow.
 * - Here, a **larger** set means more rows counted as accounted-for → **fewer**
 *   unaccounted rows → **fewer** refusals at the `unaccounted-crew-rows` gate →
 *   repair re-provisions on top of rows it should have refused over. That is
 *   the duplicate-crew outcome this file's header warns about by name.
 *
 * `protected-agents-parity.test.ts` asserts the two sets are equal, so adding a
 * third protected role fails a test and forces a conscious decision here rather
 * than inheriting a widened set. Do not "fix" that test by aliasing.
 *
 * The **matching rule** is local for a second, independent reason:
 * `protectedAgentRole` matches a name regardless of origin, which is right for
 * a destructive guard but wrong here, where a non-NULL origin means the row has
 * already been through roster matching.
 */
export const INFRASTRUCTURE_LEGACY_SLUGS: ReadonlySet<string> = new Set(["commander", "steward"]);
export const INFRASTRUCTURE_NAMES: ReadonlySet<string> = new Set(["Commander", "Steward"]);

function isInfrastructureRow(row: CrewAgentSnapshot): boolean {
  if (matchesLegacySlug(row.templateOrigin, INFRASTRUCTURE_LEGACY_SLUGS)) return true;
  return row.templateOrigin === null && INFRASTRUCTURE_NAMES.has(row.name);
}

/**
 * Can this leftover crew row be safely ignored when deciding whether to install
 * the roster beside it?
 *
 * Two ways to be sure, and one ambiguous case that must fail closed:
 * - **Residual exemption** — Commander is app infrastructure; a historical
 *   NULL-origin Steward may still exist before Phase 4A adoption.
 * - **A `…@legacy` origin naming a role the roster does NOT carry** (a retired
 *   Dispatcher, say). `backfillCrewTemplateOrigin` stamped that slug from the
 *   name at boot and nothing rewrites it, so the row provably is not a renamed
 *   roster member — installing the roster cannot duplicate it.
 * - **A NULL-origin row with a non-roster name** — ambiguous. It could be a
 *   genuinely custom crew agent, or a roster member the founder renamed BEFORE
 *   the backfill could stamp it (backfill matches on `CREW_NAMES`, so a rename
 *   makes the row invisible to it, permanently). We cannot tell, so we refuse.
 *
 * Known false positive: a company carrying a retired `Scribe` row (never in
 * `CREW_NAMES`, so NULL origin) **and no crew at all** is refused rather than
 * provisioned. That is rare — Scribe was seeded alongside a full crew — and the
 * refusal names the row, so it is a short human decision rather than a silent
 * second crew.
 */
function isAccountedFor(row: CrewAgentSnapshot, rosterSlugs: ReadonlySet<string>): boolean {
  if (isInfrastructureRow(row)) return true;
  if (row.templateOrigin?.endsWith("@legacy")) {
    return !matchesLegacySlug(row.templateOrigin, rosterSlugs);
  }
  return false;
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  // Drain every started worker before reporting a failure. `Promise.all` would
  // reject immediately and let siblings keep writing after repair returned
  // (and, for skill installs, after their shared checkout cache was disposed).
  const workers = await Promise.allSettled(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    }),
  );
  const failed = workers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}

function skip(
  diagnosis: CrewRepairDiagnosis,
  reason: CrewRepairSkipReason,
  detail: string,
  skillFailure?: CrewRepairSkillFailure,
): CrewRepairResult {
  const safeDetail = sanitizeErrorText(detail);
  if (reason === "cooldown") {
    logger.debug(
      {
        companyId: diagnosis.companyId,
        verdict: diagnosis.verdict,
        reason,
        detail: safeDetail,
      },
      "crew repair: not attempted (cooldown)",
    );
  } else {
    logger.warn(
      {
        companyId: diagnosis.companyId,
        verdict: diagnosis.verdict,
        reason,
        detail: safeDetail,
      },
      "crew repair: SKIPPED — the company stays degraded and excluded from crew updates",
    );
  }
  return {
    action: "skipped",
    verdict: diagnosis.verdict,
    reason,
    detail: safeDetail,
    ...(skillFailure ? { skillFailure } : {}),
    ...(reason === "install-in-flight"
      ? {
          notBefore: new Date(
            Date.now() + OPERATION_CLAIM_STALE_AFTER_MS,
          ).toISOString(),
        }
      : {}),
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class CrewSkillInstallError extends Error {
  constructor(
    readonly catalogItemId: string,
    override readonly cause: unknown,
  ) {
    super(`crew skill installation failed for ${catalogItemId}`, { cause });
  }
}

function isTransientMarketplaceTransportCause(cause: unknown): boolean {
  let current = cause;
  const seen = new Set<object>();

  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== "object" || seen.has(current)) {
      return false;
    }
    seen.add(current);

    const error = current as {
      cause?: unknown;
      message?: unknown;
      name?: unknown;
      status?: unknown;
    };
    const message =
      typeof error.message === "string" ? error.message.toLowerCase() : "";
    const status =
      typeof error.status === "number"
        ? error.status
        : Number(/\bHTTP\s+(\d{3})\b/i.exec(message)?.[1] ?? NaN);
    if (
      status === 408 ||
      status === 425 ||
      status === 429 ||
      (Number.isInteger(status) && status >= 500 && status <= 599) ||
      error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      message.includes("timed out") ||
      message.includes("timeout")
    ) {
      return true;
    }
    current = error.cause;
  }

  return false;
}

export function classifyCrewSkillFailure(
  catalogItemId: string,
  cause: unknown,
): CrewRepairSkillFailure {
  const error = cause as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
    syscall?: unknown;
    name?: unknown;
  };
  const message =
    typeof error?.message === "string" ? error.message.toLowerCase() : "";
  const code = typeof error?.code === "string" ? error.code.toUpperCase() : "";
  const status =
    typeof error?.status === "number"
      ? error.status
      : Number(/\bHTTP\s+(\d{3})\b/i.exec(message)?.[1] ?? NaN);
  const httpStatus =
    Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : undefined;
  const filesystemOperation =
    typeof error?.syscall === "string" &&
    ["read", "write", "rename", "mkdir"].includes(error.syscall)
      ? (error.syscall as "read" | "write" | "rename" | "mkdir")
      : undefined;
  const wrappedTransportIsTransient =
    cause instanceof MarketplaceResourceFetchError &&
    cause.code === "transport_error" &&
    isTransientMarketplaceTransportCause(cause.cause);

  let failureCode: CrewRepairSkillFailureCode;
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    message.includes("permission denied")
  ) {
    failureCode = "filesystem-permission-denied";
  } else if (code === "ENOENT" || message.includes("skill.md") && message.includes("missing")) {
    failureCode = "bundle-missing";
  } else if (
    httpStatus === 408 ||
    httpStatus === 425 ||
    httpStatus === 429 ||
    (httpStatus !== undefined && httpStatus >= 500) ||
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    wrappedTransportIsTransient
  ) {
    failureCode = "resource-temporarily-unavailable";
  } else if (
    httpStatus !== undefined ||
    message.includes("failed to fetch") ||
    message.includes("dns ") ||
    message.includes("socket")
  ) {
    failureCode = "resource-fetch-failed";
  } else if (
    error?.name === "SyntaxError" ||
    message.includes("invalid") ||
    message.includes("parse")
  ) {
    failureCode = "resource-invalid";
  } else {
    failureCode = "bundle-materialization-failed";
  }

  return {
    code: failureCode,
    catalogItemId:
      catalogItemId.length > 0 && catalogItemId.length <= 160
        ? catalogItemId
        : "unknown",
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(filesystemOperation ? { filesystemOperation } : {}),
    ...(failureCode === "resource-temporarily-unavailable"
      ? { notBefore: new Date(Date.now() + 60_000).toISOString() }
      : {}),
  };
}

/**
 * Link every crew row carrying a roster origin into the crew team, skipping any
 * that is already a member. The first member of an empty team becomes `lead` —
 * the `team_members_one_lead_uq` partial unique index allows exactly one.
 *
 * Errors are NOT swallowed: this runs inside the repair transaction, and a
 * half-linked team is a state `reconcileTeamMembers` would "fix" by installing
 * a duplicate.
 */
async function linkRosterMembers(
  db: Db,
  opts: { companyId: string; teamId: string; rosterOrigins: string[] },
): Promise<void> {
  const { companyId, teamId, rosterOrigins } = opts;
  const rows = (await db
    .select({ id: agents.id, templateOrigin: agents.templateOrigin })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.kind, "aoa")))) as Array<{
    id: string;
    templateOrigin: string | null;
  }>;
  const wanted = new Set(rosterOrigins);
  const members = rows.filter(
    (row) => row.templateOrigin !== null && wanted.has(row.templateOrigin),
  );

  const existing = (await db
    .select({ agentId: teamMembers.agentId, role: teamMembers.role })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId))) as Array<{ agentId: string; role: string }>;
  const existingIds = new Set(existing.map((m) => m.agentId));
  let hasLead = existing.some((m) => m.role === "lead");

  for (const member of members) {
    if (existingIds.has(member.id)) continue;
    await db
      .insert(teamMembers)
      .values({ teamId, agentId: member.id, role: hasLead ? "member" : "lead" });
    hasLead = true;
  }
}

/**
 * Make the `bootstrap-crew:<companyId>` operation row terminal and honest.
 *
 * Load-bearing, not cosmetic. `claimOperationForDispatch` treats `pending`,
 * `failure`, and stale `running` as claimable; `success` is not. So an unsealed
 * row is a standing invitation for the next `provisionCompanyCrew` to re-run
 * `installTeam` over a company that already has its roster.
 *
 * Only ever called on a COMPLETE repair — never over a partial adoption, which
 * would make the audit record false AND put the row beyond a retry's reach.
 */
async function sealBootstrapOperation(
  db: Db,
  opts: {
    companyId: string;
    teamId: string;
    existingOperationId: string | null;
    requestedByUserId: string | null;
  },
): Promise<string> {
  const { companyId, teamId, existingOperationId, requestedByUserId } = opts;
  if (existingOperationId) {
    await updateOperation(db, existingOperationId, {
      status: "success",
      resultEntityId: teamId,
      errorMessage: null,
      completedAt: new Date(),
    });
    return existingOperationId;
  }

  const idempotencyKey = crewBootstrapIdempotencyKey(companyId);
  const [inserted] = await db
    .insert(marketplaceInstallOperations)
    .values({
      companyId,
      catalogItemId: DEFAULT_CREW_TEAM_ITEM_ID,
      itemType: "team",
      status: "success",
      resultEntityId: teamId,
      idempotencyKey,
      requestedByUserId: requestedByUserId ?? "system:crew-repair",
      completedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: marketplaceInstallOperations.id });
  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: marketplaceInstallOperations.id })
    .from(marketplaceInstallOperations)
    .where(
      and(
        eq(marketplaceInstallOperations.companyId, companyId),
        eq(marketplaceInstallOperations.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error(`crew repair: operation row for ${idempotencyKey} vanished mid-seal`);
  }
  await updateOperation(db, existing.id, {
    status: "success",
    resultEntityId: teamId,
    errorMessage: null,
    completedAt: new Date(),
  });
  return existing.id;
}

// ── Attempt throttling ───────────────────────────────────────────────────────

/**
 * Minimum gap between repair attempts for the SAME company, enforced inside
 * {@link repairCompanyCrew} so EVERY entry point is covered — the founder route
 * included (it can opt out per call with `force`).
 *
 * Deliberately process-local. It is the guard against tight re-entry — a route
 * in a loop, or the 24h interval landing next to a boot — not against a
 * crash-looping process. Nothing durable is claimed here and nothing needs to
 * be: a failed repair writes nothing (all writes are one transaction), and
 * {@link CREW_REPAIR_MAX_PER_PASS} bounds each pass regardless.
 */
export const CREW_REPAIR_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** companyId → last attempt timestamp. Cleared on restart, by design. */
const recentAttempts = new Map<string, number>();

/** Test seam: the clock the cooldown reads. */
let repairClock: () => number = () => Date.now();

/**
 * Floor that applies even to an explicit `force`.
 *
 * `force` exists so a founder who has just fixed the underlying cause does not
 * wait six hours. It is not a licence to loop: repair fetches `team.json` and
 * materializes every missing skill bundle, and on a crewless company it runs a
 * full `provisionCompanyCrew` (catalog wait + install deadline + ~10 fetches +
 * ~17 bundle materializations). One minute is far below any human retry cadence
 * and far above a scripted one.
 */
export const CREW_REPAIR_FORCE_FLOOR_MS = 60_000;

/** @returns true if this caller may attempt a repair now. */
function claimRepairAttempt(companyId: string, minGapMs: number): boolean {
  const now = repairClock();
  const last = recentAttempts.get(companyId);
  if (last !== undefined && now - last < minGapMs) return false;
  recentAttempts.set(companyId, now);
  return true;
}

/** Test seam — drops the in-process cooldown state and restores the real clock. */
export function resetCrewRepairCooldowns(): void {
  recentAttempts.clear();
  repairClock = () => Date.now();
}

/** Test seam — pin the cooldown clock. */
export function setCrewRepairClock(clock: () => number): void {
  repairClock = clock;
}

// ── Boot-time reconcile ──────────────────────────────────────────────────────

export interface CrewRepairPassResult {
  /** The catalog contained the default crew team required to diagnose repairs. */
  catalogReady: boolean;
  inspected: number;
  /** Companies that were degraded and were changed by this pass. */
  repaired: number;
  /** Degraded, attempted, and deliberately not repaired (fail-closed). */
  skippedFailClosed: number;
  /** Degraded but within {@link CREW_REPAIR_COOLDOWN_MS} of a prior attempt. */
  skippedCooldown: number;
  /** Degraded but this pass had already spent its budget. */
  skippedOverBudget: number;
  /** Diagnosis or repair threw. */
  failed: number;
  /** One safe, structured entry for every skip counter increment. */
  skips: CrewRepairPassSkip[];
}

export interface CrewRepairPassSkip {
  companyId: string;
  category: "fail_closed" | "cooldown" | "over_budget";
  reason: CrewRepairSkipReason | "repair-budget-exhausted";
  notBefore?: string;
  skillFailure?: CrewRepairSkillFailure;
}

export interface CrewRepairPassFailure {
  companyId: string;
  error: unknown;
}

/**
 * Boot/interval reconcile: diagnose every company and repair the degraded ones.
 *
 * **Why a pass and not only a route:** the companies that need this are, by
 * construction, the ones whose founder has no idea anything is wrong — the crew
 * looks present and simply never receives an update. A button only helps
 * someone who already knows to press it.
 *
 * Costs one diagnosis per company and NOTHING else for a healthy one, and
 * reuses the catalog the caller already loaded, so it adds zero catalog fetches.
 */
export async function runCrewRepairPass(opts: {
  db: Db;
  companyIds: readonly string[];
  catalogItems: readonly CatalogItem[];
  maxPerPass?: number;
  force?: boolean;
  onFailure?: (failure: CrewRepairPassFailure) => void;
}): Promise<CrewRepairPassResult> {
  const { db, companyIds, catalogItems } = opts;
  const maxPerPass = opts.maxPerPass ?? CREW_REPAIR_MAX_PER_PASS;
  const result: CrewRepairPassResult = {
    catalogReady: true,
    inspected: 0,
    repaired: 0,
    skippedFailClosed: 0,
    skippedCooldown: 0,
    skippedOverBudget: 0,
    failed: 0,
    skips: [],
  };

  // A cache row can exist whose `items` array lacks the crew team (an empty or
  // partial catalog). Without that item there is nothing to repair TOWARDS, and
  // a crewless company would enter provisioning only to degrade to legacy off a
  // catalog that never had the team. Gate on the item, not on "a catalog exists".
  const teamItem = catalogItems.find(
    (item) => item.id === DEFAULT_CREW_TEAM_ITEM_ID && item.type === "team",
  );
  if (!teamItem) {
    result.catalogReady = false;
    logger.debug(
      { teamItemId: DEFAULT_CREW_TEAM_ITEM_ID },
      "crew repair pass: crew team item absent from the catalog — nothing to repair towards",
    );
    return result;
  }

  let budget = maxPerPass;
  for (const companyId of companyIds) {
    try {
      // Diagnosis runs for EVERY company, budget or no budget — three indexed
      // queries, in line with what the surrounding update pass already spends
      // per company. Stopping the loop on budget exhaustion would make
      // `inspected` a function of list order and hide how many are degraded.
      const diagnosis = await diagnoseCrewProvisioning(db, companyId);
      result.inspected += 1;
      if (diagnosis.verdict === "healthy") continue;

      if (budget <= 0) {
        result.skippedOverBudget += 1;
        result.skips.push({
          companyId,
          category: "over_budget",
          reason: "repair-budget-exhausted",
        });
        continue;
      }

      const repair = await repairCompanyCrew(db, companyId, {
        catalogItems,
        requestedByUserId: "system:crew-repair",
        force: opts.force,
      });
      if (repair.action === "skipped") {
        if (repair.reason === "cooldown") {
          result.skippedCooldown += 1;
          const minGapMs = opts.force
            ? CREW_REPAIR_FORCE_FLOOR_MS
            : CREW_REPAIR_COOLDOWN_MS;
          result.skips.push({
            companyId,
            category: "cooldown",
            reason: repair.reason,
            notBefore: new Date(
              (recentAttempts.get(companyId) ?? repairClock()) + minGapMs,
            ).toISOString(),
          });
        } else {
          result.skippedFailClosed += 1;
          result.skips.push({
            companyId,
            category: "fail_closed",
            reason: repair.reason,
            ...(repair.skillFailure
              ? { skillFailure: repair.skillFailure }
              : {}),
            ...(repair.notBefore || repair.skillFailure?.notBefore
              ? {
                  notBefore:
                    repair.notBefore ?? repair.skillFailure?.notBefore,
                }
              : {}),
          });
        }
        // Neither consumes budget: a skip did no productive work, and charging
        // for it lets a few unrepairable companies starve the rest forever.
      } else if (repair.action === "none") {
        // Raced healthy between the diagnosis above and the repair's own
        // re-diagnosis. Nothing happened, so it is neither repaired nor charged.
      } else {
        result.repaired += 1;
        budget -= 1;
      }
    } catch (err) {
      result.failed += 1;
      opts.onFailure?.({ companyId, error: err });
      logger.warn(
        { error: serializeSafeError(err), companyId },
        "crew repair pass failed for company",
      );
    }
  }

  if (result.repaired > 0 || result.failed > 0 || result.skippedFailClosed > 0) {
    logger.info(
      {
        catalogReady: result.catalogReady,
        inspected: result.inspected,
        repaired: result.repaired,
        skippedFailClosed: result.skippedFailClosed,
        skippedCooldown: result.skippedCooldown,
        skippedOverBudget: result.skippedOverBudget,
        failed: result.failed,
        skips: result.skips.map((entry) => ({
          companyId: entry.companyId,
          category: entry.category,
          reason: entry.reason,
          notBefore: entry.notBefore,
          ...(entry.skillFailure
            ? {
                skillFailure: {
                  code: entry.skillFailure.code,
                  catalogItemId: entry.skillFailure.catalogItemId,
                  httpStatus: entry.skillFailure.httpStatus,
                  filesystemOperation:
                    entry.skillFailure.filesystemOperation,
                  notBefore: entry.skillFailure.notBefore,
                },
              }
            : {}),
        })),
      },
      "crew provisioning repair pass complete",
    );
  }
  return result;
}
