/**
 * A-H6 — orphan reaper must NOT reap `queued` runs that are correctly waiting
 * behind the per-agent concurrency clamp.
 *
 * A run in status "queued" that is legitimately waiting behind the concurrency
 * clamp has NO child process, so it is never present in the in-memory
 * `runningProcesses` map. In the PERIODIC path (`staleThresholdMs > 0`) the
 * reaper must skip such runs — there is nothing to lose. The STARTUP path
 * (`staleThresholdMs === 0`, run once on boot) must STILL be able to fail a
 * `queued` row, because after a process restart the map is genuinely empty and
 * a queued row may be a crash remnant.
 *
 * These tests drive the real `reapOrphanedRuns` closure built by
 * `heartbeatService(db)`, with a chainable proxy `db` that records every
 * `update(...).set(...)` payload. The reaping side-effect is uniquely
 * identified by a `set()` payload carrying `errorCode: "process_lost"`.
 */

import { vi } from "vitest";

// ── Top-level mocks required because heartbeat.ts has DB + drizzle imports ──

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "$inferSelect" || prop === "$inferInsert" ? {} : Symbol(String(prop)),
      },
    );
  return {
    agents: makeTable(),
    agentRuntimeState: makeTable(),
    agentTaskSessions: makeTable(),
    agentWakeupRequests: makeTable(),
    heartbeatRunEvents: makeTable(),
    heartbeatRuns: makeTable(),
    costEvents: makeTable(),
    environments: makeTable(),
    issues: makeTable(),
    projectWorkspaces: makeTable(),
    memoryItems: makeTable(),
    companies: makeTable(),
    taskDependencies: makeTable(),
    issueAttachments: makeTable(),
    issueComments: makeTable(),
    assets: makeTable(),
    projects: makeTable(),
    companySkills: makeTable(),
    teamMembers: makeTable(),
    teamCoordinations: makeTable(),
    teams: makeTable(),
    discussions: makeTable(),
    executionWorkspaces: makeTable(),
    workspaceRuntimeServices: makeTable(),
    discussionExtractedItems: makeTable(),
    embeddingQueue: makeTable(),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  asc: (..._args: unknown[]) => "asc",
  desc: (..._args: unknown[]) => "desc",
  eq: (..._args: unknown[]) => "eq",
  gt: (..._args: unknown[]) => "gt",
  inArray: (..._args: unknown[]) => "inArray",
  notInArray: (..._args: unknown[]) => "notInArray",
  isNull: (..._args: unknown[]) => "isNull",
  lte: (..._args: unknown[]) => "lte",
  ne: (..._args: unknown[]) => "ne",
  or: (..._args: unknown[]) => "or",
  sql: new Proxy(
    Object.assign(() => ({ as: () => "sql" }), { raw: () => ({ as: () => "sql" }) }),
    {
      get: (_t: unknown, prop: string | symbol) =>
        prop === "apply" ? () => ({ as: () => "sql" }) : () => ({ as: () => "sql" }),
      apply: () => ({ as: () => "sql" }),
    },
  ),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
  threadWorkingAgents: vi.fn(() => []),
  broadcastThreadPresence: vi.fn(),
}));
vi.mock("../services/run-log-store.js", () => ({ getRunLogStore: vi.fn() }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

// The in-memory process map — shared and mutable so tests can seed it.
// Hoisted so the vi.mock factory (also hoisted) can reference it safely.
const { runningProcesses, cancelActiveForRunMock } = vi.hoisted(() => ({
  runningProcesses: new Map<string, unknown>(),
  cancelActiveForRunMock: vi.fn(),
}));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(),
  runningProcesses,
}));
vi.mock("../services/agent-runtime-decisions.js", () => ({
  agentRuntimeDecisionService: vi.fn(() => ({
    cancelActiveForRun: cancelActiveForRunMock,
  })),
  RuntimeDecisionCancelledError: class RuntimeDecisionCancelledError extends Error {},
}));

