/**
 * Crew/org count-scoping — org-workload counts exclude crew tasks (T-B).
 *
 * Per the unified crew/org board separation plan (2026-06-02), the ORG-WORKLOAD
 * count queries must push `notCrewAssigned` so crew-agent tasks don't inflate the
 * sidebar badge, Home in-review/blocked tiles, or Dashboard status/stale counts.
 * The task GRAPH (goal rollups, search, delete-gate, deps, proactive) deliberately
 * stays on `all` and is asserted elsewhere.
 *
 * Strategy (mirrors memory-insert-no-pgvector.test.ts): real Drizzle query
 * builders + a capturing Db stub that records every `.from(table).where(cond)` it
 * sees, then serializes the captured WHERE via PgDialect to assert the crew
 * NOT-EXISTS predicate is present on issue-targeted queries (and ABSENT on the
 * goal-rollup query, which must keep counting crew).
 */
import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { agents, issues, goals } from "@armyofagents/db";
import type { Db } from "@armyofagents/db";

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

import { issueService } from "../services/issues.js";
import { homeService } from "../services/home.js";
import { dashboardService } from "../services/dashboard.js";
import { companyService } from "../services/companies.js";

const dialect = new PgDialect();

/** A captured query: which table it selected FROM, and its serialized WHERE. */
interface Captured {
  table: unknown;
  whereSql: string | null;
}

/**
 * Build a capturing Db. Every select chain records its `.from()` table and the
 * serialized `.where()` clause into `captured`, then resolves to `rows`.
 *
 * Supports the method surface the three services use on `db.select(...)`:
 *   .from(t).where(c)            → awaited array  (countUnreadTouchedByUser, dashboard taskRows-less)
 *   .from(t).where(c).then(fn)   → home tiles, dashboard stale
 *   .from(t).where(c).groupBy(g) → dashboard taskRows / home goal rollup
 *   .from(t).where(c).groupBy(g).then(fn)
 *   .innerJoin(...).where(c)     → memory version count (table=memory)
 *   .from(t).where(c).orderBy().limit() → recent activity
 * Unknown table queries just resolve to `rows` and are ignored by assertions.
 */
