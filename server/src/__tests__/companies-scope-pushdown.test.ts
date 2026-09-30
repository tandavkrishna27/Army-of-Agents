/**
 * Fix 4 — SQL push-down shape proof for companyService.list()/stats().
 * Windows-safe: a capturing Db records each select's serialized WHERE (no PG).
 * Harness copied from crew-scope-counts.test.ts (capturingDb is not exported).
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { companies, agents, issues, approvals, notifications } from "@armyofagents/db";
import type { Db } from "@armyofagents/db";
import { companyService } from "../services/companies.js";

const dialect = new PgDialect();

interface Captured {
  table: unknown;
  whereSql: string | null;
}

function capturingDb(rows: unknown[] = []): { db: Db; captured: Captured[] } {
  const captured: Captured[] = [];
  function makeChain(rec: Captured) {
    const resolved = Promise.resolve(rows);
    const chain: Record<string, unknown> = {
      from(table: unknown) { rec.table = table; return chain; },
      innerJoin() { return chain; },
      leftJoin() { return chain; },
      where(cond: unknown) {
        try { rec.whereSql = cond == null ? null : dialect.sqlToQuery(cond as never).sql; }
        catch { rec.whereSql = null; }
        return chain;
      },
      groupBy() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) { return resolved.then(onF, onR); },
      catch(onR: (e: unknown) => unknown) { return resolved.catch(onR); },
    };
    return chain;
  }
  const db = {
    select() {
      const rec: Captured = { table: null, whereSql: null };
      captured.push(rec);
      return makeChain(rec);
    },
  } as unknown as Db;
  return { db, captured };
}

/** The serialized WHERE of the (single) select that ran against `table`, or null. */
function whereFor(captured: Captured[], table: unknown): string | null {
  const rec = captured.find((c) => c.table === table);
  return rec ? rec.whereSql : null;
}

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

describe("companyService.list() tenant push-down (Fix 4)", () => {
  it('"unscoped" allow-set → unfiltered (no WHERE on companies) [operator/self-hosted view]', async () => {
    const { db, captured } = capturingDb([]);
    await companyService(db).list("unscoped");
    expect(whereFor(captured, companies)).toBeNull();
  });

  it("empty allow-set → an explicit `false` predicate (degrade-to-none, never return-all)", async () => {
    const { db, captured } = capturingDb([]);
    await companyService(db).list([]);
    expect(whereFor(captured, companies)).toBe("false");
  });

  it("non-empty allow-set → inArray on companies.id is pushed into SQL", async () => {
    const { db, captured } = capturingDb([]);
    await companyService(db).list(IDS);
    expect(whereFor(captured, companies)).toContain('"companies"."id" in (');
  });
});

describe("companyService.stats() tenant push-down (Fix 4)", () => {
  it("non-empty allow-set → inArray on company_id pushed into all four aggregations", async () => {
    const { db, captured } = capturingDb([]);
    await companyService(db).stats(IDS);
    expect(whereFor(captured, agents)).toContain('"agents"."company_id" in (');
    expect(whereFor(captured, issues)).toContain('"issues"."company_id" in (');
    expect(whereFor(captured, approvals)).toContain('"approvals"."company_id" in (');
    expect(whereFor(captured, notifications)).toContain('"notifications"."company_id" in (');
  });

  it("empty allow-set → short-circuits to {} with NO database query (degrade-to-none)", async () => {
    const { db, captured } = capturingDb([]);
    const result = await companyService(db).stats([]);
    expect(result).toEqual({});
    expect(captured).toHaveLength(0);
  });

  it('"unscoped" allow-set → base predicates only, NO company_id inArray [operator view]', async () => {
    const { db, captured } = capturingDb([]);
    await companyService(db).stats("unscoped");
    expect(whereFor(captured, agents)).not.toContain('"agents"."company_id" in (');
    expect(whereFor(captured, issues)).not.toContain('"issues"."company_id" in (');
    expect(whereFor(captured, approvals)).not.toContain('"approvals"."company_id" in (');
    expect(whereFor(captured, notifications)).not.toContain('"notifications"."company_id" in (');
    // base predicate is still present (unchanged from today).
    expect(whereFor(captured, agents)).toContain('"agents"."kind" =');
  });
});
