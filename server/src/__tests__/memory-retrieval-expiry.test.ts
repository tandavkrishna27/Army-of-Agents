import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTableProxy, mockDbCapabilities } from "./helpers/drizzle-mock.js";

/**
 * A-M5 — expired active_context memory must never be served to agents.
 *
 * Bug: the query-level conditions for the agent-facing retrieval paths
 * (`searchMultiPath` → buildConditions, `searchSemantic` vector + text
 * fallback, and the pinned-skill baseline in memory-skill-sync) filtered
 * on companyId + status='approved' (+ scope) but NOT on expiresAt. An
 * `active_context` item whose `expiresAt` is in the past was therefore
 * still injected into agent context until the background sweeper archived
 * it. Commander's main path filters via memory-policy.ts (isExpired), but
 * these query paths did not.
 *
 * Fix: every agent-facing WHERE must include
 *   or(isNull(expiresAt), gt(expiresAt, sql`now()`))
 * so genuinely-expired rows (only active_context sets expiresAt; other
 * layers leave it null and isNull keeps them) are dropped at the DB.
 *
 * Test approach: the sequence-mock returns supplied rows without running
 * SQL, so behavioral filtering can't be proven here. Instead we install
 * RECORDING operator stubs for the drizzle operators: every `gt(col, ...)`
 * and `isNull(col)` call records its column argument. Because the table
 * proxy resolves `memoryItems.expiresAt` to a stable Symbol("expiresAt"),
 * we can deterministically assert the expiry predicate was constructed —
 * i.e. that `gt` was called with the expiresAt column. This fails before
 * the fix (no gt(expiresAt, …) is ever built) and passes after.
 */

// ── Recording operator stubs ───────────────────────────────────────────
// Track which columns gt / isNull were invoked against. A column is the
// Symbol returned by the table proxy; its description is the property name.
const gtCalls: unknown[][] = [];
const isNullCalls: unknown[][] = [];

function describeArg(arg: unknown): string {
  return typeof arg === "symbol" ? (arg.description ?? "") : String(arg);
}

const SQL_SENTINEL = {
  as: (_alias: string) => SQL_SENTINEL,
  join: () => SQL_SENTINEL,
  raw: (_s: string) => SQL_SENTINEL,
  sql: "sql",
  toString: () => "sql",
};

vi.mock("drizzle-orm", () => {
  const sqlProxy: unknown = new Proxy(
    Object.assign(
      function sqlFn(..._args: unknown[]) {
        return SQL_SENTINEL;
      },
      {
        join: (..._args: unknown[]) => SQL_SENTINEL,
        raw: (_s: string) => SQL_SENTINEL,
      },
    ),
    {
      get(target: Record<string, unknown>, prop: string | symbol) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        return () => SQL_SENTINEL;
      },
      apply() {
        return SQL_SENTINEL;
      },
    },
  );
  return {
    and: () => "and",
    or: () => "or",
    eq: () => "eq",
    ne: () => "ne",
    isNull: (...args: unknown[]) => {
      isNullCalls.push(args);
      return "isNull";
    },
    isNotNull: () => "isNotNull",
    inArray: () => "inArray",
    notInArray: () => "notInArray",
    gt: (...args: unknown[]) => {
      gtCalls.push(args);
      return "gt";
    },
    gte: () => "gte",
    lt: () => "lt",
    lte: () => "lte",
    like: () => "like",
    ilike: () => "ilike",
    desc: () => "desc",
    asc: () => "asc",
    count: () => "count",
    sql: sqlProxy,
  };
});

vi.mock("@armyofagents/db", () => ({
  memoryItems: makeTableProxy("memory_items"),
  agents: makeTableProxy("agents"),
  agentProjects: makeTableProxy("agent_projects"),
}));

vi.mock("../services/db-capabilities.js", () => mockDbCapabilities());

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const mockResolveApiKey = vi.fn();
vi.mock("../adapters/api-common.js", () => ({
  resolveApiKey: (...args: any[]) => mockResolveApiKey(...args),
}));

// The search paths now resolve the embedding key via getProviderApiKey
// (env-fallback-aware). Delegate to the same mock (dropping the leading db arg)
// so the existing mockResolveApiKey.mockResolved/Rejected scenarios still drive
// the no-key / has-key behavior.
vi.mock("../services/internal-agent/providers/index.js", () => ({
  getProviderApiKey: (...args: any[]) => mockResolveApiKey(...args.slice(1)),
}));

const mockGenerateEmbedding = vi.fn();
vi.mock("../services/embeddings.js", () => ({
  generateEmbedding: (...args: any[]) => mockGenerateEmbedding(...args),
}));