function capturingDb(rows: unknown[] = [{ count: 0 }]): { db: Db; captured: Captured[] } {
  const captured: Captured[] = [];

  function makeChain(rec: Captured) {
    const resolved = Promise.resolve(rows);
    const chain: Record<string, unknown> = {
      from(table: unknown) {
        rec.table = table;
        return chain;
      },
      innerJoin() {
        return chain;
      },
      leftJoin() {
        return chain;
      },
      where(cond: unknown) {
        try {
          rec.whereSql = cond == null ? null : dialect.sqlToQuery(cond as never).sql;
        } catch {
          rec.whereSql = null;
        }
        return chain;
      },
      groupBy() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit() {
        return chain;
      },
      then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
        return resolved.then(onF, onR);
      },
      catch(onR: (e: unknown) => unknown) {
        return resolved.catch(onR);
      },
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

/** All serialized WHERE clauses captured against a given table. */
function wheresFor(captured: Captured[], table: unknown): string[] {
  return captured
    .filter((c) => c.table === table && c.whereSql !== null)
    .map((c) => c.whereSql as string);
}

/**
 * Does this serialized WHERE contain the crew NOT-EXISTS-on-assignee predicate?
 * Drizzle's `not()` serializes as `not EXISTS (...)` (no wrapping parens), so we
 * match `not` immediately preceding the correlated agents EXISTS subquery.
 */
function hasCrewNotExists(whereSql: string): boolean {
  const flat = whereSql.replace(/\s+/g, " ");
  return (
    /not EXISTS \( SELECT 1 FROM "agents"/i.test(flat) &&
    flat.includes('"agents"."id" = "issues"."assignee_agent_id"') &&
    flat.includes(`"agents"."kind" = 'aoa'`) &&
    flat.includes(`"agents"."status" <> 'terminated'`)
  );
}

const COMPANY = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

describe("countUnreadTouchedByUser pushes notCrewAssigned (sidebar badge = org workload)", () => {
  it("the unread-count query against issues excludes crew tasks", async () => {
    const { db, captured } = capturingDb([{ count: 0 }]);
    await issueService(db).countUnreadTouchedByUser(COMPANY, USER);
    const issueWheres = wheresFor(captured, issues);
    expect(issueWheres.length).toBeGreaterThan(0);
    expect(issueWheres.some(hasCrewNotExists)).toBe(true);
  });

  it("still excludes crew when a status filter is also applied", async () => {
    const { db, captured } = capturingDb([{ count: 0 }]);
    await issueService(db).countUnreadTouchedByUser(COMPANY, USER, "in_review,blocked");
    expect(wheresFor(captured, issues).some(hasCrewNotExists)).toBe(true);
  });
});

describe("home.summary org-workload tiles push notCrewAssigned; goal rollup does NOT", () => {
  it("in-review + blocked count queries exclude crew, but the goal-progress rollup keeps crew (scope=all)", async () => {
    // Goal rollup short-circuits when there are no active goals, so the
    // goal-keyed issues query never runs. To exercise it we return one active
    // goal from the goals-table select. Benign rows for everything else.
    const captured: Captured[] = [];
    const resolvedRowsByTable = new Map<unknown, unknown[]>([
      [goals, [{ id: "g1", title: "G", status: "active" }]],
    ]);

    function makeChain(rec: Captured): Record<string, unknown> {
      const chain: Record<string, unknown> = {
        from(table: unknown) {
          rec.table = table;
          return chain;
        },
        innerJoin: () => chain,
        leftJoin: () => chain,
        where(cond: unknown) {
          try {
            rec.whereSql = cond == null ? null : dialect.sqlToQuery(cond as never).sql;
          } catch {
            rec.whereSql = null;
          }
          return chain;
        },
        groupBy: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          // Default to [] so non-count selects (e.g. recent activity) don't get a
          // bogus {count} row. The count tiles read rows[0]?.count ?? 0 → 0 on [].
          const rows = resolvedRowsByTable.get(rec.table) ?? [];
          return Promise.resolve(rows).then(onF, onR);
        },
        catch(onR: (e: unknown) => unknown) {
          return Promise.resolve([]).catch(onR);
        },
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

    await homeService(db).summary(COMPANY, USER);

    const issueWheres = wheresFor(captured, issues);
    // At least one issues query (the in-review or blocked tile) excludes crew.
    expect(issueWheres.some(hasCrewNotExists)).toBe(true);

    // The goal-progress rollup query (grouped by goalId+status) must NOT exclude
    // crew — crew work counts toward goal %. We identify it by the goalId
    // condition in its WHERE and assert it carries no crew NOT-EXISTS.
    const goalRollupWheres = issueWheres.filter((w) =>
      w.replace(/\s+/g, " ").includes('"issues"."goal_id"'),
    );
    expect(goalRollupWheres.length).toBeGreaterThan(0);
    expect(goalRollupWheres.every((w) => !hasCrewNotExists(w))).toBe(true);
  });
});

describe("dashboard.summary status + stale counts push notCrewAssigned", () => {
  it("the task-status rollup and the stale-task count exclude crew tasks", async () => {
    const { db, captured } = capturingDb([{ count: 0 }]);
    // dashboard needs a company row first; the companies select resolves to []
    // by default which throws notFound. Seed a company row for the first select.
    const recOrder: unknown[][] = [[{ id: COMPANY, budgetMonthlyCents: 0 }]];
    let call = 0;
    (db as unknown as { select: () => unknown }).select = () => {
      const rec: Captured = { table: null, whereSql: null };
      captured.push(rec);
      const rows = recOrder[call++] ?? [{ count: 0 }];
      const chain: Record<string, unknown> = {
        from(table: unknown) {
          rec.table = table;
          return chain;
        },
        innerJoin: () => chain,
        leftJoin: () => chain,
        where(cond: unknown) {
          try {
            rec.whereSql = cond == null ? null : dialect.sqlToQuery(cond as never).sql;
          } catch {
            rec.whereSql = null;
          }
          return chain;
        },
        groupBy: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          return Promise.resolve(rows).then(onF, onR);
        },
        catch(onR: (e: unknown) => unknown) {
          return Promise.resolve(rows).catch(onR);
        },
      };
      return chain;
    };

    await dashboardService(db).summary(COMPANY);

    const issueWheres = wheresFor(captured, issues);
    // Two issue queries: status rollup (groupBy) + stale count. Both exclude crew.
    expect(issueWheres.length).toBeGreaterThanOrEqual(2);
    expect(issueWheres.every(hasCrewNotExists)).toBe(true);
  });
});

describe("companyService.stats() excludes crew from the per-company issue (active-tasks) count", () => {
  // The lobby card "Active tasks" reads `issueCount` from companyService.stats().
  // stats() is a CROSS-COMPANY batch (groupBy issues.company_id, no fixed company),
  // so it pushes the CORRELATED crew predicate (notCrewAssigned() with no arg →
  // agents.company_id = issues.company_id). Mirrors the agent count, which already
  // excludes non-org agents. Crew-agent tasks must not inflate the org surface.
  it("the issues-count select carries the (correlated) crew NOT-EXISTS predicate", async () => {
    const { db, captured } = capturingDb([]);
    // "unscoped" (operator view) hits the base branch, byte-identical to the
    // pre-Fix-4 unfiltered SQL (Fix 4 made the param required + discriminated).
    await companyService(db).stats("unscoped");

    const issueWheres = wheresFor(captured, issues);
    // Exactly one issues select runs in stats() and it excludes crew tasks.
    expect(issueWheres.length).toBeGreaterThan(0);
    expect(issueWheres.some(hasCrewNotExists)).toBe(true);

    // And it is the CORRELATED form (no fixed company param) — required for the
    // cross-company batch: the company match is column-to-column on issues.
    const crewWheres = issueWheres.filter(hasCrewNotExists);
    expect(
      crewWheres.some((w) =>
        w.replace(/\s+/g, " ").includes('"agents"."company_id" = "issues"."company_id"'),
      ),
    ).toBe(true);
  });
});

// Sanity: the helper distinguishes a crew-excluding WHERE from a plain one.
describe("hasCrewNotExists helper sanity", () => {
  it("detects notCrewAssigned and rejects a bare company filter", async () => {
    const { notCrewAssigned } = await import("../services/issue-crew-scope.js");
    const crewWhere = dialect.sqlToQuery(notCrewAssigned(COMPANY) as never).sql;
    expect(hasCrewNotExists(crewWhere)).toBe(true);
    const plain = dialect.sqlToQuery(
      (await import("drizzle-orm")).eq(issues.companyId, COMPANY) as never,
    ).sql;
    expect(hasCrewNotExists(plain)).toBe(false);
    // agents reference is required so the helper can't false-positive.
    expect(agents).toBeDefined();
  });
});
