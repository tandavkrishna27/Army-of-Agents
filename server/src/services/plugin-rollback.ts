import { asc, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { pluginVersionSnapshots } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import { keepLatestN } from "./plugin-rollback-utils.js";

export { keepLatestN } from "./plugin-rollback-utils.js";

const MAX_SNAPSHOTS = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Service factory
// ─────────────────────────────────────────────────────────────────────────────

export function pluginRollbackService(db: Db) {
  return {
    /**
     * Save a version snapshot BEFORE upgrading. Trims old snapshots to MAX_SNAPSHOTS.
     */
    async saveSnapshot(
      pluginId: string,
      companyId: string,
      version: string,
      packageName: string,
      manifestJson: unknown,
    ): Promise<void> {
      await db.insert(pluginVersionSnapshots).values({
        pluginId,
        companyId,
        version,
        packageName,
        manifestJson,
      });

      // Trim to MAX_SNAPSHOTS
      const allSnaps = await db
        .select({ id: pluginVersionSnapshots.id, createdAt: pluginVersionSnapshots.createdAt })
        .from(pluginVersionSnapshots)
        .where(eq(pluginVersionSnapshots.pluginId, pluginId))
        .orderBy(asc(pluginVersionSnapshots.createdAt));

      const { toDelete } = keepLatestN(allSnaps, MAX_SNAPSHOTS);
      for (const snap of toDelete) {
        await db.delete(pluginVersionSnapshots).where(eq(pluginVersionSnapshots.id, snap.id));
      }
    },

    /**
     * List version snapshots for a plugin (oldest first from DB, newest last).
     */
    async listSnapshots(pluginId: string) {
      return db
        .select()
        .from(pluginVersionSnapshots)
        .where(eq(pluginVersionSnapshots.pluginId, pluginId))
        .orderBy(asc(pluginVersionSnapshots.createdAt));
    },

    /**
     * Returns the most recent snapshot for rollback, or null if none.
     */
    async getRollbackTarget(pluginId: string): Promise<{ version: string; packageName: string } | null> {
      const snaps = await this.listSnapshots(pluginId);
      if (snaps.length === 0) return null;
      const target = snaps[snaps.length - 1]!;
      logger.info({ pluginId, targetVersion: target.version }, "plugin-rollback: rollback target found");
      return { version: target.version, packageName: target.packageName };
    },
  };
}
