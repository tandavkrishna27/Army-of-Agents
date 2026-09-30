/**
 * U13.4 — unit tests for `preflightOneShotCliSpend` + `recordOneShotCliCost`
 * (server/src/services/one-shot-cli-budget.ts): the headless, agent-less
 * budget gate + cost-recording path for one-shot CLI sandbox spawns
 * (extraction / Commander compaction / readiness probes — U13.1's shared
 * seam, `runOneShotCliInSandbox`).
 *
 * Pattern mirrors crew-budget.test.ts (Task B4/T14): mock `@armyofagents/db`
 * + `drizzle-orm` via the shared Proxy/operator helper for the table shapes,
 * plus a locally-spied `eq` so the "no per-agent condition" claim can be
 * checked structurally (which column symbols were actually compared),
 * not just by call count.
 *
 * Query-shape contract under test (must mirror `preflightCrewDispatch`'s
 * company-scope budget gate EXACTLY — crew-budget.ts §2-3 — minus the
 * thread lookup, since this gate is headless: no thread, no system entry,
 * no live-event publish):
 *   1. budgetPolicies row (active, company-scoped, hard-stop) — may be empty
 *   2. costEvents sum (only when a policy row was found) — companyId-only,
 *      NO per-agent condition (a one-shot CLI spawn has no agent).
 *
 * A final describe block proves the U13.1 wiring contract from the outside:
 * `runOneShotCliInSandbox` fails BEFORE any spend (never reaches
 * `acquireExecutionContext`) when this gate blocks. Fuller DI-based
 * coverage of that wiring (cost-recording-on-success, best-effort failure,
 * sandboxHandle interaction) lives alongside the rest of that function's
 * tests in one-shot-sandbox-cli.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

const eqCalls = vi.hoisted(() => [] as unknown[][]);

vi.mock("drizzle-orm", () => {
  const SQL_SENTINEL: Record<string, unknown> = {};
  SQL_SENTINEL.as = () => SQL_SENTINEL;
  SQL_SENTINEL.join = () => SQL_SENTINEL;
  SQL_SENTINEL.raw = () => SQL_SENTINEL;
  const sqlFn = Object.assign((..._args: unknown[]) => SQL_SENTINEL, {
    join: (..._args: unknown[]) => SQL_SENTINEL,
    raw: (..._args: unknown[]) => SQL_SENTINEL,
  });
  return {
    and: (...args: unknown[]) => ({ tag: "and", args }),
    eq: (...args: unknown[]) => {
      eqCalls.push(args);
      return { tag: "eq", args };
    },
    gte: (...args: unknown[]) => ({ tag: "gte", args }),
    lt: (...args: unknown[]) => ({ tag: "lt", args }),
    sql: sqlFn,
  };
});

function makeTableProxy(name: string): Record<string, unknown> {
  const cols: Record<string, symbol> = {};
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === "_") return { name };
      if (prop === "$inferSelect" || prop === "$inferInsert") return {};
      if (typeof prop === "string") {
        if (!cols[prop]) cols[prop] = Symbol(prop);
        return cols[prop];
      }
      return undefined;
    },
  });
}

vi.mock("@armyofagents/db", () => ({
  budgetPolicies: makeTableProxy("budget_policies"),
  costEvents: makeTableProxy("cost_events"),
  companies: makeTableProxy("companies"),
  // present in case other transitively-imported modules destructure these —
  // never referenced by one-shot-cli-budget.ts itself.
  companySecrets: makeTableProxy("company_secrets"),
  runtimeProviderKeys: makeTableProxy("runtime_provider_keys"),
  internalAgentConfig: makeTableProxy("internal_agent_config"),
}));

import { budgetPolicies, costEvents } from "@armyofagents/db";
import { preflightOneShotCliSpend, recordOneShotCliCost } from "../services/one-shot-cli-budget.js";

const COMPANY_ID = "co-1";

type MockRow = Record<string, unknown>;

function policyRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: "policy-1",
    companyId: COMPANY_ID,
    scopeType: "company",
    scopeId: COMPANY_ID,
    metric: "cost_cents",
    windowKind: "calendar_month_utc",
    amountCents: 10000, // $100
    warnPercent: 80,
    hardStopEnabled: true,
    isActive: true,
    ...overrides,
  };
}

function spendRow(totalCents: number): MockRow {
  return { total: totalCents };
}

function tableNameOf(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const meta = (value as Record<string, unknown>)["_"];
    if (meta && typeof meta === "object") {
      const name = (meta as Record<string, unknown>).name;
      if (typeof name === "string") return name;
    }
  }
  return undefined;
}

// ── select-only sequence DB (preflightOneShotCliSpend has no writes) ──────

function createSelectSequenceDb(selects: MockRow[][]) {
  let selectIdx = 0;
  const selectCalls: { fromTable?: string }[] = [];

  function makeSelectChain(): any {
    const call: { fromTable?: string } = {};
    selectCalls.push(call);
    const chain: any = {};
    for (const m of ["where", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.from = (table: unknown) => {
      call.fromTable = tableNameOf(table);
      return chain;
    };
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(selects[selectIdx++] ?? []));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeSelectChain(),
    selectCalls,
  };
}

// ── transaction-based sequence DB (recordOneShotCliCost writes) ───────────

function createTxDb(config: { insertReturns?: MockRow[] } = {}) {
  const insertReturns: MockRow[] = config.insertReturns ?? [
    {
      id: "cost-1",
      companyId: COMPANY_ID,
      agentId: null,
      costCents: 1800,
      billingType: "extraction",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    },
  ];
  const insertCalls: { tableName?: string; values: Record<string, unknown> }[] = [];
  const updateCalls: { tableName?: string; set: Record<string, unknown> }[] = [];

  function makeTx(): any {
    return {
      insert: (table: unknown) => {
        const call = { tableName: tableNameOf(table), values: {} as Record<string, unknown> };
        insertCalls.push(call);
        return {
          values: (v: Record<string, unknown>) => {
            call.values = v;
            return { returning: () => Promise.resolve(insertReturns) };
          },
        };
      },
      update: (table: unknown) => ({
        set: (v: Record<string, unknown>) => {
          updateCalls.push({ tableName: tableNameOf(table), set: v });
          return { where: (_cond: unknown) => Promise.resolve([]) };
        },
      }),
    };
  }

  return {
    transaction: (fn: (tx: any) => Promise<unknown>) => fn(makeTx()),
    insertCalls,
    updateCalls,
  };
}

// ---------------------------------------------------------------------------

describe("preflightOneShotCliSpend (U13.4)", () => {
  it("allows when no active company-scoped hard-stop policy exists (unlimited)", async () => {
    const db = createSelectSequenceDb([[]]);
    const result = await preflightOneShotCliSpend(db as any, { companyId: COMPANY_ID });
    expect(result).toEqual({ allowed: true });
    expect(db.selectCalls).toHaveLength(1);
  });

  it("allows when observed spend is under the cap", async () => {
    const db = createSelectSequenceDb([[policyRow()], [spendRow(5000)]]);
    const result = await preflightOneShotCliSpend(db as any, { companyId: COMPANY_ID });
    expect(result).toEqual({ allowed: true });
  });

  it("blocks with reasonCode:budget_exhausted when observed spend >= cap", async () => {
    const db = createSelectSequenceDb([[policyRow({ amountCents: 10000 })], [spendRow(10500)]]);
    const result = await preflightOneShotCliSpend(db as any, { companyId: COMPANY_ID });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.reasonCode).toBe("budget_exhausted");
    expect(result.reason).toContain(COMPANY_ID);
    expect(result.reason).toContain("10500");
    expect(result.reason).toContain("10000");
  });

  it("blocks when observed spend exactly equals the cap (>= semantics)", async () => {
    const db = createSelectSequenceDb([[policyRow({ amountCents: 10000 })], [spendRow(10000)]]);
    const result = await preflightOneShotCliSpend(db as any, { companyId: COMPANY_ID });
    expect(result.allowed).toBe(false);
  });

  it("query shape: exactly 2 selects (budgetPolicies then costEvents), company-scoped only", async () => {
    const db = createSelectSequenceDb([[policyRow()], [spendRow(0)]]);
    await preflightOneShotCliSpend(db as any, { companyId: COMPANY_ID });
    expect(db.selectCalls).toHaveLength(2);
    expect(db.selectCalls[0].fromTable).toBe("budget_policies");
    expect(db.selectCalls[1].fromTable).toBe("cost_events");
  });

  it("short-circuits after the policy lookup when no policy exists — no cost_events scan", async () => {
    const db = createSelectSequenceDb([[]]);
    await preflightOneShotCliSpend(db as any, { companyId: COMPANY_ID });
    expect(db.selectCalls).toHaveLength(1);
  });

  it("the cost_events query has NO per-agent (agentId) condition — company-scope only, mirrors preflightCrewDispatch's shape", async () => {
    eqCalls.length = 0;
    const db = createSelectSequenceDb([[policyRow()], [spendRow(0)]]);
    await preflightOneShotCliSpend(db as any, { companyId: COMPANY_ID });

    const agentIdSymbol = (costEvents as unknown as Record<string, unknown>).agentId;
    const companyIdSymbol = (costEvents as unknown as Record<string, unknown>).companyId;

    const usedAgentId = eqCalls.some((call) => call[0] === agentIdSymbol);
    const usedCompanyId = eqCalls.some((call) => call[0] === companyIdSymbol);

    expect(usedAgentId).toBe(false);
    expect(usedCompanyId).toBe(true);
  });

  it("the budgetPolicies lookup IS company-scoped (companyId + scopeId both compared) — sanity check on the mock plumbing", async () => {
    eqCalls.length = 0;
    const db = createSelectSequenceDb([[policyRow()], [spendRow(0)]]);
    await preflightOneShotCliSpend(db as any, { companyId: COMPANY_ID });

    const companyIdSymbol = (budgetPolicies as unknown as Record<string, unknown>).companyId;
    const scopeIdSymbol = (budgetPolicies as unknown as Record<string, unknown>).scopeId;

    expect(eqCalls.some((call) => call[0] === companyIdSymbol)).toBe(true);
    expect(eqCalls.some((call) => call[0] === scopeIdSymbol)).toBe(true);
  });
});

describe("recordOneShotCliCost (U13.4)", () => {
  it("inserts a cost_events row with agentId:null, computeCostCents-derived costCents, and billingType=source", async () => {
    const db = createTxDb();
    const event = await recordOneShotCliCost(db as any, {
      companyId: COMPANY_ID,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      source: "extraction",
    });

    expect(db.insertCalls).toHaveLength(1);
    expect(db.insertCalls[0].tableName).toBe("cost_events");
    expect(db.insertCalls[0].values).toMatchObject({
      companyId: COMPANY_ID,
      agentId: null,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      billingType: "extraction",
      costCents: 1800, // computeCostCents(anthropic, claude-sonnet-4-6, 1M, 1M) = 300 + 1500
    });
    expect(event).toBeDefined();
  });

  it("rolls up ONLY the company's spentMonthlyCents — no agents table touched", async () => {
    const db = createTxDb();
    await recordOneShotCliCost(db as any, {
      companyId: COMPANY_ID,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      source: "compaction",
    });

    expect(db.updateCalls).toHaveLength(1);
    expect(db.updateCalls[0].tableName).toBe("companies");
  });

  it("billingType mirrors each of the three one-shot CLI sources", async () => {
    for (const source of ["extraction", "compaction", "readiness"] as const) {
      const db = createTxDb();
      await recordOneShotCliCost(db as any, {
        companyId: COMPANY_ID,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 10,
        outputTokens: 10,
        source,
      });
      expect(db.insertCalls[0].values.billingType).toBe(source);
    }
  });

  it("zero tokens produce zero cost (computeCostCents' explicit 0/0 short-circuit)", async () => {
    const db = createTxDb();
    await recordOneShotCliCost(db as any, {
      companyId: COMPANY_ID,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      source: "readiness",
    });
    expect(db.insertCalls[0].values.costCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runOneShotCliInSandbox (U13.1) — fail-before-spend wiring proof.
//
// Imported dynamically (after the file-level @armyofagents/db + drizzle-orm
// mocks above are in place) so its whole transitive import graph — including
// this file's own preflightOneShotCliSpend/recordOneShotCliCost — resolves
// against those mocks safely. Every dep this function would otherwise call
// past the preflight gate is stubbed and asserted NOT called.
// ---------------------------------------------------------------------------

describe("runOneShotCliInSandbox — fail-before-spend wiring (U13.4)", () => {
  it("throws sandbox_unavailable WITHOUT calling acquireExecutionContext or resolveCompanyProviderCredential when preflight blocks", async () => {
    const { runOneShotCliInSandbox } = await import("../services/one-shot-sandbox-cli.js");

    const preflightMock = vi.fn().mockResolvedValue({
      allowed: false,
      reason: "over budget",
      reasonCode: "budget_exhausted",
    });
    const acquireExecutionContext = vi.fn();
    const resolveCompanyProviderCredential = vi.fn();

    await expect(
      runOneShotCliInSandbox({
        db: {} as never,
        companyId: COMPANY_ID,
        cliTool: "claude",
        command: "claude",
        args: [],
        stdinContent: "x",
        timeoutMs: 1000,
        source: "extraction",
        deps: {
          preflightOneShotCliSpend: preflightMock,
          acquireExecutionContext,
          resolveCompanyProviderCredential,
        },
      }),
    ).rejects.toMatchObject({ name: "OneShotSandboxError", kind: "sandbox_unavailable" });

    expect(preflightMock).toHaveBeenCalledTimes(1);
    expect(preflightMock.mock.calls[0][1]).toEqual({ companyId: COMPANY_ID });
    expect(acquireExecutionContext).not.toHaveBeenCalled();
    expect(resolveCompanyProviderCredential).not.toHaveBeenCalled();
  });
});
