import { and, eq } from "drizzle-orm";
import type { Db, HomeBoardLayoutItem } from "@armyofagents/db";
import { homeBoardLayouts } from "@armyofagents/db";
import { HOME_BOARD_LAYOUT_SCHEMA_VERSION } from "@armyofagents/shared";

export interface HomeBoardLayoutResult {
  layout: HomeBoardLayoutItem[];
  schemaVersion: number;
}

export function homeBoardLayoutService(db: Db) {
  async function readRow(userId: string, companyId: string) {
    const rows = await db
      .select({
        layout: homeBoardLayouts.layout,
        schemaVersion: homeBoardLayouts.schemaVersion,
      })
      .from(homeBoardLayouts)
      .where(
        and(
          eq(homeBoardLayouts.userId, userId),
          eq(homeBoardLayouts.companyId, companyId),
        ),
      );
    return rows[0] ?? null;
  }

  return {
    async get(userId: string, companyId: string): Promise<HomeBoardLayoutResult | null> {
      const row = await readRow(userId, companyId);
      if (!row) return null;
      return {
        layout: (row.layout ?? []) as HomeBoardLayoutItem[],
        schemaVersion: row.schemaVersion,
      };
    },

    async upsert(
      userId: string,
      companyId: string,
      layout: HomeBoardLayoutItem[],
    ): Promise<HomeBoardLayoutResult> {
      // The server is the sole owner of schemaVersion + updatedAt — never
      // sourced from the caller (the route's validator also strips any
      // client-supplied schemaVersion before this is ever reached).
      const now = new Date();
      const [row] = await db
        .insert(homeBoardLayouts)
        .values({
          userId,
          companyId,
          layout,
          schemaVersion: HOME_BOARD_LAYOUT_SCHEMA_VERSION,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [homeBoardLayouts.userId, homeBoardLayouts.companyId],
          set: {
            layout,
            schemaVersion: HOME_BOARD_LAYOUT_SCHEMA_VERSION,
            updatedAt: now,
          },
        })
        .returning({
          layout: homeBoardLayouts.layout,
          schemaVersion: homeBoardLayouts.schemaVersion,
        });
      return {
        layout: (row?.layout ?? layout) as HomeBoardLayoutItem[],
        schemaVersion: row?.schemaVersion ?? HOME_BOARD_LAYOUT_SCHEMA_VERSION,
      };
    },

    /**
     * Explicit contract: reset DELETEs the row (not a soft-clear to an empty
     * layout) — a subsequent get() returns null, and callers fall back to the
     * role default layout. See the migration integration test (Phase D) for
     * the real-DB round-trip proof.
     */
    async reset(userId: string, companyId: string): Promise<void> {
      await db
        .delete(homeBoardLayouts)
        .where(
          and(
            eq(homeBoardLayouts.userId, userId),
            eq(homeBoardLayouts.companyId, companyId),
          ),
        );
    },
  };
}
