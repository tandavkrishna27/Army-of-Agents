import { beforeEach, describe, expect, it, vi } from "vitest";

// ── drizzle-orm stubs ─────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    issues: makeTable("issues"),
    taskDependencies: makeTable("task_dependencies"),
  };
});

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

// Keep fireWakeups inert — we assert on the RETURNED wake list, not the enqueue.
vi.mock("../services/issue-assignee-wakeup.js", () => ({
  enqueueIssueAssigneeWakeup: vi.fn().mockResolvedValue(undefined),
}));

import { dependencyService } from "../services/dependencies.js";
import { enqueueIssueAssigneeWakeup } from "../services/issue-assignee-wakeup.js";

// ── Mock DB helpers ──────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

interface SequenceConfig {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  updates?: MockRow[][];
}

function createSequenceDb(config: SequenceConfig = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  const updateCalls: unknown[][] = [];

  function makeChain(getResult: () => MockRow[], record?: (args: unknown[]) => void): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = [
      "from", "where", "orderBy", "limit", "leftJoin", "innerJoin",
      "values", "set", "returning", "groupBy", "catch",
    ];
    for (const m of methods) {
      chain[m] = (...args: unknown[]) => {
        if (m === "set" && record) record(args);
        return chain;
      };
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  return {
    db: {
      select: (_fields?: unknown) =>
        makeChain(() => config.selects?.[selectIdx++] ?? []),
      insert: (_table: unknown) =>
        makeChain(() => config.inserts?.[insertIdx++] ?? []),
      update: (_table: unknown) =>
        makeChain(() => config.updates?.[updateIdx++] ?? [], (args) => updateCalls.push(args)),
    },
    updateCalls,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const issueD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // dependent
const issueC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // cancelled dependency
const issueE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // done dependency
const agentX = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.mocked(enqueueIssueAssigneeWakeup).mockClear();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("A-H9 — cancelled dependency releases and wakes its dependents", () => {
  it("handleCancelledDependency unblocks D and returns a wake for it", async () => {
    const { db, updateCalls } = createSequenceDb({
      selects: [
        // getDependentsTx(C) → D is blocked, waiting on C
        [{ dependentIssueId: issueD, status: "blocked" }],
        // maybeUnblockTx: select D status
        [{ status: "blocked" }],
        // maybeUnblockTx: remaining deps of D → only C, which is cancelled
        [{ status: "cancelled" }],
        // maybeUnblockTx: select assignee of D
        [{ assigneeAgentId: agentX, workMode: null }],
      ],
      updates: [[]],
    });

    const svc = dependencyService(db as never);
    const wakes = await svc.handleCancelledDependency(companyId, issueC, db as never);

    // D must be unblocked (status leaves "blocked" → todo)
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0]?.[0]).toMatchObject({ status: "todo" });

    // A wake must be produced for D so it gets dispatched after commit
    expect(wakes).toEqual([
      { companyId, agentId: agentX, issueId: issueD, workMode: null },
    ]);
  });

  it("mixed case: C cancelled + E done → completing E unblocks D (all deps terminal)", async () => {
    const { db, updateCalls } = createSequenceDb({
      selects: [
        // resolveDependenciesTx: getDependentsTx(E) → D is blocked
        [{ dependentIssueId: issueD, status: "blocked" }],
        // remaining deps of D: C cancelled + E done → all terminal
        [{ status: "cancelled" }, { status: "done" }],
        // assignee of D
        [{ assigneeAgentId: agentX, workMode: null }],
      ],
      updates: [[]],
    });

    const svc = dependencyService(db as never);
    const { tasksToWake } = await svc.resolveDependencies(companyId, issueE, db as never);

    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0]?.[0]).toMatchObject({ status: "todo" });
    expect(tasksToWake).toEqual([
      { companyId, agentId: agentX, issueId: issueD, workMode: null },
    ]);
  });

  it("does NOT unblock D while a non-terminal dependency remains", async () => {
    const { db, updateCalls } = createSequenceDb({
      selects: [
        // getDependentsTx → D blocked
        [{ dependentIssueId: issueD, status: "blocked" }],
        // maybeUnblockTx: D status
        [{ status: "blocked" }],
        // remaining deps: one cancelled, one still in_progress → NOT all terminal
        [{ status: "cancelled" }, { status: "in_progress" }],
      ],
      updates: [[]],
    });

    const svc = dependencyService(db as never);
    const wakes = await svc.handleCancelledDependency(companyId, issueC, db as never);

    expect(updateCalls.length).toBe(0);
    expect(wakes).toEqual([]);
  });
});
