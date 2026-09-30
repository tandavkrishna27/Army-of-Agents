/**
 * @fileoverview Constants shared between crew repair (T2.3b) and the install
 * machinery it has to stay consistent with.
 *
 * This module exists to break an import cycle, not to be a grab-bag: `resolver`
 * needs to recognise an adopted row, and `crew-repair` needs `resolver`'s
 * neighbours, so the value cannot live in either. Keep it to values that more
 * than one side genuinely reads.
 */
import type { CatalogItem } from "@armyofagents/shared";

/**
 * The `templateVersion` a crew row carries after T2.3b adoption re-points it at
 * its catalog template.
 *
 * It must be non-null (`crew-updater` skips rows without one) and must never
 * equal a published catalog version (or the updater would think the row is
 * synced when it still holds pre-catalog content). A `0.0.0` prerelease
 * satisfies both and is honest about what the row actually contains. Do NOT
 * replace it with the current catalog version — that would claim the row is up
 * to date with content it has never seen.
 *
 * ⚠️ Agent rows only. It must never be written to `teams.templateVersion`:
 * `TeamManifestSchema` validates `^\d+\.\d+\.\d+$` and `team-export.ts` feeds
 * that field straight in, so a prerelease string would throw on company export.
 */
export const ADOPTED_TEMPLATE_VERSION = "0.0.0-legacy";

/** Published identity of the Steward agent that curates the Inbox Hub. */
export const STEWARD_CATALOG_ITEM_ID = "agent:aoa-curated/aoa-steward";

/** Published identity of the default marketplace crew team. */
export const DEFAULT_CREW_TEAM_ITEM_ID = "team:aoa-curated/default-crew";

/**
 * Whether a catalog is safe to use as the ownership source for Steward.
 *
 * This is stricter than a generic dependency lookup: both protected items must
 * be unique and active, and the default crew must require Steward exactly once
 * as an agent. A stale or ambiguous catalog must fall back to the legacy crew
 * rather than commit a managed company with no Steward.
 */
export function catalogPublishesStewardInDefaultCrew(
  catalogItems: readonly CatalogItem[],
): boolean {
  const teamItems = catalogItems.filter((item) => item.id === DEFAULT_CREW_TEAM_ITEM_ID);
  const stewardItems = catalogItems.filter((item) => item.id === STEWARD_CATALOG_ITEM_ID);
  if (teamItems.length !== 1 || stewardItems.length !== 1) return false;

  const teamItem = teamItems[0];
  const stewardItem = stewardItems[0];
  if (
    teamItem.type !== "team" ||
    teamItem.status !== "active" ||
    stewardItem.type !== "agent" ||
    stewardItem.status !== "active"
  ) {
    return false;
  }

  const stewardRequirements = (teamItem.requires ?? []).filter(
    (requirement) =>
      requirement.type === "agent" && requirement.id === STEWARD_CATALOG_ITEM_ID,
  );
  return stewardRequirements.length === 1;
}

/**
 * Maximum number of productive crew repairs or legacy adoptions in one fleet
 * pass. Fail-closed and already-converged companies do not consume a slot.
 */
export const CREW_REPAIR_MAX_PER_PASS = 5;

/**
 * Every `…@legacy` origin slug a catalog roster entry could have been seeded
 * under locally, given its published id and display name.
 *
 * `backfillCrewTemplateOrigin` derives its slug from the agent's NAME at boot
 * (`lower(replace(name,' ','-'))`), and the catalog id's last segment is the
 * same role with an `aoa-` prefix. All three are offered because none is
 * guaranteed: a role can be published under an id that does not match its
 * display name, and the `aoa-` prefix is a publishing convention rather than a
 * contract.
 *
 * Shared by `crew-repair.legacySlugsForRosterEntry` and
 * `team-reconcile.legacySlugsFor`, which were byte-identical implementations of
 * this — and are on the SAME side of the matching problem (both ask "could this
 * roster entry already exist locally under a legacy origin?"), so a change here
 * moves them together in the same direction.
 *
 * ⚠️ Deliberately NOT shared with `services/protected-agents.ts`'s
 * `agentRoleSlugFromOrigin`, which looks superficially similar. That one
 * resolves a single canonical slug for a **destructive guard**, where a broader
 * parse means more protection; here a broader parse means more roster matches,
 * hence FEWER `unaccounted-crew-rows` refusals. Same direction hazard as the
 * membership sets (see `crew-repair.ts`), so the parsing stays split too.
 */
export function crewLegacySlugCandidates(entry: {
  templateOrigin: string;
  name: string;
}): Set<string> {
  const fromName = entry.name.trim().toLowerCase().replace(/\s+/g, "-");
  const idTail = (entry.templateOrigin.split("/").pop() ?? "").toLowerCase();
  return new Set([fromName, idTail, idTail.replace(/^aoa-/, "")].filter(Boolean));
}
