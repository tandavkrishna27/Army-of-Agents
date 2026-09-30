import { beforeEach, describe, expect, it, vi } from "vitest";

const { emitHubItem, buildApprovalHubEmit, buildBudgetAlertHubEmit, buildFailedRunHubEmit, buildStaleIssueHubEmit } = vi.hoisted(() => ({
  emitHubItem: vi.fn(),
  buildApprovalHubEmit: vi.fn((approval) => ({
    companyId: approval.companyId,
    semanticType: "approval_request",
    sourceType: "approval",
    sourceId: approval.id,
  })),
  buildStaleIssueHubEmit: vi.fn((issue) => ({
    companyId: issue.companyId,
    semanticType: "stale_work",
    sourceType: "issue",
    sourceId: issue.id,
  })),
  buildBudgetAlertHubEmit: vi.fn((alert) => ({
    companyId: alert.companyId,
    semanticType: "budget_alert",
    sourceType: "company_budget",
    sourceId: alert.companyId,
  })),
  buildFailedRunHubEmit: vi.fn((run) => ({
    companyId: run.companyId,
    semanticType: "run_failed",
    sourceType: "heartbeat_run",
    sourceId: run.id,
  })),
}));

vi.mock("../services/hub-source-producers.js", () => ({
  buildApprovalHubEmit,
  buildBudgetAlertHubEmit,
  buildFailedRunHubEmit,
  buildStaleIssueHubEmit,
  emitHubItem,
}));