import { memoryService } from "../services/memory.js";
import { buildPinnedMemorySkillEntries } from "../services/memory-skill-sync.js";

function makeFakeEmbedding(dim = 1536): number[] {
  return Array.from({ length: dim }, (_, i) => i * 0.001);
}

/** A chainable mock db whose terminal calls resolve to `rows`. */
function makeMockDb(rows: any[] = []) {
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    // For skill-sync: `.where(...)` is the terminal awaited step (no .limit()),
    // and `.then(...)` is used by the agent-row lookup. Make `where` thenable.
    then: vi.fn(),
  };
  // Make the chain awaitable after .where() for queries that don't call .limit().
  chain.where = vi.fn().mockImplementation(() => makeAwaitable(rows));
  return chain;
}

/** A thenable that also supports .orderBy().limit() chaining, resolving to rows. */
function makeAwaitable(rows: any[]): any {
  const awaitable: any = {
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    then: (onFulfilled: any) => Promise.resolve(rows).then(onFulfilled),
  };
  return awaitable;
}

beforeEach(() => {
  vi.clearAllMocks();
  gtCalls.length = 0;
  isNullCalls.length = 0;
});

describe("A-M5 — expired active_context never served (query-level expiry predicate)", () => {
  describe("searchMultiPath (heartbeat agent context → buildConditions)", () => {
    it("constructs gt(expiresAt, now) in the multi-path query conditions", async () => {
      // No API key → semantic pathway skipped, but keyword + temporal still
      // run buildConditions(). Provide a non-empty query so keyword runs too.
      mockResolveApiKey.mockResolvedValue(null);
      const db = makeMockDb([]);
      const svc = memoryService(db as any);

      await svc.searchMultiPath("company-1", "ship the release", { limit: 5 });

      const gotExpiryGt = gtCalls.some((args) => describeArg(args[0]) === "expiresAt");
      const gotExpiryIsNull = isNullCalls.some((args) => describeArg(args[0]) === "expiresAt");
      expect(gotExpiryGt).toBe(true);
      expect(gotExpiryIsNull).toBe(true);
    });
  });

  describe("searchSemantic (Commander find_similar + /memory route)", () => {
    it("includes gt(expiresAt, now) on the vector path", async () => {
      mockResolveApiKey.mockResolvedValue("sk-test-key");
      mockGenerateEmbedding.mockResolvedValue(makeFakeEmbedding());
      const db = makeMockDb([]);
      const svc = memoryService(db as any);

      await svc.searchSemantic("company-1", "find similar");

      expect(gtCalls.some((args) => describeArg(args[0]) === "expiresAt")).toBe(true);
      expect(isNullCalls.some((args) => describeArg(args[0]) === "expiresAt")).toBe(true);
    });

    it("includes gt(expiresAt, now) on the text fallback path", async () => {
      // No API key → text fallback branch.
      const missingKeyError = new Error("Configure your OpenAI API key");
      (missingKeyError as any).errorCode = "missing_api_key";
      mockResolveApiKey.mockRejectedValue(missingKeyError);
      const db = makeMockDb([]);
      const svc = memoryService(db as any);

      await svc.searchSemantic("company-1", "find similar");

      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
      expect(gtCalls.some((args) => describeArg(args[0]) === "expiresAt")).toBe(true);
      expect(isNullCalls.some((args) => describeArg(args[0]) === "expiresAt")).toBe(true);
    });
  });

  describe("buildPinnedMemorySkillEntries (Tier-1 pinned skill push)", () => {
    it("filters expired items from the pinned-skill baseline query", async () => {
      // Agent row lookup → returns a runtimeConfig that inherits from dept.
      // Then agentProjects lookup, then the baseline memory_items query.
      const db: any = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn(),
      };
      // Sequence the three selects:
      //  1) agents row  →  .where(...).then(rows => rows[0])
      //  2) agentProjects → awaited array
      //  3) memory_items baseline → awaited array
      const agentRow = [{ runtimeConfig: {} }];
      const projectRows = [{ projectId: "proj-1" }];
      const baselineRows: any[] = [];
      let whereCall = 0;
      db.where = vi.fn().mockImplementation(() => {
        whereCall += 1;
        if (whereCall === 1) {
          return { then: (cb: any) => Promise.resolve(agentRow).then(cb) };
        }
        if (whereCall === 2) {
          return Promise.resolve(projectRows);
        }
        return Promise.resolve(baselineRows);
      });

      await buildPinnedMemorySkillEntries(db, "company-1", "agent-1");

      expect(gtCalls.some((args) => describeArg(args[0]) === "expiresAt")).toBe(true);
      expect(isNullCalls.some((args) => describeArg(args[0]) === "expiresAt")).toBe(true);
    });
  });
});
