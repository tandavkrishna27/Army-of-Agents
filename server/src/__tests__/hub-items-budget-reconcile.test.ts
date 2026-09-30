import { beforeEach, describe, expect, it, vi } from "vitest";
import { hubItemsService } from "../services/hub-items.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

function thenableRows<T>(rows: T[]) {
  return {
    then: (resolve: (value: T[]) => unknown) => Promise.resolve(resolve(rows)),
  };
}

// Company-select chain: .from().where().limit() → thenable rows.
function companySelectChain(companyRows: Array<Record<string, unknown>>) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => thenableRows(companyRows)),
  };
  return chain;
}

// Spend-sum chain: .from().where() → thenable rows (aggregate, no .limit()).
function spendSelectChain(spendRows: Array<Record<string, unknown>>) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => thenableRows(spendRows)),
  };
  return chain;
}

// db double for the HEAL path (source non-terminal, summary drifted):
//   select#1 = reconcile's open-items scan (.from().where())
//   select#2 = reconcileCompanyBudget's company row (.from().where().limit())
//   select#3 = reconcileCompanyBudget's month-spend sum (.from().where())
// then a plain update().set().where() heal.
function makeHealDb(
  openHubItem: Record<string, unknown>,
  companyRow: Record<string, unknown> | null,
  monthSpendCents: number,
) {
  let selectCount = 0;
  const set = vi.fn(() => ({ where: vi.fn(async () => []) }));
  const db = {
    select: vi.fn(() => {
      selectCount += 1;
      if (selectCount === 1) {
        return { from: () => ({ where: () => thenableRows([openHubItem]) }) };
      }
      if (selectCount === 2) {
        return companySelectChain(companyRow ? [companyRow] : []);
      }
      return spendSelectChain([{ monthSpend: monthSpendCents }]);
    }),
    update: vi.fn(() => ({ set })),
  } as never;
  return { db, set };
}

