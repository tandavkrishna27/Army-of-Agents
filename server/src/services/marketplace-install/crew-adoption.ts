/**
 * Shared serialization and pointer-only adoption primitives for crew writers.
 *
 * Crew repair, the legacy Steward reconciler, and direct marketplace creation
 * all touch protected crew identity. Keeping the lock here lets those paths
 * share one database-wide critical section without importing either
 * orchestrator into the other.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents } from "@armyofagents/db";
import { ADOPTED_TEMPLATE_VERSION } from "./crew-constants.js";

/** Serialize crew identity mutations for one company until transaction end. */
export async function acquireCrewRepairAdvisoryLock(db: Db, companyId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`crew-repair:${companyId}`}))`);
}

/**
 * Re-point one legacy crew row at its published catalog item without changing
 * any founder-owned or runtime content.
 *
 * The expected name and origin predicates are optimistic guards against the
 * caller's snapshot. Callers serialize through the crew-repair lock; a stale
 * snapshot then makes this update fail instead of stamping a renamed or
 * re-pointed row. Returning false makes the surrounding transaction fail
 * closed.
 */
export async function adoptLegacyCrewAgentPointer(
  db: Db,
  opts: {
    companyId: string;
    agentId: string;
    expectedName: string;
    expectedTemplateOrigin: string | null;
    templateOrigin: string;
  },
): Promise<boolean> {
  const expectedOrigin =
    opts.expectedTemplateOrigin === null
      ? isNull(agents.templateOrigin)
      : eq(agents.templateOrigin, opts.expectedTemplateOrigin);
  const adopted = await db
    .update(agents)
    .set({
      templateOrigin: opts.templateOrigin,
      templateVersion: ADOPTED_TEMPLATE_VERSION,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.id, opts.agentId),
        eq(agents.companyId, opts.companyId),
        eq(agents.kind, "aoa"),
        eq(agents.name, opts.expectedName),
        expectedOrigin,
      ),
    )
    .returning({ id: agents.id });
  return adopted.length === 1;
}
