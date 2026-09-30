import { and, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companies, costEvents } from "@armyofagents/db";

export interface OrgSpendSummary {
  totalCents: number;
  byProvider: Array<{ provider: string; costCents: number }>;
}

/** Pure rollup — no DB access. Order of byProvider is highest-spend first. */
export function summarizeOrgSpend(rows: Array<{ provider: string; costCents: number }>): OrgSpendSummary {
  const byProvider = new Map<string, number>();
  let totalCents = 0;
  for (const r of rows) {
    totalCents += r.costCents;
    byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + r.costCents);
  }
  return {
    totalCents,
    byProvider: [...byProvider.entries()]
      .map(([provider, costCents]) => ({ provider, costCents }))
      .sort((a, b) => b.costCents - a.costCents),
  };
}

/**
 * Read-only rollup of cost_events across every company in the organization,
 * since a given cutoff. No writes. An org with no member companies (or no
 * spend in the window) returns the zero summary — safe.
 */
export async function getOrgSpend(db: Db, organizationId: string, since: Date): Promise<OrgSpendSummary> {
  const companyRows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.organizationId, organizationId));
  const ids = companyRows.map((r) => r.id);
  if (ids.length === 0) return { totalCents: 0, byProvider: [] };
  const rows = await db
    .select({ provider: costEvents.provider, costCents: costEvents.costCents })
    .from(costEvents)
    .where(and(inArray(costEvents.companyId, ids), gte(costEvents.occurredAt, since)));
  return summarizeOrgSpend(rows.map((r) => ({ provider: r.provider, costCents: Number(r.costCents) })));
}
