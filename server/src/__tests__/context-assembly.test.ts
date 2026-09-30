import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  sql: Object.assign(
    vi.fn((strings: unknown, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: vi.fn((s: unknown) => s) },
  ),
}));

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
    companies: makeTable("companies"),
    memoryItems: makeTable("memory_items"),
    projects: makeTable("projects"),
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { contextAssemblyService } from "../services/internal-agent/context-assembly.js";

// ── Helpers ────────────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  const selects = config.selects ?? [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: () => makeChain(() => selects[selectIdx++] ?? []),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("contextAssemblyService", () => {
  it("assembles company identity from companies table + identity memory items", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "co-1", name: "Acme", vision: "Be the best", mission: "Ship fast" }],
        [{ title: "Core Value", content: "We value speed" }],
      ],
    });

    const svc = contextAssemblyService(db as any);
    const result = await svc.assembleContext("co-1", {});

    expect(result.systemPrompt).toContain("Be the best");
    expect(result.systemPrompt).toContain("Ship fast");
    expect(result.systemPrompt).toContain("We value speed");
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("includes department context when departmentContext is set", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "co-1", name: "Acme", vision: null, mission: null }],
        [],
        [{ id: "dept-1", name: "Engineering", description: "Build stuff" }],
        [{ title: "Eng Practice", content: "We use TDD" }],
      ],
    });

    const svc = contextAssemblyService(db as any);
    const result = await svc.assembleContext("co-1", { departmentContext: "dept-1" });

    expect(result.systemPrompt).toContain("Engineering");
    expect(result.systemPrompt).toContain("We use TDD");
  });

  it("truncates lower-priority sections when budget exceeded", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "co-1", name: "Acme", vision: "V".repeat(2000), mission: "M".repeat(2000) }],
        [{ title: "T", content: "C".repeat(2000) }],
      ],
    });

    const svc = contextAssemblyService(db as any);
    const result = await svc.assembleContext("co-1", {
      contextTokenBudget: 1000,
      pageContext: "User is on Tasks page",
      conversationSummary: "Long summary " + "x".repeat(5000),
    });

    expect(result.estimatedTokens).toBeLessThanOrEqual(1000);
  });

  it("token estimation uses ceil(length/4)", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "co-1", name: "A", vision: null, mission: null }],
        [],
      ],
    });

    const svc = contextAssemblyService(db as any);
    const result = await svc.assembleContext("co-1", {});

    expect(result.estimatedTokens).toBe(Math.ceil(result.systemPrompt.length / 4));
  });

  it("handles null/missing vision and mission gracefully", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "co-1", name: "Acme", vision: null, mission: null }],
        [],
      ],
    });

    const svc = contextAssemblyService(db as any);
    const result = await svc.assembleContext("co-1", {});

    expect(result.systemPrompt.length).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });
});
