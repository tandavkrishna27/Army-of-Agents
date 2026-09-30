import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { onboardingProgress } from "@armyofagents/db";

/**
 * WS0c — idempotent startup normalization for founder onboarding_progress
 * rows still mid-wizard at the now-removed `DEPARTMENT_CREATED`/
 * `AGENT_ASSIGNED` states (design §4.2 shortened `FOUNDER_PHASE1_STATES` to
 * end at `COMMANDER_VERIFIED` → `SETUP_COMPLETE`). Those two values stay in
 * the `ONBOARDING_STATES` union (still valid on stored rows) but are no
 * longer part of the monotonic founder advance.
 *
 * Normalizes matching rows FORWARD to `currentState = "COMMANDER_VERIFIED"`
 * — deliberately NOT `"SETUP_COMPLETE"` (design §8, Codex P1): the WS0b
 * `backfillFirstRunCompleted` startup backfill stamps `firstRunCompletedAt`
 * onto every `SETUP_COMPLETE` row, and both backfills run unordered at
 * startup. Normalizing straight to `SETUP_COMPLETE` would auto-stamp
 * `firstRunCompleted` for these founders and silently skip them past the new
 * Home first-run/persona-fork experience. Landing them at `COMMANDER_VERIFIED`
 * instead lets the UI's terminal wizard step (`SpineCompleteStep`) perform the
 * real `SETUP_COMPLETE` advance the normal way, and lets WS9 own the
 * first-run write.
 *
 * Only touches rows that:
 *   - are on the `founder` journey (these two states never existed on the
 *     invited journey);
 *   - have `currentState` IN (`DEPARTMENT_CREATED`, `AGENT_ASSIGNED`);
 *   - have `completedStates` already containing `COMMANDER_VERIFIED` (their
 *     spine is genuinely done — otherwise leave the row alone rather than
 *     forge a completed state it never reached).
 *
 * `version` is incremented (mirroring `advanceState`/`setFirstRunProgress`'s
 * optimistic-concurrency accounting) even though this is a single atomic
 * `UPDATE ... WHERE` with no read-then-write race, matching
 * `backfillFirstRunCompleted`'s bulk-update shape. Idempotent: once a row's
 * `currentState` is `COMMANDER_VERIFIED` the WHERE no longer matches it, so a
 * second run (every boot) updates 0 rows for that row.
 */
export async function normalizeLegacyOnboardingState(db: Db): Promise<void> {
  await db
    .update(onboardingProgress)
    .set({
      currentState: "COMMANDER_VERIFIED",
      version: sql`${onboardingProgress.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(onboardingProgress.journey, "founder"),
        inArray(onboardingProgress.currentState, ["DEPARTMENT_CREATED", "AGENT_ASSIGNED"]),
        sql`${onboardingProgress.completedStates} @> ${JSON.stringify(["COMMANDER_VERIFIED"])}::jsonb`,
      ),
    );
}
