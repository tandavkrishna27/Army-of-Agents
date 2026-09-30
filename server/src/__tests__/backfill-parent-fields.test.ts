import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * T3: backfillParentFields() tests
 *
 * Covers:
 * - Correct count returned when agents need backfill
 * - Idempotent: second run returns 0
 * - parentType set to 'agent', parentId matches reportsTo
 * - No agents with reportsTo → returns 0
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  isNotNull: vi.fn((a: unknown) => ({ isNotNull: a })),
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
    agents: makeTable("agents"),
    agentConfigRevisions: makeTable("agent_config_revisions"),
    agentApiKeys: makeTable("agent_api_keys"),
    agentRuntimeState: makeTable("agent_runtime_state"),
    agentTaskSessions: makeTable("agent_task_sessions"),
    agentWakeupRequests: makeTable("agent_wakeup_requests"),
    heartbeatRunEvents: makeTable("heartbeat_run_events"),
    heartbeatRuns: makeTable("heartbeat_runs"),
  };
});

vi.mock("@armyofagents/shared", () => ({
  isUuidLike: vi.fn(() => false),
  normalizeAgentUrlKey: vi.fn((name: string) => name?.toLowerCase().replace(/\s+/g, "-") ?? null),
}));

vi.mock("../errors.js", () => ({
  conflict: (msg: string) => new Error(msg),
  notFound: (msg: string) => new Error(msg),
  unprocessable: (msg: string) => new Error(msg),
}));

vi.mock("../redaction.js", () => ({
  REDACTED_EVENT_VALUE: "__REDACTED__",
  sanitizeRecord: (r: unknown) => r,
}));

vi.mock("./agent-permissions.js", () => ({
  normalizeAgentPermissions: (p: unknown) => p ?? {},
}));

vi.mock("./agent-shortnames.js", () => ({
  deduplicateAgentName: vi.fn((name: string) => name),
  hasAgentShortnameCollision: vi.fn(() => false),
}));

import { agentService } from "../services/agents.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  updates?: MockRow[][];
  inserts?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;
  const selects = config.selects ?? [];
  const updates = config.updates ?? [];
  const inserts = config.inserts ?? [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of [
      "from", "where", "set", "values", "returning",
      "innerJoin", "leftJoin", "orderBy", "limit", "delete",
    ]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => updates[updateIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => []),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("backfillParentFields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("backfills agents with reportsTo but no parentType", async () => {
    const db = createSequenceDb({
      selects: [
        // backfillParentFields query: agents with reportsTo set and parentType null
        [
          { id: "agent-1", reportsTo: "manager-1" },
          { id: "agent-2", reportsTo: "manager-2" },
          { id: "agent-3", reportsTo: "manager-1" },
        ],
      ],
      updates: [
        // update agent-1
        [{ id: "agent-1" }],
        // update agent-2
        [{ id: "agent-2" }],
        // update agent-3
        [{ id: "agent-3" }],
      ],
    });

    const svc = agentService(db as never);
    const count = await svc.backfillParentFields();

    expect(count).toBe(3);
  });

  it("returns 0 when no agents need backfill (idempotent)", async () => {
    const db = createSequenceDb({
      selects: [
        // No agents match: all already have parentType set or reportsTo is null
        [],
      ],
    });

    const svc = agentService(db as never);
    const count = await svc.backfillParentFields();

    expect(count).toBe(0);
  });

  it("returns 0 when no agents have reportsTo", async () => {
    const db = createSequenceDb({
      selects: [
        // Query returns empty: no agents with reportsTo set
        [],
      ],
    });

    const svc = agentService(db as never);
    const count = await svc.backfillParentFields();

    expect(count).toBe(0);
  });

  it("sets parentType to 'agent' and parentId to reportsTo value", async () => {
    const setCalls: Record<string, unknown>[] = [];

    const db = createSequenceDb({
      selects: [
        [{ id: "agent-A", reportsTo: "manager-X" }],
      ],
    });

    // Override update to capture .set() calls
    const originalUpdate = db.update;
    db.update = (...args: unknown[]) => {
      const chain = originalUpdate(...args);
      const originalSet = chain.set as (...a: unknown[]) => unknown;
      chain.set = (...setArgs: unknown[]) => {
        setCalls.push(setArgs[0] as Record<string, unknown>);
        return originalSet(...setArgs);
      };
      return chain;
    };

    const svc = agentService(db as never);
    await svc.backfillParentFields();

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toMatchObject({
      parentType: "agent",
      parentId: "manager-X",
    });
    expect(setCalls[0]).toHaveProperty("updatedAt");
  });

  it("handles agent with reportsTo pointing to terminated agent", async () => {
    const db = createSequenceDb({
      selects: [
        // Agent reports to a terminated agent — should still backfill
        [{ id: "agent-1", reportsTo: "terminated-agent-id" }],
      ],
      updates: [
        [{ id: "agent-1" }],
      ],
    });

    const svc = agentService(db as never);
    const count = await svc.backfillParentFields();

    expect(count).toBe(1);
  });
});