// The producers module is mocked above for the materializer-scan tests; the
// builder unit tests below need the REAL implementations. `vi.importActual`
// bypasses that mock — and its only runtime dependency (./hub-items.js) is
// stubbed here so the heavy hub-items module graph never loads.
vi.mock("../services/hub-items.js", () => ({
  hubItemsService: vi.fn(() => ({ emit: vi.fn() })),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  desc: (...args: unknown[]) => ({ desc: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  gte: (...args: unknown[]) => ({ gte: args }),
  inArray: (...args: unknown[]) => ({ inArray: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
  lt: (...args: unknown[]) => ({ lt: args }),
  not: (...args: unknown[]) => ({ not: args }),
  sql: () => "sql",
}));

vi.mock("@armyofagents/db", () => ({
  agents: {
    id: "agents.id",
    name: "agents.name",
    companyId: "agents.companyId",
    status: "agents.status",
  },
  approvals: { companyId: "approvals.companyId", status: "approvals.status" },
  companies: {
    id: "companies.id",
    budgetMonthlyCents: "companies.budgetMonthlyCents",
    updatedAt: "companies.updatedAt",
  },
  costEvents: {
    companyId: "costEvents.companyId",
    costCents: "costEvents.costCents",
    occurredAt: "costEvents.occurredAt",
  },
  heartbeatRuns: {
    id: "heartbeatRuns.id",
    companyId: "heartbeatRuns.companyId",
    agentId: "heartbeatRuns.agentId",
    status: "heartbeatRuns.status",
    error: "heartbeatRuns.error",
    createdAt: "heartbeatRuns.createdAt",
    updatedAt: "heartbeatRuns.updatedAt",
  },
  issues: {
    companyId: "issues.companyId",
    status: "issues.status",
    assigneeAgentId: "issues.assigneeAgentId",
    updatedAt: "issues.updatedAt",
  },
}));

import { emitOpenApprovalHubItems } from "../services/hub-approval-requests.js";
import { emitLegacyAlertHubItems } from "../services/hub-legacy-alerts.js";
import { emitStaleWorkHubItems } from "../services/hub-stale-work.js";

const producers = (await vi.importActual(
  "../services/hub-source-producers.js",
)) as typeof import("../services/hub-source-producers.js");

function makeSelectDb(rows: Array<Record<string, unknown>>) {
  const limits: number[] = [];
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn((value: number) => {
      limits.push(value);
      return Promise.resolve(rows);
    }),
  };
  return {
    db: { select: vi.fn(() => chain) },
    limits,
  };
}

function makeLegacyAlertDb() {
  const latestRuns = [
    {
      id: "run-failed",
      companyId: "co-1",
      agentId: "agent-1",
      agentName: "Scout",
      status: "failed",
      error: "boom",
      updatedAt: new Date("2026-06-30T00:00:00Z"),
    },
    {
      id: "run-ok",
      companyId: "co-1",
      agentId: "agent-2",
      agentName: "Builder",
      status: "succeeded",
      error: null,
      updatedAt: new Date("2026-06-30T00:00:00Z"),
    },
  ];
  const companyRows = [{ id: "co-1", budgetMonthlyCents: 10000, updatedAt: new Date("2026-06-30T00:00:00Z") }];
  const spendRows = [{ monthSpend: 8500 }];
  let selectCalls = 0;

  const latestChain = {
    from: vi.fn(() => latestChain),
    innerJoin: vi.fn(() => latestChain),
    where: vi.fn(() => latestChain),
    orderBy: vi.fn(() => Promise.resolve(latestRuns)),
  };
  const companyChain = {
    from: vi.fn(() => companyChain),
    where: vi.fn(() => companyChain),
    limit: vi.fn(() => Promise.resolve(companyRows)),
  };
  const spendChain = {
    from: vi.fn(() => spendChain),
    where: vi.fn(() => Promise.resolve(spendRows)),
  };

  return {
    db: {
      selectDistinctOn: vi.fn(() => latestChain),
      select: vi.fn(() => {
        selectCalls += 1;
        return selectCalls === 1 ? companyChain : spendChain;
      }),
    },
  };
}

describe("hub source materializers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitHubItem.mockResolvedValue({ id: "hub-1" });
  });

  it("caps open approval materialization at 50", async () => {
    const { db, limits } = makeSelectDb([{ id: "approval-1", companyId: "co-1" }]);

    await emitOpenApprovalHubItems(db as any, "co-1", 500);

    expect(limits).toEqual([50]);
    expect(buildApprovalHubEmit).toHaveBeenCalledWith({ id: "approval-1", companyId: "co-1" });
    expect(emitHubItem).toHaveBeenCalledWith(db, {
      companyId: "co-1",
      semanticType: "approval_request",
      sourceType: "approval",
      sourceId: "approval-1",
    });
  });

  it("caps stale-work materialization at 50", async () => {
    const { db, limits } = makeSelectDb([{ id: "issue-1", companyId: "co-1" }]);

    await emitStaleWorkHubItems(db as any, "co-1", 500);

    expect(limits).toEqual([50]);
    expect(buildStaleIssueHubEmit).toHaveBeenCalledWith({ id: "issue-1", companyId: "co-1" });
    expect(emitHubItem).toHaveBeenCalledWith(db, {
      companyId: "co-1",
      semanticType: "stale_work",
      sourceType: "issue",
      sourceId: "issue-1",
    });
  });

  it("materializes latest failed runs and budget threshold alerts", async () => {
    const { db } = makeLegacyAlertDb();

    const result = await emitLegacyAlertHubItems(db as any, "co-1");

    expect(result).toEqual({ emitted: 2, failedRuns: 1, budgetAlerts: 1 });
    expect(buildFailedRunHubEmit).toHaveBeenCalledWith(expect.objectContaining({ id: "run-failed" }));
    expect(buildFailedRunHubEmit).not.toHaveBeenCalledWith(expect.objectContaining({ id: "run-ok" }));
    expect(buildBudgetAlertHubEmit).toHaveBeenCalledWith({
      companyId: "co-1",
      monthSpendCents: 8500,
      monthBudgetCents: 10000,
      monthUtilizationPercent: 85,
      updatedAt: new Date("2026-06-30T00:00:00Z"),
    });
    expect(emitHubItem).toHaveBeenCalledWith(db, {
      companyId: "co-1",
      semanticType: "run_failed",
      sourceType: "heartbeat_run",
      sourceId: "run-failed",
    });
    expect(emitHubItem).toHaveBeenCalledWith(db, {
      companyId: "co-1",
      semanticType: "budget_alert",
      sourceType: "company_budget",
      sourceId: "co-1",
    });
  });
});

