import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB / drizzle stubs ────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
  asc: vi.fn((col: unknown) => ({ asc: col })),
  gte: vi.fn((a: unknown, b: unknown) => ({ gte: [a, b] })),
  lte: vi.fn((a: unknown, b: unknown) => ({ lte: [a, b] })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
  isNotNull: vi.fn((col: unknown) => ({ isNotNull: col })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
  sql: new Proxy(() => ({ sql: true }), {
    get: () => () => ({ sql: true }),
    apply: () => ({ sql: true }),
  }),
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
    providerQuotaWindows: makeTable("provider_quota_windows"),
  };
});

// Mock adapter registry so tests can control adapter.getQuotaWindows behavior.
const mockListServerAdapters = vi.hoisted(() => vi.fn(() => [] as any[]));
const mockFindServerAdapter = vi.hoisted(() => vi.fn((_type: string) => null as any));
vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: mockListServerAdapters,
  findServerAdapter: mockFindServerAdapter,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { quotaWindowsService, providerSlugForAdapterType } from "../services/quota-windows.js";

// ── Mock DB helpers ──────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  updates?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  const captured: { inserts: MockRow[]; updates: MockRow[] } = { inserts: [], updates: [] };

  function makeChain(getResult: () => MockRow[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = [
      "from", "where", "orderBy", "limit", "leftJoin", "innerJoin",
      "set", "returning", "groupBy", "onConflictDoUpdate", "onConflictDoNothing",
    ];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  function makeInsertChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    chain.values = (v: MockRow | MockRow[]) => {
      if (Array.isArray(v)) captured.inserts.push(...v);
      else captured.inserts.push(v);
      const inner: Record<string, unknown> = {};
      const methods = ["returning", "onConflictDoUpdate", "onConflictDoNothing"];
      for (const m of methods) {
        inner[m] = (..._args: unknown[]) => inner;
      }
      inner.then = (resolve: (v: MockRow[]) => unknown) =>
        Promise.resolve(getResult()).then(resolve);
      return inner;
    };
    return chain;
  }

  return {
    db: {
      select: (_fields?: unknown) =>
        makeChain(() => config.selects?.[selectIdx++] ?? []),
      insert: (_table: unknown) =>
        makeInsertChain(() => config.inserts?.[insertIdx++] ?? []),
      update: (_table: unknown) => {
        const chain = makeChain(() => config.updates?.[updateIdx++] ?? []);
        const origSet = chain.set as (v: MockRow) => unknown;
        chain.set = (v: MockRow) => {
          captured.updates.push(v);
          return origSet.call(chain, v);
        };
        return chain;
      },
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: (_fields?: unknown) =>
            makeChain(() => config.selects?.[selectIdx++] ?? []),
          insert: (_table: unknown) =>
            makeInsertChain(() => config.inserts?.[insertIdx++] ?? []),
          update: (_table: unknown) => {
            const chain = makeChain(() => config.updates?.[updateIdx++] ?? []);
            const origSet = chain.set as (v: MockRow) => unknown;
            chain.set = (v: MockRow) => {
              captured.updates.push(v);
              return origSet.call(chain, v);
            };
            return chain;
          },
        }),
    },
    captured,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const sampleWindow = {
  id: "window-1",
  companyId,
  provider: "anthropic",
  model: "sonnet",
  windowKind: "5h",
  label: "Sonnet 5h",
  limitValue: 100,
  usedValue: 42,
  usedPercent: 42,
  valueLabel: null,
  resetAt: new Date("2026-04-21T05:00:00Z"),
  lastUpdatedAt: new Date("2026-04-21T00:00:00Z"),
  createdAt: new Date("2026-04-21T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListServerAdapters.mockReturnValue([]);
  mockFindServerAdapter.mockReturnValue(null);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("providerSlugForAdapterType", () => {
  it("maps claude_local → anthropic", () => {
    expect(providerSlugForAdapterType("claude_local")).toBe("anthropic");
  });

  it("maps codex_local → openai", () => {
    expect(providerSlugForAdapterType("codex_local")).toBe("openai");
  });

  it("passes through other adapter types unchanged", () => {
    expect(providerSlugForAdapterType("gemini_local")).toBe("gemini_local");
    expect(providerSlugForAdapterType("cursor")).toBe("cursor");
  });
});

describe("quotaWindowsService — list / getWindow", () => {
  it("list returns rows from db scoped to companyId", async () => {
    const { db } = createSequenceDb({ selects: [[sampleWindow]] });
    const svc = quotaWindowsService(db as any);
    const result = await svc.list(companyId);
    expect(result).toEqual([sampleWindow]);
  });

  it("list returns [] when no snapshots exist", async () => {
    const { db } = createSequenceDb({ selects: [[]] });
    const svc = quotaWindowsService(db as any);
    const result = await svc.list(companyId);
    expect(result).toEqual([]);
  });

  it("getWindow returns single snapshot when found", async () => {
    const { db } = createSequenceDb({ selects: [[sampleWindow]] });
    const svc = quotaWindowsService(db as any);
    const result = await svc.getWindow(companyId, "anthropic", "sonnet", "5h");
    expect(result).toEqual(sampleWindow);
  });

  it("getWindow returns null when no row matches", async () => {
    const { db } = createSequenceDb({ selects: [[]] });
    const svc = quotaWindowsService(db as any);
    const result = await svc.getWindow(companyId, "anthropic", null, "7d");
    expect(result).toBeNull();
  });
});

describe("quotaWindowsService — refresh", () => {
  it("returns [] when adapter type is unknown", async () => {
    mockFindServerAdapter.mockReturnValue(null);
    const { db } = createSequenceDb();
    const svc = quotaWindowsService(db as any);
    const rows = await svc.refresh(companyId, "unknown_adapter");
    expect(rows).toEqual([]);
  });

  it("returns [] when adapter has no getQuotaWindows method", async () => {
    mockFindServerAdapter.mockReturnValue({ type: "claude_local" });
    const { db } = createSequenceDb();
    const svc = quotaWindowsService(db as any);
    const rows = await svc.refresh(companyId, "claude_local");
    expect(rows).toEqual([]);
  });

  it("upserts snapshot rows for each window returned by adapter", async () => {
    mockFindServerAdapter.mockReturnValue({
      type: "claude_local",
      getQuotaWindows: async () => ({
        provider: "anthropic",
        ok: true,
        windows: [
          { label: "5h", usedPercent: 42, resetsAt: "2026-04-21T05:00:00Z", valueLabel: null },
          { label: "7d", usedPercent: 10, resetsAt: "2026-04-28T00:00:00Z", valueLabel: null },
        ],
      }),
    });
    const { db, captured } = createSequenceDb({
      inserts: [[{ ...sampleWindow, windowKind: "5h" }], [{ ...sampleWindow, windowKind: "7d" }]],
    });
    const svc = quotaWindowsService(db as any);
    const rows = await svc.refresh(companyId, "claude_local");
    expect(rows).toHaveLength(2);
    expect(captured.inserts).toHaveLength(2);
    expect(captured.inserts[0]).toMatchObject({
      companyId,
      provider: "anthropic",
      windowKind: "5h",
      usedPercent: 42,
    });
    expect(captured.inserts[1]).toMatchObject({
      companyId,
      provider: "anthropic",
      windowKind: "7d",
      usedPercent: 10,
    });
  });

  it("returns [] and swallows error when adapter.getQuotaWindows throws", async () => {
    mockFindServerAdapter.mockReturnValue({
      type: "claude_local",
      getQuotaWindows: async () => {
        throw new Error("provider unreachable");
      },
    });
    const { db } = createSequenceDb();
    const svc = quotaWindowsService(db as any);
    const rows = await svc.refresh(companyId, "claude_local");
    expect(rows).toEqual([]);
  });

  it("returns [] when adapter reports ok: false", async () => {
    mockFindServerAdapter.mockReturnValue({
      type: "claude_local",
      getQuotaWindows: async () => ({
        provider: "anthropic",
        ok: false,
        error: "rate limited",
        windows: [],
      }),
    });
    const { db } = createSequenceDb();
    const svc = quotaWindowsService(db as any);
    const rows = await svc.refresh(companyId, "claude_local");
    expect(rows).toEqual([]);
  });
});

describe("quotaWindowsService — refreshAll", () => {
  it("iterates all adapters with getQuotaWindows and aggregates upserts", async () => {
    mockListServerAdapters.mockReturnValue([
      {
        type: "claude_local",
        getQuotaWindows: async () => ({
          provider: "anthropic",
          ok: true,
          windows: [{ label: "5h", usedPercent: 42, resetsAt: null, valueLabel: null }],
        }),
      },
      {
        type: "codex_local",
        getQuotaWindows: async () => ({
          provider: "openai",
          ok: true,
          windows: [{ label: "Credits", usedPercent: null, resetsAt: null, valueLabel: "$4.20 remaining" }],
        }),
      },
      { type: "cursor" }, // no getQuotaWindows; should be skipped
    ]);
    const { db, captured } = createSequenceDb({
      inserts: [
        [{ ...sampleWindow }],
        [{ ...sampleWindow, provider: "openai", windowKind: "Credits" }],
      ],
    });
    const svc = quotaWindowsService(db as any);
    const rows = await svc.refreshAll(companyId);
    expect(rows).toHaveLength(2);
    expect(captured.inserts).toHaveLength(2);
    expect(captured.inserts[0]?.provider).toBe("anthropic");
    expect(captured.inserts[1]?.provider).toBe("openai");
  });

  it("continues when one adapter fails", async () => {
    mockListServerAdapters.mockReturnValue([
      {
        type: "claude_local",
        getQuotaWindows: async () => {
          throw new Error("provider unreachable");
        },
      },
      {
        type: "codex_local",
        getQuotaWindows: async () => ({
          provider: "openai",
          ok: true,
          windows: [{ label: "Credits", usedPercent: 10, resetsAt: null, valueLabel: null }],
        }),
      },
    ]);
    const { db, captured } = createSequenceDb({
      inserts: [[{ ...sampleWindow, provider: "openai" }]],
    });
    const svc = quotaWindowsService(db as any);
    const rows = await svc.refreshAll(companyId);
    expect(rows).toHaveLength(1);
    expect(captured.inserts[0]?.provider).toBe("openai");
  });
});

describe("quotaWindowsService — recordUsage", () => {
  it("upserts a single snapshot row with the provided fields", async () => {
    const { db, captured } = createSequenceDb({
      inserts: [[{ ...sampleWindow }]],
    });
    const svc = quotaWindowsService(db as any);
    const row = await svc.recordUsage(companyId, {
      provider: "anthropic",
      model: "sonnet",
      windowKind: "5h",
      label: "Sonnet 5h",
      limitValue: 100,
      usedValue: 42,
      usedPercent: 42,
    });
    expect(row).toBeTruthy();
    expect(captured.inserts[0]).toMatchObject({
      companyId,
      provider: "anthropic",
      model: "sonnet",
      windowKind: "5h",
      usedValue: 42,
    });
  });
});

describe("quotaWindowsService — contract", () => {
  it("factory exposes all expected methods", () => {
    const { db } = createSequenceDb();
    const svc = quotaWindowsService(db as any);
    const methods = ["list", "getWindow", "refresh", "refreshAll", "recordUsage"];
    for (const m of methods) {
      expect(typeof (svc as any)[m], `missing method: ${m}`).toBe("function");
    }
  });
});
