import { and, eq } from "drizzle-orm";
import { internalAgentConfig, viewerPreferences, type Db } from "@armyofagents/db";
import {
  DEFAULT_VIEWER_CONTROL_LEVEL,
  isViewerControlLevel,
  type ViewerControlLevel,
} from "@armyofagents/shared";

export type ViewerControlSource = "user" | "company";

export interface ResolvedViewerControl {
  level: ViewerControlLevel;
  source: ViewerControlSource;
}

/**
 * Pure resolver. Inputs are the raw stored text values (which may be corrupt,
 * absent, or null). A valid per-user override wins; otherwise a valid company
 * level; otherwise the shared default (attributed to "company").
 */
export function resolveViewerControlLevel(input: {
  companyLevel: string | null;
  userLevel: string | null;
}): ResolvedViewerControl {
  if (isViewerControlLevel(input.userLevel)) {
    return { level: input.userLevel, source: "user" };
  }
  if (isViewerControlLevel(input.companyLevel)) {
    return { level: input.companyLevel, source: "company" };
  }
  return { level: DEFAULT_VIEWER_CONTROL_LEVEL, source: "company" };
}

/**
 * Async wrapper. Reads the company's internal_agent_config default (may be
 * absent — the config row is seeded non-fatally) and the user's
 * viewer_preferences override (may be absent or null), then defers to the pure
 * resolver. Neither row missing is an error.
 */
export async function resolveViewerControl(
  db: Db,
  companyId: string,
  userId: string,
): Promise<ResolvedViewerControl> {
  const configRows = await db
    .select({ viewerControlLevel: internalAgentConfig.viewerControlLevel })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);
  const companyLevel = configRows[0]?.viewerControlLevel ?? null;

  const prefRows = await db
    .select({ viewerControlLevel: viewerPreferences.viewerControlLevel })
    .from(viewerPreferences)
    .where(
      and(
        eq(viewerPreferences.userId, userId),
        eq(viewerPreferences.companyId, companyId),
      ),
    )
    .limit(1);
  const userLevel = prefRows[0]?.viewerControlLevel ?? null;

  return resolveViewerControlLevel({ companyLevel, userLevel });
}