// db double for the CLOSE path (source terminal): same 3 selects, then
// applyGuardedTransition's guarded update().set().where().returning() +
// insert(hubAudit).values().
function makeCloseDb(
  openHubItem: Record<string, unknown>,
  companyRow: Record<string, unknown> | null,
  monthSpendCents: number,
) {
  const archivedRow = {
    ...openHubItem,
    status: "archived",
    version: (openHubItem.version as number) + 1,
    archivedAt: new Date("2026-07-04T00:00:00.000Z"),
  };
  let selectCount = 0;
  const updateReturning = vi.fn(async () => [archivedRow]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const insertValues = vi.fn(async () => []);
  const db = {
    select: vi.fn(() => {
      selectCount += 1;
      if (selectCount === 1) {
        return { from: () => ({ where: () => thenableRows([openHubItem]) }) };
      }
      if (selectCount === 2) {
        return companySelectChain(companyRow ? [companyRow] : []);
      }
      return spendSelectChain([{ monthSpend: monthSpendCents }]);
    }),
    update: vi.fn(() => ({ set })),
    insert: vi.fn(() => ({ values: insertValues })),
  } as never;
  return { db, archivedRow, set, insertValues };
}

const openBudgetItem = () => ({
  id: "hub-budget-1",
  companyId: "company-1",
  sourceId: "company-1", // sourceId IS the companyId for company_budget
  sourceType: "company_budget",
  semanticType: "budget_alert",
  status: "open",
  title: "Budget approaching limit",
  summary: "85.00% used (8500/10000 cents)",
  message: "85.00% used (8500/10000 cents)",
  sourcePermissionRevision: "2026-06-01T00:00:00.000Z",
  ownerUserId: null,
  ownerPool: "board",
  scopeKey: null,
  version: 0,
  resolvedAt: null,
  archivedAt: null,
});

describe("hubItems company_budget reconciliation (H3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Freeze time so month-to-date spend windowing is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
  });

  it("closes the budget_alert when the budget is cleared to 0 (unset)", async () => {
    const { db, set, insertValues } = makeCloseDb(
      openBudgetItem(),
      { budgetMonthlyCents: 0, updatedAt: new Date("2026-06-10T00:00:00Z") },
      8500,
    );

    const result = await hubItemsService(db).reconcile("company-1", {
      sourceType: "company_budget",
    });

    expect(result).toEqual({ healed: 1, closed: 1, refreshed: 0 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "archived", version: 1 }));
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "reconcile_close",
        actorType: "system",
        actorId: "reconciler",
      }),
    );
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "hub.item.changed",
        payload: expect.objectContaining({ itemId: "hub-budget-1", change: "archived" }),
      }),
    );
  });

  it("closes the budget_alert when the company row is gone", async () => {
    const { db, set } = makeCloseDb(openBudgetItem(), null, 8500);

    const result = await hubItemsService(db).reconcile("company-1", {
      sourceType: "company_budget",
    });

    expect(result).toEqual({ healed: 1, closed: 1, refreshed: 0 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "archived" }));
  });

  it("closes the budget_alert when utilization drops below 80% (symmetric)", async () => {
    // budget 10000, spend 7990 → 79.90% < 80% → terminal.
    const { db, set } = makeCloseDb(
      openBudgetItem(),
      { budgetMonthlyCents: 10000, updatedAt: new Date("2026-06-10T00:00:00Z") },
      7990,
    );

    const result = await hubItemsService(db).reconcile("company-1", {
      sourceType: "company_budget",
    });

    expect(result).toEqual({ healed: 1, closed: 1, refreshed: 0 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "archived" }));
  });

  it("heals a stale % summary in place while utilization stays >= 80%", async () => {
    // Stored summary says 85%; live spend is 9200 → 92.00% → non-terminal + heal.
    const { db, set } = makeHealDb(
      openBudgetItem(),
      { budgetMonthlyCents: 10000, updatedAt: new Date("2026-06-14T00:00:00Z") },
      9200,
    );

    const result = await hubItemsService(db).reconcile("company-1", {
      sourceType: "company_budget",
    });

    expect(result).toEqual({ healed: 1, closed: 0, refreshed: 1 });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "92.00% used (9200/10000 cents)",
        message: "92.00% used (9200/10000 cents)",
        // updatedAt moved forward past the stored revision → revision heals too.
        sourcePermissionRevision: "2026-06-14T00:00:00.000Z",
      }),
    );
  });

  it("is a NO-OP when the live summary already matches (steady state, no ping-pong)", async () => {
    // Stored summary = 85.00% and live spend = 8500 → identical formatter output.
    // The company updatedAt equals the stored revision (nothing newer) → no write.
    const item = openBudgetItem();
    item.sourcePermissionRevision = "2026-06-10T00:00:00.000Z";
    const { db, set } = makeHealDb(
      item,
      { budgetMonthlyCents: 10000, updatedAt: new Date("2026-06-10T00:00:00Z") },
      8500,
    );

    const result = await hubItemsService(db).reconcile("company-1", {
      sourceType: "company_budget",
    });

    expect(result).toEqual({ healed: 0, closed: 0, refreshed: 0 });
    expect(set).not.toHaveBeenCalled();
  });

  it("scopes the sweep to budget_alert items only", async () => {
    // Assert the reconcile WHERE binds the budget_alert semanticType literal.
    const item = openBudgetItem();
    let capturedWhere: unknown = null;
    let selectCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return {
            from: () => ({
              where: (cond: unknown) => {
                capturedWhere = cond;
                return thenableRows([item]);
              },
            }),
          };
        }
        if (selectCount === 2) {
          return companySelectChain([
            { budgetMonthlyCents: 10000, updatedAt: new Date("2026-06-14T00:00:00Z") },
          ]);
        }
        return spendSelectChain([{ monthSpend: 9200 }]);
      }),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    } as never;

    await hubItemsService(db).reconcile("company-1", { sourceType: "company_budget" });

    const bound = collectSqlParamValues(capturedWhere);
    expect(bound).toContain("budget_alert");
    expect(bound).toContain("company_budget");
  });
});

// Walk a drizzle SQL expression tree collecting bound Param values.
function collectSqlParamValues(expr: unknown, out: unknown[] = []): unknown[] {
  if (!expr || typeof expr !== "object") return out;
  const record = expr as Record<string, unknown>;
  if ("value" in record && "encoder" in record) {
    out.push(record.value);
    return out;
  }
  if (Array.isArray(record.queryChunks)) {
    for (const chunk of record.queryChunks) collectSqlParamValues(chunk, out);
  }
  return out;
}
