/**
 * @fileoverview Marketplace notification helpers.
 *
 * Emits notifications to company founders for marketplace events:
 * - marketplace.install_completed
 * - marketplace.install_failed
 * - marketplace.install_requested
 * - marketplace.update_available
 * - marketplace.update_completed
 * - marketplace.update_failed
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { hubItems, userRoles } from "@armyofagents/db";
import { hubItemsService } from "./hub-items.js";
import { logger } from "../middleware/logger.js";

async function archiveSupersededUpdateNotifications(
  db: Db,
  hub: ReturnType<typeof hubItemsService>,
  companyId: string,
  ownerUserId: string,
  legacySourcePrefix: string
): Promise<void> {
  const openUpdateItems = await db
    .select({
      id: hubItems.id,
      version: hubItems.version,
      sourceId: hubItems.sourceId,
    })
    .from(hubItems)
    .where(
      and(
        eq(hubItems.companyId, companyId),
        eq(hubItems.ownerUserId, ownerUserId),
        eq(hubItems.semanticType, "marketplace_op"),
        eq(hubItems.sourceType, "marketplace_update"),
        eq(hubItems.status, "open")
      )
    );

  for (const item of openUpdateItems) {
    if (!item.sourceId?.startsWith(legacySourcePrefix)) continue;
    await hub.recordLifecycleAction({
      companyId,
      hubItemId: item.id,
      action: "archive",
      expectedVersion: item.version,
      actorType: "system",
      actorId: "marketplace-notifications",
      actorIsFounder: true,
      authorityBasis: "marketplace_update_superseded",
      reason: "Superseded by the catalog item's stable update notification.",
      idempotencyKey: `marketplace-update-supersede:${item.id}:${item.version}`,
    });
  }
}

async function notifyFounders(
  db: Db,
  companyId: string,
  notification: {
    type: string;
    title: string;
    message?: string;
    relatedEntityType?: string;
    // Stable per-event source id. All marketplace events share semanticType
    // `marketplace_op`, so the source id MUST encode the event type (so distinct
    // events don't collide on one open hub row), plus the operation/catalog ref.
    sourceId: string;
    legacySourcePrefix?: string;
    reopenWhenArchived?: boolean;
  }
): Promise<void> {
  try {
    // Query founders for the company (role = 'founder', no project scope = company-level role)
    const founders = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.companyId, companyId),
          eq(userRoles.role, "founder"),
          isNull(userRoles.projectId)
        )
      );

    const hub = hubItemsService(db);
    // Each founder is the natural owner of their own hub row; the source id folds
    // in the recipient so per-founder rows stay distinct (and dedupe per founder).
    const emitFor = async (ownerUserId: string) => {
      if (notification.legacySourcePrefix) {
        await archiveSupersededUpdateNotifications(
          db,
          hub,
          companyId,
          ownerUserId,
          notification.legacySourcePrefix
        );
      }
      return hub.emit({
        companyId,
        semanticType: "marketplace_op",
        sourceType: notification.relatedEntityType ?? "marketplace_operation",
        sourceId: `${notification.sourceId}:${ownerUserId}`,
        title: notification.title,
        summary: notification.message ?? null,
        ownerUserId,
        reopenWhenArchived: notification.reopenWhenArchived,
      });
    };

    if (founders.length === 0) {
      // Fallback: notify local-board user
      await emitFor("local-board");
      return;
    }

    await Promise.all(
      founders.filter((r) => r.userId).map((r) => emitFor(r.userId!))
    );
  } catch (err) {
    logger.error(
      { err, companyId },
      "marketplace-notifications: failed to notify founders"
    );
    // Callers decide whether a marketplace mutation is allowed to continue
    // without its founder notification. Reconciliation must observe this
    // failure so the pass is partial and a later update check can retry the
    // idempotent hub emit.
    throw err;
  }
}

export const marketplaceNotifications = {
  installCompleted: (
    db: Db,
    companyId: string,
    catalogItemName: string,
    operationId: string
  ) =>
    notifyFounders(db, companyId, {
      type: "marketplace.install_completed",
      title: `${catalogItemName} installed`,
      message: "Marketplace install completed successfully.",
      relatedEntityType: "marketplace_operation",
      sourceId: `install_completed:${operationId}`,
    }),

  installRequested: (
    db: Db,
    companyId: string,
    catalogItemName: string,
    requestingUserId: string,
    operationId?: string
  ) =>
    notifyFounders(db, companyId, {
      type: "marketplace.install_requested",
      title: `Install requested: ${catalogItemName}`,
      message: `User ${requestingUserId} requested installation of ${catalogItemName}.`,
      relatedEntityType: "marketplace_operation",
      sourceId: `install_requested:${operationId ?? catalogItemName}`,
    }),

  installFailed: (
    db: Db,
    companyId: string,
    catalogItemName: string,
    error: string
  ) =>
    notifyFounders(db, companyId, {
      type: "marketplace.install_failed",
      title: `${catalogItemName} install failed`,
      message: error,
      relatedEntityType: "marketplace_operation",
      sourceId: `install_failed:${catalogItemName}`,
    }),

  updateAvailable: (
    db: Db,
    companyId: string,
    catalogItemId: string,
    catalogItemName: string,
    fromVersion: string,
    toVersion: string,
    options: { reopenWhenArchived?: boolean } = {}
  ) =>
    notifyFounders(db, companyId, {
      type: "marketplace.update_available",
      title: `Update available: ${catalogItemName}`,
      message: `${fromVersion} → ${toVersion} is available.`,
      relatedEntityType: "marketplace_update",
      // One hub row mirrors one durable pending-update identity. Its content is
      // refreshed (and, for a newer release, reopened) rather than accumulating
      // one row per version.
      sourceId: `update_available:${catalogItemId}`,
      legacySourcePrefix: `update_available:${catalogItemName}:`,
      reopenWhenArchived: options.reopenWhenArchived,
    }),

  updateCompleted: (db: Db, companyId: string, catalogItemName: string) =>
    notifyFounders(db, companyId, {
      type: "marketplace.update_completed",
      title: `${catalogItemName} updated`,
      relatedEntityType: "marketplace_update",
      sourceId: `update_completed:${catalogItemName}`,
    }),

  /**
   * T2.3b — crew repair adopted this company's pre-existing crew rows into
   * marketplace management. Founder-visible on purpose: a background pass
   * changing how their agents are governed must not be silent, and the
   * follow-on content update arrives through `agentUpdatePolicy` (which
   * defaults to `notify`), so the founder is the one who decides it.
   */
  crewRepaired: (db: Db, companyId: string, adoptedCount: number) =>
    notifyFounders(db, companyId, {
      type: "marketplace.crew_repaired",
      title: "Crew reconnected to the marketplace",
      message:
        `${adoptedCount} crew agent(s) were excluded from marketplace updates and have been ` +
        "reconnected. Their instructions and skills were left exactly as they are — any update " +
        "will follow your marketplace update policy.",
      relatedEntityType: "marketplace_operation",
      sourceId: `crew_repaired:${companyId}`,
    }),

  /**
   * T2.9 — a github / url / local re-install was refused because the installed
   * skill row carries founder edits (`company_skills.customized`).
   *
   * This is a hub item and NOT a `marketplace_pending_updates` row on purpose:
   * that table's `catalogItemId`, `itemType`, `currentVersion` and
   * `latestVersion` are all `notNull`, it is uniquely indexed on
   * `(companyId, catalogItemId)`, and every consumer — `/updates` list →
   * `/updates/:id/diff` → `/merge`, plus `checkCompanyUpdates` — resolves that
   * id against the live catalog. A non-catalog skill has no catalog item, so a
   * synthetic row would surface an Updates entry that 422s on every action. The
   * founder hub item is the honest durable record for this event.
   */
  skillUpdateRefusedCustomized: (
    db: Db,
    companyId: string,
    skillName: string,
    skillId: string
  ) =>
    notifyFounders(db, companyId, {
      type: "marketplace.skill_update_refused_customized",
      title: `Kept your edits to ${skillName}`,
      message:
        `A re-install of "${skillName}" was skipped because the skill has local edits. ` +
        "Nothing was changed. Delete the skill and re-import it if you want the upstream version.",
      relatedEntityType: "company_skill",
      sourceId: `skill_update_refused_customized:${skillId}`,
    }),

  updateFailed: (
    db: Db,
    companyId: string,
    catalogItemName: string,
    error: string
  ) =>
    notifyFounders(db, companyId, {
      type: "marketplace.update_failed",
      title: `${catalogItemName} update failed`,
      message: error,
      relatedEntityType: "marketplace_update",
      sourceId: `update_failed:${catalogItemName}`,
    }),
};
