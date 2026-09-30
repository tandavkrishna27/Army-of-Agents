import { eq, and, like } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, teams } from "@armyofagents/db";

export interface ResolveAgentNameOpts {
  db: Db;
  companyId: string;
  desiredName: string;
}

/**
 * Returns the smallest available agent name for this company.
 * If `desiredName` is unused, returns it unchanged. Otherwise returns
 * `desiredName-2`, `desiredName-3`, etc. — the lowest free suffix.
 */
export async function resolveAgentNameConflict(opts: ResolveAgentNameOpts): Promise<string> {
  const { db, companyId, desiredName } = opts;
  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        like(agents.name, `${desiredName}%`),
      ),
    );

  return findNextSuffix(desiredName, rows.map((r: { name: string }) => r.name));
}

export interface ResolveTeamSlugOpts {
  db: Db;
  companyId: string;
  desiredSlug: string;
}

/**
 * Returns the smallest available team slug for this company.
 * Same suffix logic as resolveAgentNameConflict.
 */
export async function resolveTeamSlugConflict(opts: ResolveTeamSlugOpts): Promise<string> {
  const { db, companyId, desiredSlug } = opts;
  const rows = await db
    .select()
    .from(teams)
    .where(
      and(
        eq(teams.companyId, companyId),
        like(teams.slug, `${desiredSlug}%`),
      ),
    );

  return findNextSuffix(desiredSlug, rows.map((r: { slug: string }) => r.slug));
}

/**
 * Returns the smallest "name-N" available given existing names.
 * If `name` itself is unused, returns it. Otherwise returns `name-2`, `name-3`, ...
 *
 * @example
 *   findNextSuffix("Engineer", [])                              // → "Engineer"
 *   findNextSuffix("Engineer", ["Engineer"])                    // → "Engineer-2"
 *   findNextSuffix("Engineer", ["Engineer", "Engineer-2"])      // → "Engineer-3"
 *   findNextSuffix("Engineer", ["Engineer", "Engineer-3"])      // → "Engineer-2"
 */
function findNextSuffix(base: string, existing: string[]): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;

  for (let i = 2; i < 10000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`No available name suffix for "${base}" within 10000 attempts`);
}