vi.mock("../agent-auth-jwt.js", () => ({ createLocalAgentJwt: vi.fn() }));
vi.mock("../adapters/utils.js", () => ({
  parseObject: vi.fn((v: unknown) => (v != null && typeof v === "object" ? v : {})),
  asBoolean: vi.fn((v: unknown, d: boolean) => (typeof v === "boolean" ? v : d)),
  asNumber: vi.fn((v: unknown, d: number) => (typeof v === "number" ? v : d)),
  appendWithCap: vi.fn(),
  MAX_EXCERPT_BYTES: 1024,
}));
vi.mock("../adapters/api-common.js", () => ({ setSecretResolver: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: vi.fn(() => ({})) }));
vi.mock("../services/output-detection.js", () => ({
  outputDetectionService: vi.fn(() => ({})),
}));
vi.mock("../services/run-summary.js", () => ({ formatRunSummary: vi.fn() }));
vi.mock("../services/issues.js", () => ({ issueService: vi.fn(() => ({})) }));
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { heartbeatService } from "../services/heartbeat.js";

// ────────────────────────────────────────────────────────────────────────────
// Chainable proxy `db`. Any builder method returns the same proxy. The proxy is
// thenable (resolves to []), so `getRun`/selects yield null, and downstream
// reaped-path helpers short-circuit. `transaction(fn)` runs `fn(tx)`.
// Every `.update(table)` followed by `.set(payload)` records the payload.
// ────────────────────────────────────────────────────────────────────────────

interface UpdateCall {
  set: Record<string, unknown> | null;
}

function createMockDb() {
  const updateCalls: UpdateCall[] = [];

  function makeChain(currentUpdate?: UpdateCall): any {
    const handler: ProxyHandler<any> = {
      get(_target, prop) {
        if (prop === "then") {
          // Thenable: resolve to [] so `.then(rows => rows[0] ?? null)` → null.
          return (resolve: (v: unknown) => unknown) => resolve([]);
        }
        if (prop === "transaction") {
          return async (fn: (tx: unknown) => unknown) => fn(makeChain());
        }
        if (prop === "execute") {
          return async () => [];
        }
        if (prop === "update") {
          return (..._args: unknown[]) => {
            const call: UpdateCall = { set: null };
            updateCalls.push(call);
            return makeChain(call);
          };
        }
        if (prop === "set") {
          return (payload: Record<string, unknown>) => {
            if (currentUpdate) currentUpdate.set = payload;
            return makeChain(currentUpdate);
          };
        }
        // select/from/where/orderBy/limit/innerJoin/returning/insert/values/…
        return (..._args: unknown[]) => makeChain(currentUpdate);
      },
    };
    return new Proxy(function () {}, handler);
  }

  return { db: makeChain(), updateCalls };
}

function processLostCalls(updateCalls: UpdateCall[]) {
  return updateCalls.filter((c) => c.set && c.set.errorCode === "process_lost");
}

const SIX_MIN_MS = 6 * 60 * 1000;
const PERIODIC_THRESHOLD = 5 * 60 * 1000;

function staleRun(over: Partial<Record<string, unknown>>) {
  return {
    id: "run_x",
    companyId: "co_1",
    agentId: "agent_1",
    wakeupRequestId: "wk_1",
    status: "queued",
    updatedAt: new Date(Date.now() - SIX_MIN_MS),
    ...over,
  };
}

