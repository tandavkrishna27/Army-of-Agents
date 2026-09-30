/**
 * @fileoverview Marketplace update checker.
 *
 * Compares installed catalog items against the current catalog version,
 * creates/updates rows in marketplace_pending_updates.
 *
 * Called after catalog sync completes and on startup.
 */
import { and, eq, or } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  marketplacePendingUpdates,
  companies,
  companySkills,
  plugins,
} from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";
import { marketplaceNotifications } from "./marketplace-notifications.js";
import { logger } from "../middleware/logger.js";
import { sanitizeErrorText, serializeSafeError } from "./safe-error.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pure utility functions (exported for unit testing)
// ─────────────────────────────────────────────────────────────────────────────

export function compareVersions(latest: string, current: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj! > cMaj! ? 1 : -1;
  if (lMin !== cMin) return lMin! > cMin! ? 1 : -1;
  if (lPat !== cPat) return lPat! > cPat! ? 1 : -1;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main checker
// ─────────────────────────────────────────────────────────────────────────────

export interface RunMarketplaceUpdateCheckOptions {
  /**
   * Restrict the pass to an already-authorized/audited company snapshot.
   * Omit only for ordinary periodic/manual catalog syncs that intentionally
   * discover the current fleet.
   */
  companyIds?: readonly string[];
}

export interface MarketplaceUpdateCheckFailure {
  companyId: string;
  itemType: "company" | "skill" | "plugin";
  catalogItemId?: string;
  message: string;
}

export interface MarketplaceUpdateCheckResult {
  companiesExamined: number;
  failures: MarketplaceUpdateCheckFailure[];
}

function updateCheckFailure(
  companyId: string,
  itemType: MarketplaceUpdateCheckFailure["itemType"],
  error: unknown,
  catalogItemId?: string
): MarketplaceUpdateCheckFailure {
  return {
    companyId,
    itemType,
    ...(catalogItemId ? { catalogItemId } : {}),
    message: sanitizeErrorText(
      error instanceof Error ? error.message : String(error),
    ),
  };
}

export async function runUpdateCheck(
  db: Db,
  catalogItems: CatalogItem[],
  options: RunMarketplaceUpdateCheckOptions = {}
): Promise<MarketplaceUpdateCheckResult> {
  const companyIds = options.companyIds
    ? [...new Set(options.companyIds)].sort()
    : (await db.select({ id: companies.id }).from(companies)).map(
        (company) => company.id
      );
  const failures: MarketplaceUpdateCheckFailure[] = [];

  for (const companyId of companyIds) {
    try {
      failures.push(...(await checkCompany(db, catalogItems, companyId)));
    } catch (err) {
      logger.error(
        { error: serializeSafeError(err), companyId },
        "marketplace-update-checker: error processing company"
      );
      failures.push(updateCheckFailure(companyId, "company", err));
    }
  }

  return {
    companiesExamined: companyIds.length,
    failures,
  };
}

async function checkCompany(
  db: Db,
  catalogItems: CatalogItem[],
  companyId: string
): Promise<MarketplaceUpdateCheckFailure[]> {
  const failures: MarketplaceUpdateCheckFailure[] = [];
  try {
    const catalogMap = new Map<
      string,
      { version: string; name: string; type: string }
    >();
    for (const item of catalogItems) {
      catalogMap.set(item.id, {
        version: item.version,
        name: item.name,
        type: item.type,
      });
    }

    // Check skills (sourceType=catalog means they came from marketplace)
    const skillRows = await db
      .select({
        sourceLocator: companySkills.sourceLocator,
        sourceRef: companySkills.sourceRef,
      })
      .from(companySkills)
      .where(
        and(
          eq(companySkills.companyId, companyId),
          eq(companySkills.sourceType, "catalog")
        )
      );

    for (const skill of skillRows) {
      if (!skill.sourceLocator || !skill.sourceRef) continue;
      const catalogEntry = catalogMap.get(skill.sourceLocator);
      if (!catalogEntry) continue;

      try {
        const { shouldNotify, shouldReopenNotification } =
          await upsertPendingUpdate(db, companyId, {
            catalogItemId: skill.sourceLocator,
            catalogItemName: catalogEntry.name,
            itemType: "skill",
            currentVersion: skill.sourceRef,
            latestVersion: catalogEntry.version,
          });

        if (!shouldNotify) continue;

        // Hub emits are idempotent by their stable source key. Retrying for an
        // existing pending row repairs a prior notification failure without
        // creating a duplicate founder item.
        await marketplaceNotifications.updateAvailable(
          db,
          companyId,
          skill.sourceLocator,
          catalogEntry.name,
          skill.sourceRef,
          catalogEntry.version,
          { reopenWhenArchived: shouldReopenNotification }
        );
      } catch (err) {
        // Per-skill isolation: one skill error doesn't block the rest
        logger.error(
          {
            error: serializeSafeError(err),
            catalogItemId: skill.sourceLocator,
            companyId,
          },
          "marketplace-update-checker: per-skill error"
        );
        failures.push(
          updateCheckFailure(companyId, "skill", err, skill.sourceLocator)
        );
      }
    }
    // TODO: Add agent + team template checks when templateOrigin/templateVersion
    // columns are added to those schemas.

    failures.push(...(await checkPluginUpdates(db, companyId, catalogItems)));
  } catch (err) {
    logger.error(
      { error: serializeSafeError(err), companyId },
      "marketplace-update-checker: error checking company"
    );
    failures.push(updateCheckFailure(companyId, "company", err));
  }
  return failures;
}

/**
 * Check for plugin updates for a single company.
 * Scans the plugins table for this company, compares installed versions against
 * the catalog, and upserts to marketplacePendingUpdates for any plugins with
 * newer versions available.
 */
export async function checkPluginUpdates(
  db: Db,
  companyId: string,
  catalogItems: CatalogItem[]
): Promise<MarketplaceUpdateCheckFailure[]> {
  const failures: MarketplaceUpdateCheckFailure[] = [];
  const installedPlugins = await db
    .select({ packageName: plugins.packageName, version: plugins.version })
    .from(plugins)
    .where(and(eq(plugins.companyId, companyId), eq(plugins.status, "ready")));

  const pluginCatalogMap = new Map<string, CatalogItem>();
  for (const item of catalogItems) {
    if (item.type === "plugin" && item.npm?.packageName) {
      pluginCatalogMap.set(item.npm.packageName, item);
    }
  }

  for (const plugin of installedPlugins) {
    if (!plugin.version) continue;
    // Match catalog item by packageName
    const catalogItem = pluginCatalogMap.get(plugin.packageName);
    if (!catalogItem || !catalogItem.npm?.version) continue;

    try {
      const { shouldNotify, shouldReopenNotification } =
        await upsertPendingUpdate(db, companyId, {
          catalogItemId: catalogItem.id,
          catalogItemName: catalogItem.name,
          itemType: "plugin",
          currentVersion: plugin.version,
          latestVersion: catalogItem.npm.version,
        });

      if (!shouldNotify) continue;

      await marketplaceNotifications.updateAvailable(
        db,
        companyId,
        catalogItem.id,
        catalogItem.name,
        plugin.version,
        catalogItem.npm.version,
        { reopenWhenArchived: shouldReopenNotification }
      );
    } catch (err) {
      // Per-plugin isolation: one plugin error doesn't block the rest
      logger.error(
        {
          error: serializeSafeError(err),
          catalogItemId: catalogItem.id,
          companyId,
        },
        "marketplace-update-checker: per-plugin error"
      );
      failures.push(
        updateCheckFailure(companyId, "plugin", err, catalogItem.id)
      );
    }
  }
  return failures;
}

export async function upsertPendingUpdate(
  db: Db,
  companyId: string,
  data: {
    catalogItemId: string;
    catalogItemName: string;
    itemType: string;
    currentVersion: string;
    latestVersion: string;
  }
): Promise<{
  inserted: boolean;
  shouldNotify: boolean;
  shouldReopenNotification: boolean;
}> {
  if (compareVersions(data.latestVersion, data.currentVersion) <= 0) {
    return {
      inserted: false,
      shouldNotify: false,
      shouldReopenNotification: false,
    };
  }

  const inserted = await db
    .insert(marketplacePendingUpdates)
    .values({
      companyId,
      catalogItemId: data.catalogItemId,
      catalogItemName: data.catalogItemName,
      itemType: data.itemType,
      currentVersion: data.currentVersion,
      latestVersion: data.latestVersion,
      status: "pending",
    })
    .onConflictDoNothing()
    .returning({ id: marketplacePendingUpdates.id });

  if (inserted.length > 0) {
    return {
      inserted: true,
      shouldNotify: true,
      shouldReopenNotification: true,
    };
  }

  // Conflict: a row already exists for this (companyId, catalogItemId).
  // Read its current status to decide what to do.
  const [existing] = await db
    .select({
      status: marketplacePendingUpdates.status,
      latestVersion: marketplacePendingUpdates.latestVersion,
    })
    .from(marketplacePendingUpdates)
    .where(
      and(
        eq(marketplacePendingUpdates.companyId, companyId),
        eq(marketplacePendingUpdates.catalogItemId, data.catalogItemId)
      )
    )
    .limit(1);

  if (!existing) {
    // Race: row disappeared between conflict and read. There is no durable
    // pending update to back a notification, so let the next pass retry both.
    return {
      inserted: false,
      shouldNotify: false,
      shouldReopenNotification: false,
    };
  }

  if (existing.status === "pending" || existing.status === "conflict") {
    // Still pending — bump latestVersion if the catalog has advanced further
    const catalogAdvanced =
      compareVersions(data.latestVersion, existing.latestVersion) > 0;
    if (catalogAdvanced) {
      await db
        .update(marketplacePendingUpdates)
        .set({ latestVersion: data.latestVersion, updatedAt: new Date() })
        .where(
          and(
            eq(marketplacePendingUpdates.companyId, companyId),
            eq(marketplacePendingUpdates.catalogItemId, data.catalogItemId),
            or(
              eq(marketplacePendingUpdates.status, "pending"),
              eq(marketplacePendingUpdates.status, "conflict")
            )
          )
        );
    }
    // A previous pass may have inserted this row and then failed to emit its
    // founder hub item. Re-emit on every check; hubItemsService deduplicates by
    // sourceUniqueKey and makes this a cheap no-op after successful delivery.
    return {
      inserted: false,
      shouldNotify: true,
      shouldReopenNotification: catalogAdvanced,
    };
  }

  // Row is "applied" or "dismissed" — re-open it for the incoming catalog version.
  // The prior dismiss/apply was for an older version; this is a genuinely new release.
  if (
    (existing.status !== "applied" && existing.status !== "dismissed") ||
    compareVersions(data.latestVersion, existing.latestVersion) <= 0
  ) {
    return {
      inserted: false,
      shouldNotify: false,
      shouldReopenNotification: false,
    };
  }

  await db
    .update(marketplacePendingUpdates)
    .set({
      status: "pending",
      currentVersion: data.currentVersion,
      latestVersion: data.latestVersion,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(marketplacePendingUpdates.companyId, companyId),
        eq(marketplacePendingUpdates.catalogItemId, data.catalogItemId),
        or(
          eq(marketplacePendingUpdates.status, "applied"),
          eq(marketplacePendingUpdates.status, "dismissed")
        )
      )
    );

  return {
    inserted: true,
    shouldNotify: true,
    shouldReopenNotification: true,
  };
}
