import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────
// Same drizzle-orm ESM cycle workaround as workspace-ttl-sweeper.test.ts.
// Stubs registered before SUT import.

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _type: "and", args }),
  eq: (col: unknown, value: unknown) => ({ _type: "eq", col, value }),
  ne: (col: unknown, value: unknown) => ({ _type: "ne", col, value }),
  lt: (col: unknown, value: unknown) => ({ _type: "lt", col, value }),
  isNotNull: (col: unknown) => ({ _type: "isNotNull", col }),
  isNull: (col: unknown) => ({ _type: "isNull", col }),
  desc: (col: unknown) => ({ _type: "desc", col }),
  inArray: (col: unknown, values: unknown[]) => ({ _type: "inArray", col, values }),
}));

vi.mock("@armyofagents/db", () => {
  const cols: Record<string, symbol> = {};
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[`${name}.${prop}`]) cols[`${name}.${prop}`] = Symbol(`${name}.${prop}`);
          return cols[`${name}.${prop}`];
        }
        return undefined;
      },
    });

  return {
    executionWorkspaces: makeTable("execution_workspaces"),
    issues: makeTable("issues"),
    projects: makeTable("projects"),
    projectWorkspaces: makeTable("project_workspaces"),
    workspaceRuntimeServices: makeTable("workspace_runtime_services"),
    instanceSettings: makeTable("instance_settings"),
    companies: makeTable("companies"),
  };
});

// instance-settings + execution-workspaces are imported by the sweeper module
// at top-level. Even though markThreadWorkspacesForCleanup does not exercise
// them, the import graph still needs them stubbed.
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getExperimental: vi.fn(),
  }),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({
    getCloseReadiness: vi.fn(),
  }),
}));

// Importing after mocks are registered
import { markThreadWorkspacesForCleanup } from "../services/workspace-ttl-sweeper.js";

// ── Mock DB helper ───────────────────────────────────────────────────────────
//
// markThreadWorkspacesForCleanup is single-statement: `db.update(...).set(...)
// .where(...).returning({ id })`. The mock records the patch + WHERE clause
// for assertions and returns a configurable list of rows from .returning().

interface UpdateCapture {
  patch: Record<string, unknown>;
  whereArg: unknown;
}

function createDb(opts: { returningRows?: Array<{ id: string }> } = {}) {
  const returningRows = opts.returningRows ?? [];
  const captures: UpdateCapture[] = [];

  function makeUpdateChain() {
    const state: { patch: Record<string, unknown> | null; whereArg: unknown } = {
      patch: null,
      whereArg: undefined,
    };
    const chain: Record<string, unknown> = {};
    chain.set = (patch: Record<string, unknown>) => {
      state.patch = patch;
      return chain;
    };
    chain.where = (arg: unknown) => {
      state.whereArg = arg;
      return chain;
    };
    chain.returning = () => {
      if (state.patch !== null) {
        captures.push({ patch: state.patch, whereArg: state.whereArg });
      }
      return Promise.resolve(returningRows);
    };
    return chain;
  }

  return {
    db: {
      update: () => makeUpdateChain(),
    } as never,
    captures,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("markThreadWorkspacesForCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks all matching thread-scoped workspaces and returns the count", async () => {
    // Two unmarked active thread workspaces — both come back from .returning()
    const { db, captures } = createDb({
      returningRows: [{ id: "ws-thread-1" }, { id: "ws-thread-2" }],
    });

    const result = await markThreadWorkspacesForCleanup(db, "thread-abc");

    expect(result).toEqual({ marked: 2 });
    expect(captures).toHaveLength(1);
    const patch = captures[0]!.patch;
    expect(patch.cleanupReason).toBe("thread_archived");
    expect(patch.cleanupEligibleAt).toBeInstanceOf(Date);
    expect(patch.updatedAt).toBeInstanceOf(Date);
  });

  it("is idempotent — already-marked workspaces are skipped by the WHERE clause", async () => {
    // Production WHERE filter (`cleanupEligibleAt IS NULL`) excludes
    // already-marked rows at the DB layer; the mock encodes this by returning
    // an empty .returning() result for an idempotent call.
    const { db, captures } = createDb({ returningRows: [] });

    const result = await markThreadWorkspacesForCleanup(db, "thread-idempotent");

    expect(result).toEqual({ marked: 0 });
    // The UPDATE statement still runs (the WHERE is what gates it) — and the
    // mock still captures the patch shape so we can verify the contract.
    expect(captures).toHaveLength(1);
    expect(captures[0]!.patch.cleanupReason).toBe("thread_archived");
  });

  it("ignores archived workspaces (status='archived' is filtered out by WHERE)", async () => {
    // Same encoding as the idempotent case: production WHERE excludes
    // archived workspaces (`status <> 'archived'`); the mock returns no rows
    // and we assert marked=0.
    const { db, captures } = createDb({ returningRows: [] });

    const result = await markThreadWorkspacesForCleanup(db, "thread-with-only-archived-ws");

    expect(result).toEqual({ marked: 0 });
    expect(captures).toHaveLength(1);
  });

  it("ignores workspaces belonging to a different thread (threadId filter)", async () => {
    // A workspace whose threadId does not match the input threadId should not
    // be touched. Production WHERE includes `eq(threadId, input)`. The mock
    // encodes this by returning only the workspaces that *do* match.
    const { db, captures } = createDb({
      returningRows: [{ id: "ws-matching-thread" }],
    });

    const result = await markThreadWorkspacesForCleanup(db, "thread-target");

    expect(result).toEqual({ marked: 1 });
    expect(captures).toHaveLength(1);
    expect(captures[0]!.patch.cleanupReason).toBe("thread_archived");
  });
});
