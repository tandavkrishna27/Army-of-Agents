import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { viewerPreferences } from "@armyofagents/db";
import type { ViewerControlLevel } from "@armyofagents/shared";

export interface ViewerPreferenceRow {
  viewerControlLevel: string | null;
  updatedAt: Date | null;
}

/** Read the current user's viewer preference row for a company, or null. */
export async function getViewerPreference(
  db: Db,
  userId: string,
  companyId: string,
): Promise<ViewerPreferenceRow | null> {
  const rows = await db
    .select({
      viewerControlLevel: viewerPreferences.viewerControlLevel,
      updatedAt: viewerPreferences.updatedAt,
    })
    .from(viewerPreferences)
    .where(
      and(
        eq(viewerPreferences.userId, userId),
        eq(viewerPreferences.companyId, companyId),
      ),
    );
  return rows[0] ?? null;
}

/**
 * Upsert the current user's per-company viewer control override. A null level
 * means "inherit the company default" (row still persisted so updatedAt tracks
 * the explicit reset).
 */
export async function upsertViewerPreference(
  db: Db,
  userId: string,
  companyId: string,
  viewerControlLevel: ViewerControlLevel | null,
): Promise<ViewerPreferenceRow> {
  const now = new Date();
  const [row] = await db
    .insert(viewerPreferences)
    .values({
      userId,
      companyId,
      viewerControlLevel,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [viewerPreferences.userId, viewerPreferences.companyId],
      set: {
        viewerControlLevel,
        updatedAt: now,
      },
    })
    .returning({
      viewerControlLevel: viewerPreferences.viewerControlLevel,
      updatedAt: viewerPreferences.updatedAt,
    });
  return row ?? { viewerControlLevel, updatedAt: now };
}
