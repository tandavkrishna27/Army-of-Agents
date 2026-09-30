/**
 * @fileoverview Default skill seeder — DEPRECATED v1.1.
 *
 * Skills are now distributed via marketplace team packages (`requires` fields
 * in team.json). The standalone seeder is dead code for v1.1 onward.
 * Retained as a no-op stub so existing call sites compile cleanly.
 */
import type { Db } from "@armyofagents/db";

/**
 * @deprecated v1.1 — skills installed via marketplace team package. No-op.
 */
export async function seedDefaultCommanderSkills(_params: {
  db: Db;
  companyId: string;
}): Promise<void> {
  // No-op: replaced by marketplace team package install (T3.6).
}
