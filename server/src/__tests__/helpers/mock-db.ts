/**
 * Shared mock DB helpers for QA tests.
 *
 * Provides reusable sequence-based mock DB factories and common mock
 * table stubs to eliminate boilerplate across test files.
 */
import { vi } from "vitest";

// ── Types ────────────────────────────────────────────────────────────────────

export type MockRow = Record<string, unknown>;

// ── Discussion DB ────────────────────────────────────────────────────────────
// Used by: discussion-flow-qa, edge-cases-qa (discussion tests)

export function createDiscussionDb(selectQueue: any[][]) {
  let selectIdx = 0;

  function makeSelectChain() {
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) =>
        Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
      ),
    };
  }

  function makeDeleteChain() {
    const chain = {
      where: vi.fn(() => chain),
      returning: vi.fn(() => chain),
      then: vi.fn((fn: (rows: any[]) => any) =>
        Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
      ),
    };
    return chain;
  }

  const db: any = {
    select: vi.fn(() => makeSelectChain()),
    selectDistinctOn: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn().mockReturnThis(),
        returning: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: any[]) => any) =>
          Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
        ),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockReturnThis(),
          then: vi.fn((fn: (rows: any[]) => any) =>
            Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
          ),
        })),
      })),
    })),
    delete: vi.fn(() => makeDeleteChain()),
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => {
      const tx: any = {
        select: vi.fn(() => makeSelectChain()),
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoNothing: vi.fn().mockReturnThis(),
            returning: vi.fn().mockReturnThis(),
            then: vi.fn((fn: (rows: any[]) => any) =>
              Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
            ),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn().mockReturnThis(),
              then: vi.fn((fn: (rows: any[]) => any) =>
                Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
              ),
            })),
          })),
        })),
        delete: vi.fn(() => makeDeleteChain()),
      };
      return fn(tx);
    }),
  };

  return db;
}

// ── Agent Loop DB ────────────────────────────────────────────────────────────
// Used by: agent-panel-qa, edge-cases-qa (agent loop tests)

export function createAgentDb(config: {
  selects?: MockRow[][];
  updates?: MockRow[][];
  inserts?: MockRow[][];
  deletes?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;
  let deleteIdx = 0;
  const selects = config.selects ?? [];
  const updates = config.updates ?? [];
  const inserts = config.inserts ?? [];
  const deletes = config.deletes ?? [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of [
      "from", "where", "set", "values", "returning", "onConflictDoNothing",
      "innerJoin", "leftJoin", "orderBy", "limit", "catch",
    ]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: () => makeChain(() => selects[selectIdx++] ?? []),
    update: (_table: unknown) => makeChain(() => updates[updateIdx++] ?? []),
    insert: (_table: unknown) => makeChain(() => inserts[insertIdx++] ?? []),
    delete: (_table: unknown) => makeChain(() => deletes[deleteIdx++] ?? []),
    transaction: async (callback: (tx: any) => unknown) => {
      const proxy = {
        select: () => makeChain(() => selects[selectIdx++] ?? []),
        update: (_table: unknown) =>
          makeChain(() => updates[updateIdx++] ?? []),
        insert: (_table: unknown) =>
          makeChain(() => inserts[insertIdx++] ?? []),
        delete: (_table: unknown) =>
          makeChain(() => deletes[deleteIdx++] ?? []),
      };
      return callback(proxy);
    },
  };
}

// ── Proactive DB ─────────────────────────────────────────────────────────────
// Used by: proactive-qa, edge-cases-qa (proactive tests)

export function createProactiveDb(selectQueue: any[][], insertQueue: any[] = []) {
  // Both `select` and `selectDistinct` draw from the same FIFO queue so callers
  // keep a single ordered list of expected result sets regardless of which API
  // each query uses (blockedTaskScan now uses `selectDistinct` — A-M14).
  const makeSelectChain = () => ({
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    having: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    then: vi.fn((fn: (rows: any[]) => any) =>
      Promise.resolve(fn(selectQueue.shift() ?? [])),
    ),
  });
  return {
    select: vi.fn(() => makeSelectChain()),
    selectDistinct: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => ({
      values: vi.fn().mockReturnThis(),
      returning: vi
        .fn()
        .mockResolvedValue(insertQueue.shift() ?? [{ id: "run-1" }]),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockReturnThis(),
    })),
    update: vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([{ id: "updated" }])),
    })),
  };
}

