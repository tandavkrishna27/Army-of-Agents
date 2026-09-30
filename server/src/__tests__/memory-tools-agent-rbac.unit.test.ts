// server/src/__tests__/memory-tools-agent-rbac.unit.test.ts
//
// U2a — local wiring proof (no DB required, runs everywhere incl. Windows).
//
// Proves the RBAC gate added to the three unscoped memory-search tools
// (find_similar_memory, detect_conflicts in memory-tools.ts; the raw
// find_similar_memory_hnsw query in memory-find-similar.ts) is actually WIRED:
//   - when ctx.actorType === "agent" (+ ctx.agentId set), the tool resolves the
//     actor via actorForAgentRun and threads memoryAccessConditions' return
//     value into the underlying fetch (searchMultiPath / findSimilarItems
//     filters, or the hnsw tool's in-SQL `conditions` array);
//   - for any other actorType (board/Commander/founder), memoryAccessConditions
//     is never invoked and the fetch call is byte-identical to the pre-U2a
//     behavior (no accessConditions key at all).
//
// This is a pure wiring test: `actorForAgentRun` / `memoryAccessConditions`
// are mocked (their own correctness — which rows a given actor may see — is
// covered by memory-access.test.ts / memory-access-conditions.test.ts and the
// real-Postgres row-level proof in memory-tools-agent-rbac.integration.test.ts,
// which SKIPS on Windows). This file must actually pass locally.
import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { ToolContext } from "../services/internal-agent/types.js";

const AGENT_ACTOR = { kind: "agent" as const, agentId: "agent-D2", departmentIds: ["dept-D2"] };

// `vi.mock` factories are hoisted above regular top-level statements, so the
// mock fns must be created via `vi.hoisted` to be visible inside the factory.
// The real return values (which reference `AGENT_ACTOR` / the real drizzle-orm
// `sql` tag) are wired in below via `.mockImplementation` once normal
// (non-hoisted) top-level code runs and the imports are available.
const { actorForAgentRunMock, memoryAccessConditionsMock } = vi.hoisted(() => ({
  actorForAgentRunMock: vi.fn(),
  memoryAccessConditionsMock: vi.fn(),
}));

vi.mock("../services/memory-access-sql.js", () => ({
  actorForAgentRun: actorForAgentRunMock,
  memoryAccessConditions: memoryAccessConditionsMock,
}));

import { createMemoryTools } from "../services/internal-agent/tools/memory-tools.js";
import { findSimilarMemoryHnswTool } from "../services/internal-agent/tools/memory-find-similar.js";

// A real, standalone SQL fragment (drizzle's `sql` tagged template needs no
// table/schema/DB — it's just an AST node) used as the sentinel "gate"
// condition. Using a REAL SQL-shaped object (not a plain string/object) matters
// for the hnsw tool: its code path spreads this into a `conditions` array that
// flows through the real drizzle-orm `and(...)`, which requires genuine
// SQLWrapper elements — a plain string would throw inside `and()`.
const SENTINEL_GATE_CONDITION = sql`__U2A_AGENT_GATE_SENTINEL__ = 1`;

actorForAgentRunMock.mockImplementation(async () => AGENT_ACTOR);
memoryAccessConditionsMock.mockImplementation(() => [SENTINEL_GATE_CONDITION]);

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    companyId: "co-1",
    userId: "user-1",
    userRole: "team_member",
    enabledCapabilities: [],
    db: { __marker: "fake-db" },
    services: {} as ToolContext["services"],
    ...overrides,
  } as unknown as ToolContext;
}

function makeDbReturning(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown, whereMock: where };
}

