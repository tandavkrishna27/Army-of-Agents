import { describe, expect, it, vi } from "vitest";

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

function createSequenceDb(config: { selects?: MockRow[][] } = {}) {
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

describe("context-assembly: company name injection", () => {
  it("includes company name in the system prompt", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "c1", name: "Acme Corp", vision: "v", mission: "m" }],
        [], // identity memory items (legacy path)
      ],
    });
    const svc = contextAssemblyService(db as any);
    const { systemPrompt } = await svc.assembleContext("c1");
    expect(systemPrompt).toContain("Acme Corp");
  });

  it("omits Name: line when company.name is null", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "c1", name: null, vision: "v", mission: "m" }],
        [], // identity memory items (legacy path)
      ],
    });
    const svc = contextAssemblyService(db as any);
    const { systemPrompt } = await svc.assembleContext("c1");
    expect(systemPrompt).not.toContain("Name:");
  });

  it("includes name before vision in Company Identity section", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "c1", name: "Acme", vision: "Win the world", mission: "m" }],
        [], // identity memory items (legacy path)
      ],
    });
    const svc = contextAssemblyService(db as any);
    const { systemPrompt } = await svc.assembleContext("c1");
    const nameIdx = systemPrompt.indexOf("Name: Acme");
    const visionIdx = systemPrompt.indexOf("Vision: Win the world");
    expect(nameIdx).toBeGreaterThan(-1);
    expect(nameIdx).toBeLessThan(visionIdx);
  });
});
