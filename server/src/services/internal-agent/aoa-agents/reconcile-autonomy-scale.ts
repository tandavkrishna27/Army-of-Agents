import { gt } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { discussions, internalAgentConfig } from "@armyofagents/db";

/**
 * One-time startup reconciliation: clamp any stored autonomy_level > 2 → 2.
 *
 * Background: the autonomy scale is canonical 0/1/2 (Manual/Assist/Drive); the
 * pre-canonical UI exposed a top "Auto" rung that persisted autonomy_level = 3.
 * The ONLY at-rest value that can fall outside the canonical range is that
 * legacy 3 (old "Auto" → now Drive), and the `> 2` clamp below maps it to 2.
 *
 * NOTE on the absence of a low-end remap (L6): this reconciliation deliberately
 * does NOT remap old 1→0 or 2→1. Verified against the writers — both persistence
 * paths already clamp to the canonical 0..2 scale: the company config route
 * (`internal-agent.ts`: `z.number().int().min(0).max(2)` + explicit < 0 / > 2
 * guard) and the per-thread `setAutonomyLevel` PATCH (same `/discussions/:id`
 * endpoint). The schema defaults are canonical too (`internal_agent_config`
 * defaults 0; `discussions.autonomy_level` is nullable). So no row was ever
 * written under a 1-based scale where a stored `1` means "Manual" — a stored
 * `1` always means the canonical Assist, and a stored `2` always means Drive.
 * Adding a 1→0 / 2→1 remap here would MIS-MIGRATE legitimate Assist(1)/Drive(2)
 * rows. The legacy `3` is the sole concern, handled by the clamp.
 *
 * Tables updated:
 *   - discussions.autonomy_level  (per-thread override)
 *   - internal_agent_config.autonomy_level  (Commander dial)
 *   - internal_agent_config.crew_autonomy_level  (agent-work dial, D18 split)
 *
 * The crew column is clamped separately because the D18 split migration
 * backfills it verbatim from `autonomy_level` — a legacy row holding 3 lands a
 * 3 in the new column too, so both need the same clamp.
 *
 * All three statements run in ONE transaction, so the two config dials cannot
 * end up half-clamped (one column at 2, the other left at a legacy 3) if a
 * statement fails midway. The practical impact of that was nil — the predicates
 * are independent and idempotent, every consumer compares `>= 1` / `>= 2` /
 * `=== 0` so an out-of-range value behaves identically, and the next boot would
 * self-heal — but the transaction makes this docblock's "clamps both columns"
 * claim literally true rather than true-in-practice.
 *
 * Safe to call on every startup — only touches rows above the canonical range.
 * Idempotent: a second run matches 0 rows and returns all-zero counts.
 */
export async function reconcileAutonomyScale(
  db: Db,
): Promise<{ discussionsUpdated: number; configUpdated: number; crewConfigUpdated: number }> {
  return db.transaction(async (tx) => {
    const discussionsResult = await tx
      .update(discussions)
      .set({
        autonomyLevel: 2,
        updatedAt: new Date(),
      })
      .where(gt(discussions.autonomyLevel, 2));

    const configResult = await tx
      .update(internalAgentConfig)
      .set({
        autonomyLevel: 2,
        updatedAt: new Date(),
      })
      .where(gt(internalAgentConfig.autonomyLevel, 2));

    const crewConfigResult = await tx
      .update(internalAgentConfig)
      .set({
        crewAutonomyLevel: 2,
        updatedAt: new Date(),
      })
      .where(gt(internalAgentConfig.crewAutonomyLevel, 2));

    const discussionsUpdated =
      (discussionsResult as unknown as { rowCount?: number | null }).rowCount ?? 0;
    const configUpdated =
      (configResult as unknown as { rowCount?: number | null }).rowCount ?? 0;
    const crewConfigUpdated =
      (crewConfigResult as unknown as { rowCount?: number | null }).rowCount ?? 0;

    return { discussionsUpdated, configUpdated, crewConfigUpdated };
  });
}