describe("U2a — find_similar_memory RBAC gate wiring", () => {
  const tool = createMemoryTools().find((t) => t.name === "find_similar_memory")!;

  it("threads accessConditions into searchMultiPath for the agent actor", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const searchMultiPath = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: "agent",
      agentId: "agent-D2",
      services: { memory: { searchMultiPath } } as unknown as ToolContext["services"],
    });

    const result = await tool.execute({ query: "shared secret plan" }, ctx);

    expect(result.success).toBe(true);
    expect(actorForAgentRunMock).toHaveBeenCalledWith(ctx.db, "co-1", "agent-D2");
    expect(memoryAccessConditionsMock).toHaveBeenCalledWith(ctx.db, AGENT_ACTOR);
    expect(searchMultiPath).toHaveBeenCalledTimes(1);
    const filters = searchMultiPath.mock.calls[0]![2] as Record<string, unknown>;
    expect(filters.accessConditions).toEqual([SENTINEL_GATE_CONDITION]);
  });

  it("does NOT gate the board actor — no accessConditions key, byte-unchanged call shape", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const searchMultiPath = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: "board",
      services: { memory: { searchMultiPath } } as unknown as ToolContext["services"],
    });

    const result = await tool.execute({ query: "shared secret plan" }, ctx);

    expect(result.success).toBe(true);
    expect(actorForAgentRunMock).not.toHaveBeenCalled();
    expect(memoryAccessConditionsMock).not.toHaveBeenCalled();
    expect(searchMultiPath).toHaveBeenCalledTimes(1);
    const filters = searchMultiPath.mock.calls[0]![2] as Record<string, unknown>;
    expect(filters).not.toHaveProperty("accessConditions");
  });

  it("does NOT gate a commander/undefined actorType either (only 'agent' triggers the gate)", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const searchMultiPath = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: undefined,
      services: { memory: { searchMultiPath } } as unknown as ToolContext["services"],
    });

    await tool.execute({ query: "shared secret plan" }, ctx);

    expect(memoryAccessConditionsMock).not.toHaveBeenCalled();
    const filters = searchMultiPath.mock.calls[0]![2] as Record<string, unknown>;
    expect(filters).not.toHaveProperty("accessConditions");
  });

  it("agent actorType WITHOUT ctx.agentId does not gate (mirrors the source's `&& ctx.agentId` guard)", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const searchMultiPath = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: "agent",
      agentId: undefined,
      services: { memory: { searchMultiPath } } as unknown as ToolContext["services"],
    });

    await tool.execute({ query: "shared secret plan" }, ctx);

    expect(actorForAgentRunMock).not.toHaveBeenCalled();
    const filters = searchMultiPath.mock.calls[0]![2] as Record<string, unknown>;
    expect(filters).not.toHaveProperty("accessConditions");
  });
});

// Wave 1 review, FIX B: U2a switched find_similar_memory from searchSemantic
// to searchMultiPath. searchMultiPath's TEMPORAL pathway (memory.ts
// runTemporal) has no query-text predicate — with enableTemporal left at its
// default (true), find_similar_memory would return up to `limit`
// recent/most-validated approved rows regardless of whether they match the
// query, for EVERY actor (this is independent of the agent-only RBAC gate
// proven above). These tests prove the tool now passes `enableTemporal:
// false` into every searchMultiPath call, disabling that pathway while
// leaving the query-gated semantic + keyword pathways (and the RBAC gate)
// intact.
describe("Wave 1 review, FIX B — find_similar_memory drops the query-independent temporal pathway", () => {
  const tool = createMemoryTools().find((t) => t.name === "find_similar_memory")!;

  it("passes enableTemporal:false for the agent actor (alongside the RBAC accessConditions gate)", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const searchMultiPath = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: "agent",
      agentId: "agent-D2",
      services: { memory: { searchMultiPath } } as unknown as ToolContext["services"],
    });

    await tool.execute({ query: "a query that matches nothing" }, ctx);

    const filters = searchMultiPath.mock.calls[0]![2] as Record<string, unknown>;
    expect(filters.enableTemporal).toBe(false);
    // The RBAC gate must still be intact alongside the temporal fix.
    expect(filters.accessConditions).toEqual([SENTINEL_GATE_CONDITION]);
  });

  it("passes enableTemporal:false for the board actor too (not scoped to the agent-only RBAC gate)", async () => {
    const searchMultiPath = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: "board",
      services: { memory: { searchMultiPath } } as unknown as ToolContext["services"],
    });

    await tool.execute({ query: "a query that matches nothing" }, ctx);

    const filters = searchMultiPath.mock.calls[0]![2] as Record<string, unknown>;
    expect(filters.enableTemporal).toBe(false);
    expect(filters).not.toHaveProperty("accessConditions");
  });

  it("a non-matching query returns [] when the underlying searchMultiPath honors enableTemporal:false (no unrelated temporal rows)", async () => {
    // Simulates the real memory.ts behavior: with enableTemporal:false and a
    // query that matches nothing in the semantic/keyword pathways, the merged
    // result is empty — this is the "[] when nothing matches" contract FIX B
    // restores. (memory.ts's own pathway logic is covered elsewhere; this
    // asserts the tool surfaces that empty result correctly end-to-end.)
    const searchMultiPath = vi.fn(async (_companyId: string, _query: string, filters: Record<string, unknown>) =>
      filters.enableTemporal === false ? [] : [{ id: "unrelated-recent-item", title: "Unrelated" }],
    );
    const ctx = baseCtx({
      actorType: "board",
      services: { memory: { searchMultiPath } } as unknown as ToolContext["services"],
    });

    const result = await tool.execute({ query: "a query that matches nothing" }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });
});