// ── Workflow DB ───────────────────────────────────────────────────────────────
// Used by: workflow-qa, edge-cases-qa (workflow tests)

export function createWorkflowDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  updates?: MockRow[][];
  deletes?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  let deleteIdx = 0;
  const insertValues: unknown[] = [];
  const updateSets: unknown[] = [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const method of [
      "from", "where", "groupBy", "orderBy", "limit",
      "values", "set", "returning",
    ]) {
      chain[method] = (...args: unknown[]) => {
        if (method === "values") insertValues.push(args[0]);
        if (method === "set") updateSets.push(args[0]);
        return chain;
      };
    }
    chain.then = (resolve: (value: MockRow[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) =>
      makeChain(() => config.selects?.[selectIdx++] ?? []),
    insert: (..._args: unknown[]) =>
      makeChain(() => config.inserts?.[insertIdx++] ?? []),
    update: (..._args: unknown[]) =>
      makeChain(() => config.updates?.[updateIdx++] ?? []),
    delete: (..._args: unknown[]) =>
      makeChain(() => config.deletes?.[deleteIdx++] ?? []),
    execute: async (..._args: unknown[]) => [],
    transaction: async (callback: (tx: any) => unknown) => {
      const proxy = {
        select: (..._a: unknown[]) =>
          makeChain(() => config.selects?.[selectIdx++] ?? []),
        insert: (..._a: unknown[]) =>
          makeChain(() => config.inserts?.[insertIdx++] ?? []),
        update: (..._a: unknown[]) =>
          makeChain(() => config.updates?.[updateIdx++] ?? []),
        execute: async (..._a: unknown[]) => [],
      };
      return callback(proxy);
    },
    __insertValues: insertValues,
    __updateSets: updateSets,
  };
}

// ── Agent Loop Helpers ───────────────────────────────────────────────────────

/** Collect all chunks from an async generator (agent loop) */
export async function collectChunks<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Create a mock LLM provider that yields responses in order */
export function createMockProvider(responses: Array<AsyncIterable<any>>) {
  let callIdx = 0;
  return {
    name: "anthropic",
    chat: vi
      .fn()
      .mockImplementation(
        () => responses[callIdx++] ?? responses[responses.length - 1],
      ),
  };
}

// ── Common Fixtures ──────────────────────────────────────────────────────────

export const DEFAULT_AGENT_CONFIG = {
  id: "cfg-1",
  companyId: "co-1",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  autonomyLevel: 0,
  contextTokenBudget: 8000,
  budgetMonthlyCents: 10000, // $100
  spentMonthlyCents: 0,
  enabledCapabilities: [],
};

export const DEFAULT_CONVERSATION = {
  id: "conv-1",
  companyId: "co-1",
  userId: "user-1",
  status: "active",
  messageCount: 0,
  summarizedContext: null,
};

export const MOCK_TOOLS = [
  {
    name: "query_tasks",
    description: "Query tasks",
    parameters: { type: "object" as const, properties: {} },
    category: "query" as const,
    requiredRole: "team_member" as const,
    requiresConfirmation: false,
    execute: vi.fn().mockResolvedValue({
      success: true,
      data: [{ id: "t-1", title: "Test task" }],
      summary: "Found 1 task",
    }),
  },
  {
    name: "create_task",
    description: "Create a task",
    parameters: {
      type: "object" as const,
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    category: "action" as const,
    requiredRole: "founder" as const,
    requiresConfirmation: true,
    execute: vi.fn().mockResolvedValue({
      success: true,
      data: { id: "t-new" },
      summary: "Created task",
    }),
  },
];
