import { and, isNull, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { onboardingProgress } from "@armyofagents/db";

/**
 * WS0b — one-time startup backfill: stamp `firstRunCompletedAt = now()` onto
 * every onboarding_progress row that completed the LEGACY (pre-redesign)
 * onboarding, so those founders aren't re-onboarded into the new first-run.
 *
 * IMPORTANT (QA-BUG-4 / WS0c redefinition): `SETUP_COMPLETE` alone is NOT a
 * "first-run complete" signal anymore. WS0c redefined the founder spine to END
 * at `SETUP_COMPLETE` and hand off to the Map/In-flight first-run on Home — so
 * a brand-new founder reaches `SETUP_COMPLETE` while their first-run is still
 * in progress. Stamping on `SETUP_COMPLETE` alone (the old behaviour) wrongly
 * completed such founders on the next server restart and kicked them to steady
 * Home mid-first-run.
 *
 * The reliable "went through the OLD 8-step flow to completion" signal is
 * `completedStates` containing BOTH `AGENT_ASSIGNED` and `SETUP_COMPLETE` —
 * only the legacy flow produced `AGENT_ASSIGNED`. New-flow founders have
 * `SETUP_COMPLETE` WITHOUT `AGENT_ASSIGNED`; WS0c-normalized mid-flow rows have
 * `AGENT_ASSIGNED` WITHOUT `SETUP_COMPLETE` — both are correctly excluded.
 *
 * Mirrors `backfillCrewTemplateOrigin`: a single atomic UPDATE...WHERE, safe
 * to call on every startup. Only touches rows where firstRunCompletedAt IS
 * NULL, so it is idempotent — a second run updates 0 rows.
 */
export async function backfillFirstRunCompleted(db: Db): Promise<void> {
  await db
    .update(onboardingProgress)
    .set({
      firstRunCompletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        isNull(onboardingProgress.firstRunCompletedAt),
        sql`${onboardingProgress.completedStates} @> ${JSON.stringify(["AGENT_ASSIGNED", "SETUP_COMPLETE"])}::jsonb`,
      ),
    );
}