describe("reapOrphanedRuns — A-H6 concurrency-clamp queued runs", () => {
  beforeEach(() => {
    runningProcesses.clear();
    cancelActiveForRunMock.mockReset();
    cancelActiveForRunMock.mockResolvedValue({ cancelled: 0 });
  });
  afterEach(() => {
    runningProcesses.clear();
    cancelActiveForRunMock.mockReset();
  });

  it("does NOT reap a stale `queued` run (no process) in the periodic path", async () => {
    // A queued run waiting behind the clamp: stale, not in runningProcesses.
    const run = staleRun({ id: "run_queued", status: "queued" });
    const { db, updateCalls } = createMockDb();
    // Seed the activeRuns select by overriding only the first select.then.
    const svc = createServiceWithRuns(db, [run]);

    await svc.reapOrphanedRuns({ staleThresholdMs: PERIODIC_THRESHOLD });

    // FAILING-FIRST: today the queued run IS reaped → process_lost update issued.
    expect(processLostCalls(updateCalls)).toHaveLength(0);
  });

  it("STILL reaps a stale `running` run with no process in the periodic path", async () => {
    const run = staleRun({ id: "run_running", status: "running" });
    const { db, updateCalls } = createMockDb();
    const svc = createServiceWithRuns(db, [run]);

    await svc.reapOrphanedRuns({ staleThresholdMs: PERIODIC_THRESHOLD });

    expect(processLostCalls(updateCalls).length).toBeGreaterThanOrEqual(1);
  });

  it("cancels active runtime decision prompts when it reaps an orphaned run", async () => {
    const run = staleRun({ id: "run_with_prompt", status: "running" });
    const { db } = createMockDb();
    const svc = createServiceWithRuns(db, [run]);

    await svc.reapOrphanedRuns({ staleThresholdMs: PERIODIC_THRESHOLD });

    expect(cancelActiveForRunMock).toHaveBeenCalledWith({
      companyId: "co_1",
      runId: "run_with_prompt",
      reason: "run failed",
    });
  });

  it("STILL reaps a `queued` orphan on startup (staleThresholdMs === 0)", async () => {
    // Post-restart: runningProcesses is empty; a queued row is a crash remnant.
    const run = staleRun({ id: "run_queued_boot", status: "queued" });
    const { db, updateCalls } = createMockDb();
    const svc = createServiceWithRuns(db, [run]);

    await svc.reapOrphanedRuns({ staleThresholdMs: 0 });

    expect(processLostCalls(updateCalls).length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT reap a `queued` run that IS in runningProcesses (periodic)", async () => {
    const run = staleRun({ id: "run_queued_live", status: "queued" });
    runningProcesses.set(run.id, { fake: true });
    const { db, updateCalls } = createMockDb();
    const svc = createServiceWithRuns(db, [run]);

    await svc.reapOrphanedRuns({ staleThresholdMs: PERIODIC_THRESHOLD });

    expect(processLostCalls(updateCalls)).toHaveLength(0);
  });
});

/**
 * Build the real heartbeat service but override the very first `activeRuns`
 * select (which has no `.where(...).then` terminal beyond `inArray`) to return
 * the seeded runs. `reapOrphanedRuns` does:
 *   db.select().from(heartbeatRuns).where(inArray(...))  // awaited directly
 * Our base proxy resolves selects to []. We special-case the activeRuns query
 * by wrapping `db` so the FIRST `.select().from().where()` await yields `runs`.
 */
function createServiceWithRuns(baseDb: any, runs: unknown[]) {
  let activeRunsServed = false;

  const wrapped: any = new Proxy(baseDb, {
    get(target, prop) {
      if (prop === "select") {
        return (..._args: unknown[]) => {
          // Return a one-shot chain whose terminal await yields `runs` exactly
          // once (the activeRuns query), then defers to the base proxy.
          if (!activeRunsServed) {
            return makeActiveRunsChain(() => {
              activeRunsServed = true;
              return runs;
            }, baseDb);
          }
          return (target as any).select();
        };
      }
      return (target as any)[prop];
    },
  });

  return heartbeatService(wrapped);
}

function makeActiveRunsChain(serve: () => unknown[], baseDb: any): any {
  const handler: ProxyHandler<any> = {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) => resolve(serve());
      }
      // from/where/orderBy/limit chain back to this same thenable chain.
      return (..._args: unknown[]) => makeActiveRunsChain(serve, baseDb);
    },
  };
  return new Proxy(function () {}, handler);
}
