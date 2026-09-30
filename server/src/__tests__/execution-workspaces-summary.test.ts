import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @armyofagents/db to avoid drizzle-orm ESM cycle. We stub each table as a
// Proxy that records any column access, and stub the $inferSelect / $inferInsert
// type helpers.
vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
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
  };

  return {
    executionWorkspaces: makeTable("execution_workspaces"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _type: "and", args }),
  eq: (col: unknown, value: unknown) => ({ _type: "eq", col, value }),
  ne: (col: unknown, value: unknown) => ({ _type: "ne", col, value }),
  desc: (col: unknown) => ({ _type: "desc", col }),
  inArray: (col: unknown, values: unknown[]) => ({ _type: "inArray", col, values }),
}));

import { executionWorkspaceService } from "../services/execution-workspaces.js";

type MockRow = Record<string, unknown>;

interface MockDbOptions {
  selects?: MockRow[][];
}

function createMockDb(options: MockDbOptions = {}) {
  const selects = options.selects ?? [];
  let selectIdx = 0;
  const whereCalls: unknown[][] = [];

  function makeSelectChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = (...args: unknown[]) => {
      whereCalls.push(args);
      return chain;
    };
    chain.orderBy = () => chain;
    chain.limit = () => chain;
    chain.then = (resolve: (rows: MockRow[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  const db = {
    select: (..._args: unknown[]) => makeSelectChain(() => selects[selectIdx++] ?? []),
  };

  return { db: db as never, whereCalls };
}

describe("executionWorkspaceService.listSummaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns lightweight rows", async () => {
    const { db } = createMockDb({
      selects: [[
        {
          id: "ws-1",
          name: "feature-a",
          branchName: "feature-a",
          status: "active",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          sourceIssueId: "i-1",
          lastUsedAt: new Date("2026-04-22T00:00:00Z"),
        },
      ]],
    });
    const svc = executionWorkspaceService(db);
    const result = await svc.listSummaries("c-1");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "ws-1",
      name: "feature-a",
      branchName: "feature-a",
      status: "active",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      sourceIssueId: "i-1",
      lastUsedAt: new Date("2026-04-22T00:00:00Z"),
    });
  });

  it("maps null branchName/sourceIssueId defensively", async () => {
    const { db } = createMockDb({
      selects: [[
        {
          id: "ws-2",
          name: "shared",
          branchName: null,
          status: "idle",
          mode: "shared_workspace",
          strategyType: "project_primary",
          sourceIssueId: null,
          lastUsedAt: new Date("2026-04-20T00:00:00Z"),
        },
      ]],
    });
    const svc = executionWorkspaceService(db);
    const result = await svc.listSummaries("c-1");
    expect(result[0]?.branchName).toBeNull();
    expect(result[0]?.sourceIssueId).toBeNull();
  });

  it("returns empty when no rows match", async () => {
    const { db } = createMockDb({ selects: [[]] });
    const svc = executionWorkspaceService(db);
    const result = await svc.listSummaries("c-empty");
    expect(result).toEqual([]);
  });

  it("reuseEligible filter pushes status != archived + mode inArray into where clause", async () => {
    const { db, whereCalls } = createMockDb({ selects: [[]] });
    const svc = executionWorkspaceService(db);
    await svc.listSummaries("c-1", { reuseEligible: true });
    // where was called once with an and(...) containing at least 3 conditions:
    // eq(companyId), ne(status, archived), inArray(mode, [...])
    expect(whereCalls).toHaveLength(1);
    const andNode = whereCalls[0]?.[0] as { _type: string; args: unknown[] };
    expect(andNode._type).toBe("and");
    const types = (andNode.args as Array<{ _type: string; value?: unknown }>).map((a) => a._type);
    expect(types).toContain("eq");
    expect(types).toContain("ne");
    expect(types).toContain("inArray");
  });

  it("projectId filter narrows the where clause", async () => {
    const { db, whereCalls } = createMockDb({ selects: [[]] });
    const svc = executionWorkspaceService(db);
    await svc.listSummaries("c-1", { projectId: "p-1" });
    const andNode = whereCalls[0]?.[0] as { _type: string; args: Array<{ _type: string; value?: unknown }> };
    const eqValues = andNode.args.filter((a) => a._type === "eq").map((a) => a.value);
    expect(eqValues).toContain("c-1");
    expect(eqValues).toContain("p-1");
  });
});
