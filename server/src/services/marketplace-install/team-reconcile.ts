// server/src/services/marketplace-install/team-reconcile.ts
//
// WS6 — member-add-on-update reconciliation for installed team packages.
//
// checkCrewUpdates (crew-updater.ts) only walks agent rows that are already
// installed (`agents` where kind='aoa'), so it can update an existing
// Adjutant/Scout/etc. row to a new catalog version, but it has NO way to
// discover that team.json grew a NEW roster member since the company
// installed the team — there is no installed row for that member to find.
//
// TODO(WS6-marketplace-cdn): this is the AoA-side half of a two-part change.
// The other half is a PR against https://github.com/MeteoriteLabs/aoa-marketplace-cdn
// adding the Librarian to the `aoa-curated/standard-crew` team package's
// team.json `agents` array (templateOrigin `aoa-curated/standard-crew/librarian`,
// NOT `@legacy`). Until that catalog PR lands + `pnpm fetch-catalog` refreshes
// the local snapshot, this function has nothing to reconcile (every installed
// team's `agents` list will already match what's installed) — it is inert,
// not broken, in the interim.
//
// This function walks each company's installed `teams` rows, re-fetches the
// team's current team.json from the catalog, diffs its `agents` list against
// what's already linked via `team_members`, and installs whatever is
// missing — reusing the exact `createMarketplaceAgent` path team-installer.ts
// uses for a fresh install. Each missing member is installed independently
// (its own transaction inside createMarketplaceAgent) so one member's
// failure never blocks the others or corrupts the team's existing roster.

import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { teams, teamMembers, agents } from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";
import { fetchCatalogResource } from "./fetch-resource.js";
import { parseMarketplaceAgentTemplate, normalizeMarketplaceAgentTemplate } from "./agent-runtime.js";
import { createMarketplaceAgent } from "./agent-create.js";
import type { AgentInstructionsServiceLike } from "./agent-create.js";
import { resolveAgentNameConflict } from "./conflict-resolver.js";
import { crewLegacySlugCandidates } from "./crew-constants.js";
import { logger } from "../../middleware/logger.js";
import { serializeSafeError } from "../safe-error.js";

interface TeamTemplateBody {
  slug: string;
  description?: string;
  manifest?: Record<string, unknown>;
  agents: Array<{ templateOrigin: string; name: string; overrides?: Record<string, unknown> }>;
}

export interface ReconcileTeamMembersOpts {
  db: Db;
  companyId: string;
  catalogItems: CatalogItem[];
  instructionsService: AgentInstructionsServiceLike;
  onFailure?: (failure: ReconcileTeamMembersFailure) => void;
}

export interface ReconcileTeamMembersFailure {
  companyId: string;
  teamId: string;
  templateOrigin?: string;
  stage: "team_template" | "member_install";
  error: unknown;
}

export interface ReconcileTeamMembersResult {
  /** Number of installed teams that had at least one member added. */
  teamsReconciled: number;
  /** Total roster members installed across all teams for this company. */
  membersAdded: number;
}

/**
 * Reconcile every installed team for a company against the current catalog
 * roster. Best-effort throughout: a failure fetching/parsing one team's
 * template, or installing one missing member, is logged and skipped — it
 * never aborts reconciliation for the company's other teams or members.
 */