describe("U2a — detect_conflicts RBAC gate wiring", () => {
  const tool = createMemoryTools().find((t) => t.name === "detect_conflicts")!;

  it("threads accessConditions into findSimilarItems for the agent actor (in-SQL only, no post-filter)", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const findSimilarItems = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: "agent",
      agentId: "agent-D2",
      services: { memory: { findSimilarItems } } as unknown as ToolContext["services"],
    });

    const result = await tool.execute(
      { proposedTitle: "t", proposedContent: "shared secret plan" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(actorForAgentRunMock).toHaveBeenCalledWith(ctx.db, "co-1", "agent-D2");
    expect(memoryAccessConditionsMock).toHaveBeenCalledWith(ctx.db, AGENT_ACTOR);
    expect(findSimilarItems).toHaveBeenCalledTimes(1);
    const [content, scope] = findSimilarItems.mock.calls[0]! as [string, Record<string, unknown>];
    expect(content).toBe("shared secret plan");
    expect(scope.accessConditions).toEqual([SENTINEL_GATE_CONDITION]);
  });

  it("does NOT gate the board actor — findSimilarItems scope has no accessConditions key", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const findSimilarItems = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: "board",
      services: { memory: { findSimilarItems } } as unknown as ToolContext["services"],
    });

    await tool.execute({ proposedTitle: "t", proposedContent: "shared secret plan" }, ctx);

    expect(memoryAccessConditionsMock).not.toHaveBeenCalled();
    const [, scope] = findSimilarItems.mock.calls[0]! as [string, Record<string, unknown>];
    expect(scope).not.toHaveProperty("accessConditions");
    expect(scope).toEqual({ companyId: "co-1" });
  });
});

describe("U2a — find_similar_memory_hnsw RBAC gate wiring", () => {
  it("agent actor: pushes memoryAccessConditions' result into the in-SQL conditions and still queries successfully", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const { db, whereMock } = makeDbReturning([]);
    const embedSync = vi.fn().mockResolvedValue(new Array(1536).fill(0.001));
    const ctx = baseCtx({
      actorType: "agent",
      agentId: "agent-D2",
      db: db as ToolContext["db"],
      services: { embeddings: { embedSync } } as unknown as ToolContext["services"],
    });

    const result = await findSimilarMemoryHnswTool.execute({ text: "shared secret plan" }, ctx);

    expect(result.success).toBe(true);
    expect(actorForAgentRunMock).toHaveBeenCalledWith(ctx.db, "co-1", "agent-D2");
    expect(memoryAccessConditionsMock).toHaveBeenCalledWith(ctx.db, AGENT_ACTOR);
    // The real drizzle-orm `and(...conditions)` must have accepted the sentinel
    // condition without throwing (it's a genuine SQL-shaped object) and the
    // query still reached `.where(...)` — proving the gate composes cleanly
    // with the tool's existing governance conditions rather than crashing them.
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it("board actor: memoryAccessConditions is never called, query still succeeds (byte-unchanged path)", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const { db, whereMock } = makeDbReturning([]);
    const embedSync = vi.fn().mockResolvedValue(new Array(1536).fill(0.001));
    const ctx = baseCtx({
      actorType: "board",
      db: db as ToolContext["db"],
      services: { embeddings: { embedSync } } as unknown as ToolContext["services"],
    });

    const result = await findSimilarMemoryHnswTool.execute({ text: "shared secret plan" }, ctx);

    expect(result.success).toBe(true);
    expect(actorForAgentRunMock).not.toHaveBeenCalled();
    expect(memoryAccessConditionsMock).not.toHaveBeenCalled();
    expect(whereMock).toHaveBeenCalledTimes(1);
  });
});

