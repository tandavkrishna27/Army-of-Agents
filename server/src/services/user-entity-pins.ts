import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { userEntityPins, issues, artifacts, goals } from "@armyofagents/db";

// Derive the row type from the schema so it can't silently drift from the table.
export type UserEntityPinRow = typeof userEntityPins.$inferSelect;

export function userEntityPinService(db: Db) {
  return {
    async list(userId: string, companyId: string): Promise<UserEntityPinRow[]> {
      const rows = await db
        .select()
        .from(userEntityPins)
        .where(
          and(
            eq(userEntityPins.userId, userId),
            eq(userEntityPins.companyId, companyId),
          ),
        )
        .orderBy(desc(userEntityPins.pinnedAt));
      return rows;
    },

    async pin(
      userId: string,
      companyId: string,
      entityType: string,
      entityId: string,
    ): Promise<UserEntityPinRow> {
      // onConflictDoUpdate (not DoNothing + refetch) always returns exactly one
      // row, avoiding a TOCTOU where a concurrent unpin makes a refetch return
      // undefined. Re-pinning an existing pin just bumps updatedAt.
      const [row] = await db
        .insert(userEntityPins)
        .values({ userId, companyId, entityType, entityId })
        .onConflictDoUpdate({
          target: [
            userEntityPins.userId,
            userEntityPins.companyId,
            userEntityPins.entityType,
            userEntityPins.entityId,
          ],
          set: { updatedAt: new Date() },
        })
        .returning();
      return row;
    },

    async unpin(
      userId: string,
      companyId: string,
      entityType: string,
      entityId: string,
    ): Promise<void> {
      await db
        .delete(userEntityPins)
        .where(
          and(
            eq(userEntityPins.userId, userId),
            eq(userEntityPins.companyId, companyId),
            eq(userEntityPins.entityType, entityType),
            eq(userEntityPins.entityId, entityId),
          ),
        );
    },

    async entityExistsInCompany(
      companyId: string,
      entityType: string,
      entityId: string,
    ): Promise<boolean> {
      switch (entityType) {
        case "task": {
          const rows = await db
            .select({ id: issues.id })
            .from(issues)
            .where(and(eq(issues.id, entityId), eq(issues.companyId, companyId)));
          return rows.length > 0;
        }
        case "artifact": {
          const rows = await db
            .select({ id: artifacts.id })
            .from(artifacts)
            .where(and(eq(artifacts.id, entityId), eq(artifacts.companyId, companyId)));
          return rows.length > 0;
        }
        case "goal": {
          const rows = await db
            .select({ id: goals.id })
            .from(goals)
            .where(and(eq(goals.id, entityId), eq(goals.companyId, companyId)));
          return rows.length > 0;
        }
        default:
          return false;
      }
    },
  };
}