export async function reconcileTeamMembers(
  opts: ReconcileTeamMembersOpts,
): Promise<ReconcileTeamMembersResult> {
  const { db, companyId, catalogItems, instructionsService } = opts;
  const catalogById = new Map(catalogItems.map((item) => [item.id, item]));
  const result: ReconcileTeamMembersResult = { teamsReconciled: 0, membersAdded: 0 };

  const teamRows = await db
    .select({ id: teams.id, templateOrigin: teams.templateOrigin })
    .from(teams)
    .where(eq(teams.companyId, companyId));

  for (const teamRow of teamRows as Array<{ id: string; templateOrigin: string | null }>) {
    if (!teamRow.templateOrigin) continue; // not a catalog-installed team
    const catalogTeamItem = catalogById.get(teamRow.templateOrigin);
    if (!catalogTeamItem || catalogTeamItem.type !== "team") continue; // team retired/renamed in catalog

    let teamBody: TeamTemplateBody;
    try {
      const text = await fetchCatalogResource(catalogTeamItem, "team template (reconcile)");
      teamBody = JSON.parse(text) as TeamTemplateBody;
    } catch (err) {
      opts.onFailure?.({
        companyId,
        teamId: teamRow.id,
        stage: "team_template",
        error: err,
      });
      logger.error(
        { error: serializeSafeError(err), companyId, teamId: teamRow.id },
        "team-reconcile: failed to fetch/parse team template — skipping this team",
      );
      continue;
    }
    if (!Array.isArray(teamBody.agents) || teamBody.agents.length === 0) continue;

    const existingMembers = await db
      .select({ templateOrigin: agents.templateOrigin })
      .from(teamMembers)
      .innerJoin(agents, eq(agents.id, teamMembers.agentId))
      .where(eq(teamMembers.teamId, teamRow.id));
    const installedOrigins = new Set(
      (existingMembers as Array<{ templateOrigin: string | null }>)
        .map((m) => m.templateOrigin)
        .filter((v): v is string => Boolean(v)),
    );

    const missing = teamBody.agents.filter((a) => !installedOrigins.has(a.templateOrigin));
    if (missing.length === 0) continue;

    // A roster member is "missing" here purely because no TEAM MEMBER carries
    // its origin — which cannot distinguish "this company never had one" from
    // "this company has one that is not yet origin-stamped or not yet linked".
    // Installing in the second case renames the newcomer (`Adjutant-2`) and
    // strands the original row forever: the next pass sees the origin present
    // and skips it, so the row every task and run points at is never adopted.
    //
    // This fires today for a legacy Steward/Chronicler (NULL origin, absent
    // from `CREW_NAMES`) and for any partially-adopted crew. Name collision is
    // the right test because it is exactly what `resolveAgentNameConflict`
    // would have renamed around.
    const unmanagedRows = (
      (await db
        .select({ name: agents.name, templateOrigin: agents.templateOrigin })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.kind, "aoa")))) as Array<{
        name: string;
        templateOrigin: string | null;
      }>
    ).filter((row) => !row.templateOrigin || row.templateOrigin.endsWith("@legacy"));
    const unmanagedNames = new Set(unmanagedRows.map((row) => row.name));
    // Name alone is not enough: a founder can rename a crew agent without
    // touching `templateOrigin`, and `backfillCrewTemplateOrigin`'s
    // `…/<slug>@legacy` stamp survives that rename. Match on either.
    const unmanagedLegacySlugs = new Set(
      unmanagedRows
        .map((row) => row.templateOrigin)
        .filter((origin): origin is string => !!origin && origin.endsWith("@legacy"))
        .map((origin) => origin.slice(0, -"@legacy".length).split("/").pop()!.toLowerCase()),
    );

    let addedForThisTeam = 0;
    for (const memberSpec of missing) {
      if (
        unmanagedNames.has(memberSpec.name) ||
        [...crewLegacySlugCandidates(memberSpec)].some((slug) => unmanagedLegacySlugs.has(slug))
      ) {
        opts.onFailure?.({
          companyId,
          teamId: teamRow.id,
          templateOrigin: memberSpec.templateOrigin,
          stage: "member_install",
          error: new Error(
            `Unmanaged agent collision for roster member ${memberSpec.templateOrigin}`,
          ),
        });
        logger.warn(
          { companyId, teamId: teamRow.id, templateOrigin: memberSpec.templateOrigin, name: memberSpec.name },
          "team-reconcile: an unmanaged agent already holds this roster member's name — refusing " +
            "to install a renamed duplicate. Run crew repair to adopt the existing row instead.",
        );
        continue;
      }
      const agentItem = catalogById.get(memberSpec.templateOrigin);
      if (!agentItem || agentItem.type !== "agent") {
        opts.onFailure?.({
          companyId,
          teamId: teamRow.id,
          templateOrigin: memberSpec.templateOrigin,
          stage: "member_install",
          error: new Error(
            `Roster member ${memberSpec.templateOrigin} is missing from the catalog or is not an agent`,
          ),
        });
        logger.warn(
          { companyId, teamId: teamRow.id, templateOrigin: memberSpec.templateOrigin },
          "team-reconcile: roster member not found in catalog (or wrong type) — skipping",
        );
        continue;
      }
      try {
        const text = await fetchCatalogResource(agentItem, "agent template (reconcile)");
        const parsed = parseMarketplaceAgentTemplate(text, agentItem);
        const normalized = normalizeMarketplaceAgentTemplate({
          parsed,
          catalogItem: agentItem,
          availableAdapterTypes: [],
        });
        const resolvedName = await resolveAgentNameConflict({
          db,
          companyId,
          desiredName: memberSpec.name,
        });
        const { agentId } = await createMarketplaceAgent({
          catalogItem: agentItem,
          companyId,
          db,
          desiredName: resolvedName,
          template: normalized,
          instructionsService,
        });
        await db.insert(teamMembers).values({ teamId: teamRow.id, agentId, role: "member" });
        addedForThisTeam += 1;
        result.membersAdded += 1;
        logger.info(
          { companyId, teamId: teamRow.id, agentId, templateOrigin: memberSpec.templateOrigin },
          "team-reconcile: added missing roster member to existing team install",
        );
      } catch (err) {
        opts.onFailure?.({
          companyId,
          teamId: teamRow.id,
          templateOrigin: memberSpec.templateOrigin,
          stage: "member_install",
          error: err,
        });
        logger.error(
          {
            error: serializeSafeError(err),
            companyId,
            teamId: teamRow.id,
            templateOrigin: memberSpec.templateOrigin,
          },
          "team-reconcile: failed to install missing roster member",
        );
      }
    }
    if (addedForThisTeam > 0) result.teamsReconciled += 1;
  }

  return result;
}