// BUG-5: terminal-run hub emit builders (REAL implementations via importActual).
describe("terminal-run hub emit builders", () => {
  const baseRun = {
    id: "run-1",
    companyId: "co-1",
    agentId: "agent-1",
    agentName: "Scout",
    status: "succeeded",
    error: null,
    updatedAt: new Date("2026-06-30T00:00:00Z"),
  };

  it("buildCompletedRunHubEmit shapes a normal-priority run_complete item", () => {
    expect(producers.buildCompletedRunHubEmit(baseRun)).toStrictEqual({
      companyId: "co-1",
      semanticType: "run_complete",
      sourceType: "heartbeat_run",
      sourceId: "run-1",
      title: "Scout run complete",
      summary: "Run finished successfully",
      sourceActorType: "agent",
      sourceActorId: "agent-1",
      relatedEntityType: "agent",
      relatedEntityId: "agent-1",
      priority: "normal",
      sourcePermissionRevision: "2026-06-30T00:00:00.000Z",
    });
  });

  it("both run producers carry the owning agent as relatedEntity (run-tab id split)", () => {
    // The run viewer tab is runTab(runId=sourceId, agentId=relatedEntityId); the
    // agentId is surfaced via relatedEntity, NOT the source unique key (so the
    // change-aware upsert never re-keys the row).
    const failed = producers.buildFailedRunHubEmit({ ...baseRun, status: "failed" });
    expect(failed.relatedEntityType).toBe("agent");
    expect(failed.relatedEntityId).toBe("agent-1");
    // sourceId stays the RUN id — distinct from the agent id.
    expect(failed.sourceId).toBe("run-1");

    const completed = producers.buildCompletedRunHubEmit(baseRun);
    expect(completed.relatedEntityType).toBe("agent");
    expect(completed.relatedEntityId).toBe("agent-1");
    expect(completed.sourceId).toBe("run-1");
  });

  it("buildCompletedRunHubEmit falls back to 'Agent' for a missing/blank agent name", () => {
    expect(producers.buildCompletedRunHubEmit({ ...baseRun, agentName: null }).title).toBe(
      "Agent run complete",
    );
    expect(producers.buildCompletedRunHubEmit({ ...baseRun, agentName: "   " }).title).toBe(
      "Agent run complete",
    );
  });

  it("buildTerminalRunHubEmit keeps successful process exits out of attention lanes", () => {
    expect(producers.buildTerminalRunHubEmit(baseRun)).toBeNull();
  });

  it.each(["failed", "timed_out"])(
    "PARITY: buildTerminalRunHubEmit(%s) deep-equals buildFailedRunHubEmit for the same run",
    (status) => {
      // The event producer and the legacy sidebar-badges scan MUST emit
      // byte-identical rows for the same run — any drift would ping-pong the
      // change-aware upsert between the two producers (mini feedback storm).
      const run = { ...baseRun, status, error: "boom" };
      const viaTerminal = producers.buildTerminalRunHubEmit(run);
      expect(viaTerminal).not.toBeNull();
      expect(viaTerminal).toStrictEqual(producers.buildFailedRunHubEmit(run));
      expect(viaTerminal!.semanticType).toBe("run_failed");
      expect(viaTerminal!.priority).toBe("high");
    },
  );

  it.each(["succeeded", "cancelled", "running", "queued", "scheduled_retry"])(
    "buildTerminalRunHubEmit(%s) emits nothing (null)",
    (status) => {
      expect(producers.buildTerminalRunHubEmit({ ...baseRun, status })).toBeNull();
    },
  );
});

// H3: the shared budget-alert summary formatter. It must be BYTE-IDENTICAL to
// the producer's historical inline summary string for the same spend/budget —
// that byte-identity is what keeps the change-aware upsert and the company_budget
// reconciler's heal path from ping-ponging (a self-inflicted feedback storm).
describe("formatBudgetAlertSummary (H3 storm-safe parity)", () => {
  // Reconstructs the EXACT pre-H3 inline producer string:
  //   `${alert.monthUtilizationPercent.toFixed(2)}% used (${spend}/${budget} cents)`
  // where the sole caller (hub-legacy-alerts.ts) passed
  //   monthUtilizationPercent = Number(((spend/budget)*100).toFixed(2)).
  function oldProducerSummary(spendCents: number, budgetCents: number): string {
    const monthUtilizationPercent = Number((((spendCents / budgetCents) * 100)).toFixed(2));
    return `${monthUtilizationPercent.toFixed(2)}% used (${spendCents}/${budgetCents} cents)`;
  }

  it.each([
    [8500, 10000], // 85.00% — the canonical test-instance value
    [11109, 10000], // 111.09% — the QA over-budget freeze case (double-round parity)
    [9999, 10000], // 99.99%
    [8000, 10000], // 80.00% — the threshold boundary
    [123, 10000], // 1.23% — low, exercises rounding
    [10000, 30000], // 33.333...% — non-terminating → toFixed rounds identically
  ])(
    "matches the pre-H3 producer summary byte-for-byte (spend=%i budget=%i)",
    (spend, budget) => {
      expect(producers.formatBudgetAlertSummary(spend, budget)).toBe(
        oldProducerSummary(spend, budget),
      );
    },
  );

  it("produces the exact documented shape", () => {
    expect(producers.formatBudgetAlertSummary(8500, 10000)).toBe("85.00% used (8500/10000 cents)");
  });

  it("the producer summary flows through the shared formatter (single source of truth)", () => {
    const emit = producers.buildBudgetAlertHubEmit({
      companyId: "co-1",
      monthSpendCents: 8500,
      monthBudgetCents: 10000,
      monthUtilizationPercent: 85,
      updatedAt: new Date("2026-06-30T00:00:00Z"),
    });
    expect(emit.summary).toBe(producers.formatBudgetAlertSummary(8500, 10000));
    expect(emit.summary).toBe("85.00% used (8500/10000 cents)");
  });

  it("never divides by zero: a cleared/zero budget yields 0.00%", () => {
    expect(producers.formatBudgetAlertSummary(500, 0)).toBe("0.00% used (500/0 cents)");
  });
});
