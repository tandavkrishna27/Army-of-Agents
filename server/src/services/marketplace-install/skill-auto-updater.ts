/**
 * @fileoverview Auto-applies a catalog skill update for a company.
 *
 * Gating logic (policy + window) lives in the update checker. This module
 * owns the transactional apply: re-checks the `customized` flag inside the
 * transaction to avoid acting on stale data, then updates the skill's markdown,
 * re-derives the bundle-backed columns (trustLevel / fileInventory / bundle
 * pointer) from what was materialized — clearing them when upstream drops the
 * bundle, T2.8c(a) — and marks the pending row as applied.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companySkills, marketplacePendingUpdates } from "@armyofagents/db";
import type { CatalogItem, MarketplaceSettings } from "@armyofagents/shared";
import { loadSkillContent } from "./fetch-resource.js";
import {
  managedCatalogSkillDir,
  materializeSkillBundle,
  type MaterializeSkillBundleResult,
} from "./skill-bundle-materializer.js";
import { resolveBundleColumns } from "./skill-bundle-columns.js";
import { marketplaceNotifications } from "../marketplace-notifications.js";
import { logger } from "../../middleware/logger.js";

export type UpdateWindow = MarketplaceSettings["updateWindow"];

/**
 * Returns true if the current UTC time falls within the configured update window.
 * @param window - The update window setting from company marketplace settings.
 * @param now - Defaults to new Date(). Pass a fixed date in tests.
 */
export function isWithinUpdateWindow(setting: UpdateWindow, now: Date = new Date()): boolean {
  const hour = now.getUTCHours();
  const day = now.getUTCDay(); // 0 = Sunday, 6 = Saturday

  switch (setting) {
    case "anytime":   return true;
    case "off_hours": return hour < 8 || hour >= 20;
    case "weekends":  return day === 0 || day === 6;
    default: {
      const _exhaustive: never = setting;
      logger.error({ setting: _exhaustive }, "marketplace: unknown updateWindow setting, defaulting to false");
      return false;
    }
  }
}

/** Thrown when the skill was customized by the founder — fall back to notify. */
export class SkillCustomizedError extends Error {
  constructor(catalogItemId: string) {
    super(`Skill ${catalogItemId} has been customized by the founder; skipping auto-apply`);
    this.name = "SkillCustomizedError";
  }
}

/** Thrown when the skill row no longer exists — skip silently, no notification. */
export class SkillDeletedError extends Error {
  constructor(catalogItemId: string) {
    super(`Skill ${catalogItemId} not found in company_skills; may have been deleted`);
    this.name = "SkillDeletedError";
  }
}

/**
 * Auto-applies a catalog skill update to a company's installed skill.
 *
 * Steps:
 * 1. Fetch the new content (network call, outside transaction).
 * 2. Inside a transaction: re-read `customized` flag; throw typed errors if
 *    customized or deleted; update markdown + sourceRef; mark pending as applied.
 * 3. Fire updateCompleted notification (outside transaction — failure is logged,
 *    not rethrown, because the DB is already committed).
 *
 * Throws: SkillCustomizedError | SkillDeletedError | Error (fetch/DB failures).
 * Callers are responsible for catching and deciding the fallback.
 */
export async function applySkillUpdate(args: {
  db: Db;
  catalogItemId: string;
  catalogItemName: string;
  companyId: string;
  catalogItem: CatalogItem;
}): Promise<void> {
  const { db, catalogItemId, catalogItemName, companyId, catalogItem } = args;

  // Step 1: fetch content + materialize any bundle outside the transaction
  // (network + git — don't hold the tx open for either).
  const { markdown, materialized } = await resolveSkillUpdatePayload(catalogItem, companyId);

  // Step 2: transaction — re-read customized, update skill, mark pending applied
  await db.transaction(async (tx) => {
    const [skillRow] = await tx
      .select({ id: companySkills.id, customized: companySkills.customized, metadata: companySkills.metadata })
      .from(companySkills)
      .where(
        and(
          eq(companySkills.companyId, companyId),
          eq(companySkills.sourceLocator, catalogItemId),
        ),
      )
      .limit(1);

    if (!skillRow) throw new SkillDeletedError(catalogItemId);
    if (skillRow.customized) throw new SkillCustomizedError(catalogItemId);

    // Optimistic-lock: add AND customized=false to WHERE. If a concurrent founder edit
    // committed customized=true between our SELECT and this UPDATE, RETURNING is empty
    // and we throw rather than silently overwriting.
    //
    // Known approximation: empty RETURNING could also mean the row was hard-deleted in
    // the same window. In that case we throw SkillCustomizedError instead of the more
    // precise SkillDeletedError. The caller fires a spurious "update available"
    // notification — a low-harm false positive given the rarity of concurrent delete +
    // auto-apply. A second SELECT to distinguish the cases is not worth the extra
    // round-trip here.
    //
    // `resolveBundleColumns` (shared with the reviewed-merge path) recomputes
    // trustLevel / fileInventory / the bundle pointer from what was actually
    // materialized. Crucially it CLEARS them when the upstream item has stopped
    // carrying a bundle but this row still names an old one — the C3 gap fixed
    // for the merge path in T2.8 and here (auto-apply) in T2.8c(a). `metadata`
    // carries the row's existing keys forward, so this stays a patch.
    const updatedRows = await tx
      .update(companySkills)
      .set({
        markdown,
        sourceRef: catalogItem.version,
        ...resolveBundleColumns(skillRow.metadata, catalogItem.skill?.bundle, materialized, {
          catalogProvider: catalogItem.provider ?? null,
        }),
        updatedAt: new Date(),
      })
      .where(and(
        eq(companySkills.id, skillRow.id),
        eq(companySkills.customized, false),
      ))
      .returning({ id: companySkills.id });

    if (updatedRows.length === 0) {
      // Concurrent edit (or rare delete race) won — treat as customized.
      throw new SkillCustomizedError(catalogItemId);
    }

    // Mark the pending row applied (filter by catalogItemId + status=pending so a
    // concurrent run that already applied it is a no-op, not an error)
    await tx
      .update(marketplacePendingUpdates)
      .set({ status: "applied", updatedAt: new Date() })
      .where(
        and(
          eq(marketplacePendingUpdates.companyId, companyId),
          eq(marketplacePendingUpdates.catalogItemId, catalogItemId),
          eq(marketplacePendingUpdates.status, "pending"),
        ),
      );
  });

  // Step 3: notify — swallow errors so they don't unwind the committed transaction
  try {
    await marketplaceNotifications.updateCompleted(db, companyId, catalogItemName);
  } catch (err) {
    logger.error({ err, companyId, catalogItemId }, "marketplace: updateCompleted notification failed after auto-apply");
  }
}

/**
 * The markdown to write, plus the materialized bundle tree (or null when the
 * upstream item carries no bundle). The bundle-derived columns are computed
 * inside the transaction by {@link resolveBundleColumns}, which needs the row's
 * current metadata to decide whether a bundle is being dropped.
 */
async function resolveSkillUpdatePayload(
  catalogItem: CatalogItem,
  companyId: string,
): Promise<{ markdown: string; materialized: MaterializeSkillBundleResult | null }> {
  if (!catalogItem.skill?.bundle) {
    return { markdown: await loadSkillContent(catalogItem), materialized: null };
  }

  const managedDir = managedCatalogSkillDir(companyId, catalogItem.id, catalogItem.version);
  const materialized = await materializeSkillBundle(catalogItem.skill.bundle, {
    destination: managedDir,
    overwrite: true,
  });
  return { markdown: materialized.markdown, materialized };
}