// DAT-007 — query_memory is the broker memory tool U2a MISSED. Its in-memory
// `filterQueryResults`/`splitCommanderMemoryItems` short-circuits on
// `isFounder(userRole)` (memory-policy.ts), and the crew broker sets
// `userRole:"founder"` (broker-tool-context.ts CREW_SESSION_USER_ROLE) — so a
// crew agent over the broker would otherwise see every approved company memory,
// including others' private / invalidated / cross-department rows, violating the
// #118/#119 acceptance. These prove query_memory now threads the SAME in-SQL
// enterprise gate (actorForAgentRun + memoryAccessConditions) as
// find_similar_memory / detect_conflicts, for the agent actor ONLY — with
// board/Commander/founder-human calls byte-unchanged (no accessConditions key).
describe("DAT-007 — query_memory RBAC gate wiring (the U2a-missed tool)", () => {
  const tool = createMemoryTools().find((t) => t.name === "query_memory")!;

  it("threads accessConditions into searchMultiPath for the agent actor (query path), even with the crew founder-session role", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const searchMultiPath = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: "agent",
      agentId: "agent-D2",
      // The exact bypass vector: broker-tool-context sets CREW_SESSION_USER_ROLE="founder".
      userRole: "founder",
      services: { memory: { searchMultiPath } } as unknown as ToolContext["services"],
    });

    const result = await tool.execute({ query: "shared secret plan" }, ctx);

    expect(result.success).toBe(true);
    expect(actorForAgentRunMock).toHaveBeenCalledWith(ctx.db, "co-1", "agent-D2");
    expect(memoryAccessConditionsMock).toHaveBeenCalledWith(ctx.db, AGENT_ACTOR);
    expect(searchMultiPath).toHaveBeenCalledTimes(1);
    const filters = searchMultiPath.mock.calls[0]![2] as Record<string, unknown>;
    expect(filters.accessConditions).toEqual([SENTINEL_GATE_CONDITION]);
  });

  it("threads accessConditions into list for the agent actor (no-query list path)", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const list = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: "agent",
      agentId: "agent-D2",
      userRole: "founder",
      services: { memory: { list } } as unknown as ToolContext["services"],
    });

    const result = await tool.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(actorForAgentRunMock).toHaveBeenCalledWith(ctx.db, "co-1", "agent-D2");
    expect(memoryAccessConditionsMock).toHaveBeenCalledWith(ctx.db, AGENT_ACTOR);
    expect(list).toHaveBeenCalledTimes(1);
    const filters = list.mock.calls[0]![1] as Record<string, unknown>;
    expect(filters.accessConditions).toEqual([SENTINEL_GATE_CONDITION]);
  });

  it("does NOT gate the board actor — searchMultiPath call shape byte-unchanged (no accessConditions key)", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const searchMultiPath = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: "board",
      services: { memory: { searchMultiPath } } as unknown as ToolContext["services"],
    });

    const result = await tool.execute({ query: "shared secret plan" }, ctx);

    expect(result.success).toBe(true);
    expect(actorForAgentRunMock).not.toHaveBeenCalled();
    expect(memoryAccessConditionsMock).not.toHaveBeenCalled();
    const filters = searchMultiPath.mock.calls[0]![2] as Record<string, unknown>;
    expect(filters).not.toHaveProperty("accessConditions");
  });

  it("does NOT gate the board actor on the list path either (byte-unchanged)", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const list = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: "board",
      services: { memory: { list } } as unknown as ToolContext["services"],
    });

    await tool.execute({}, ctx);

    expect(memoryAccessConditionsMock).not.toHaveBeenCalled();
    const filters = list.mock.calls[0]![1] as Record<string, unknown>;
    expect(filters).not.toHaveProperty("accessConditions");
  });

  it("agent actorType WITHOUT ctx.agentId does not gate (mirrors the source's `&& ctx.agentId` guard)", async () => {
    actorForAgentRunMock.mockClear();
    memoryAccessConditionsMock.mockClear();
    const searchMultiPath = vi.fn(async () => []);
    const ctx = baseCtx({
      actorType: "agent",
      agentId: undefined,
      services: { memory: { searchMultiPath } } as unknown as ToolContext["services"],
    });

    await tool.execute({ query: "shared secret plan" }, ctx);

    expect(actorForAgentRunMock).not.toHaveBeenCalled();
    const filters = searchMultiPath.mock.calls[0]![2] as Record<string, unknown>;
    expect(filters).not.toHaveProperty("accessConditions");
  });
});
