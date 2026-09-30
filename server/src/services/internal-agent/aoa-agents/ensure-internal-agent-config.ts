import type { Db } from "@armyofagents/db";
import { internalAgentConfig } from "@armyofagents/db";

/** Idempotently ensure the per-company internal_agent_config row exists
 *  (default column values; companyId is unique). Decision #100: the
 *  Commander Team comes with every company. */
export async function ensureInternalAgentConfig(db: Db, companyId: string): Promise<void> {
  await db.insert(internalAgentConfig).values({ companyId }).onConflictDoNothing();
}
