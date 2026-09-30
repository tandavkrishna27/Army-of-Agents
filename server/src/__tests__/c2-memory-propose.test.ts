// server/src/__tests__/c2-memory-propose.test.ts
//
// Task C2 batch 3 — propose_memory_from_thread tool tests.
// Verifies:
//   - happy path with status='pending' insert + best-effort embedding enqueue,
//   - missing/invalid params → INVALID_PARAMS,
//   - missing source thread → THREAD_NOT_FOUND,
//   - allowMemoryExtraction=false → MEMORY_EXTRACTION_DISABLED,
//   - private thread + layer outside {working,active_context} → VISIBILITY_VIOLATION,
//   - enqueue failure is swallowed (proposal still returns success).
//
// W3 update: memory-propose now routes enqueue through enqueueMemoryEmbedding
// (memory-write.ts) instead of ctx.services.embeddings.enqueue. We mock the
// module so tests control the helper without needing a fully wired db/caps stub.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the shared memory-write module so enqueueMemoryEmbedding is a spy.
// `vi.hoisted` ensures the mock fn is created before vi.mock is hoisted.
const { mockEnqueueMemoryEmbedding } = vi.hoisted(() => ({
  mockEnqueueMemoryEmbedding: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/memory-write.js", () => ({
  enqueueMemoryEmbedding: mockEnqueueMemoryEmbedding,
  writeMemoryAndIndex: vi.fn(),
}));

import { proposeMemoryFromThreadTool } from "../services/internal-agent/tools/memory-propose.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// Mock the db so that:
//   db.select().from(discussions).where(...).limit(1) → opts.threadRow
//   db.insert(memoryItems).values(...).returning(...) → [{ id: opts.memoryId }]
function makeDb(opts: {
  threadRow?: any | null;
  memoryId?: string;
  insertThrows?: Error;
} = {}) {
  const insertValues: any = { last: undefined };

  const limit = vi.fn().mockResolvedValue(opts.threadRow ? [opts.threadRow] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const insert = vi.fn((_table: any) => {
    const chain: any = {};
    chain.values = (vals: any) => {
      insertValues.last = vals;
      return chain;
    };
    chain.returning = () => {
      if (opts.insertThrows) {
        return Promise.reject(opts.insertThrows);
      }
      return Promise.resolve([{ id: opts.memoryId ?? "mem-new" }]);
    };
    return chain;
  });

  return { db: { select, insert } as any, insertValues };
}

function makeCtx(
  db: any,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: ["memory_management"],
    agentId: "agent-memkeeper",
    db,
    services: {} as any,
    ...overrides,
  } as unknown as ToolContext;
}

describe("propose_memory_from_thread tool (C2 batch 3)", () => {
  beforeEach(() => {
    mockEnqueueMemoryEmbedding.mockReset();
    mockEnqueueMemoryEmbedding.mockResolvedValue(undefined);
  });

  it("metadata: name, category=memory, requiredRole=team_member, no confirmation", () => {
    expect(proposeMemoryFromThreadTool.name).toBe("propose_memory_from_thread");
    expect(proposeMemoryFromThreadTool.category).toBe("memory");
    expect(proposeMemoryFromThreadTool.requiredRole).toBe("team_member");
    expect(proposeMemoryFromThreadTool.requiresConfirmation).toBe(false);
  });

  it("returns INVALID_PARAMS for missing content / layer / sourceThreadId", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    let r = await proposeMemoryFromThreadTool.execute({}, ctx);
    expect(r.error).toBe("INVALID_PARAMS");
    r = await proposeMemoryFromThreadTool.execute({ content: "x" }, ctx);
    expect(r.error).toBe("INVALID_PARAMS");
    r = await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "domain" },
      ctx,
    );
    expect(r.error).toBe("INVALID_PARAMS");
    r = await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "bogus", sourceThreadId: "th-1" },
      ctx,
    );
    expect(r.error).toBe("INVALID_PARAMS");
  });

  it("returns THREAD_NOT_FOUND when source thread is missing", async () => {
    const { db } = makeDb({ threadRow: null });
    const ctx = makeCtx(db);
    const result = await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "working", sourceThreadId: "th-missing" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("THREAD_NOT_FOUND");
  });

  it("returns MEMORY_EXTRACTION_DISABLED when thread.allowMemoryExtraction=false", async () => {
    const { db } = makeDb({
      threadRow: {
        id: "th-1",
        visibility: "company",
        allowMemoryExtraction: false,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
    });
    const ctx = makeCtx(db);
    const result = await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "working", sourceThreadId: "th-1" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("MEMORY_EXTRACTION_DISABLED");
  });

  it("returns VISIBILITY_VIOLATION on private thread + non-private-safe layer", async () => {
    const { db } = makeDb({
      threadRow: {
        id: "th-1",
        visibility: "private",
        allowMemoryExtraction: true,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
    });
    const ctx = makeCtx(db);
    let r = await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "identity", sourceThreadId: "th-1" },
      ctx,
    );
    expect(r.error).toBe("VISIBILITY_VIOLATION");

    r = await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "domain", sourceThreadId: "th-1" },
      ctx,
    );
    expect(r.error).toBe("VISIBILITY_VIOLATION");
  });

  it("allows working + active_context on private threads", async () => {
    const { db, insertValues } = makeDb({
      threadRow: {
        id: "th-1",
        visibility: "private",
        allowMemoryExtraction: true,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
      memoryId: "mem-1",
    });
    const ctx = makeCtx(db);
    const result = await proposeMemoryFromThreadTool.execute(
      { content: "session note", layer: "working", sourceThreadId: "th-1" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).memoryItemId).toBe("mem-1");
    expect(insertValues.last).toMatchObject({
      companyId: "co-1",
      content: "session note",
      layer: "working",
      status: "pending",
      source: "agent",
      sourceContext: "thread:th-1",
      createdBy: "agent-memkeeper",
    });
  });

  it("inherits department scope from thread.scopeType=department", async () => {
    const { db, insertValues } = makeDb({
      threadRow: {
        id: "th-1",
        visibility: "company",
        allowMemoryExtraction: true,
        scopeType: "department",
        scopeId: "dept-eng",
        goalId: null,
      },
    });
    const ctx = makeCtx(db);
    await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "domain", sourceThreadId: "th-1" },
      ctx,
    );
    expect(insertValues.last.departmentId).toBe("dept-eng");
    expect(insertValues.last.projectId).toBeUndefined();
  });

  it("inherits project scope from thread.scopeType=project", async () => {
    const { db, insertValues } = makeDb({
      threadRow: {
        id: "th-1",
        visibility: "company",
        allowMemoryExtraction: true,
        scopeType: "project",
        scopeId: "proj-1",
        goalId: null,
      },
    });
    const ctx = makeCtx(db);
    await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "domain", sourceThreadId: "th-1" },
      ctx,
    );
    expect(insertValues.last.projectId).toBe("proj-1");
  });

  it("inherits goal scope from thread.goalId (goal-as-property)", async () => {
    const { db, insertValues } = makeDb({
      threadRow: {
        id: "th-1",
        visibility: "company",
        allowMemoryExtraction: true,
        scopeType: null,
        scopeId: null,
        goalId: "goal-q3",
      },
    });
    const ctx = makeCtx(db);
    await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "active_context", sourceThreadId: "th-1" },
      ctx,
    );
    expect(insertValues.last.goalId).toBe("goal-q3");
  });

  it("best-effort embedding enqueue — proposal still succeeds when enqueueMemoryEmbedding throws", async () => {
    mockEnqueueMemoryEmbedding.mockRejectedValueOnce(new Error("queue offline"));
    const { db } = makeDb({
      threadRow: {
        id: "th-1",
        visibility: "company",
        allowMemoryExtraction: true,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
      memoryId: "mem-1",
    });
    const ctx = makeCtx(db);
    const result = await proposeMemoryFromThreadTool.execute(
      { content: "y", layer: "domain", sourceThreadId: "th-1" },
      ctx,
    );
    // enqueueMemoryEmbedding is best-effort inside memory-write.ts — it catches
    // its own errors. But even if it re-threw, the propose tool would still need
    // to succeed. Either way the proposal must complete successfully.
    expect(result.success).toBe(true);
    expect((result.data as any).memoryItemId).toBe("mem-1");
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalled();
  });

  it("calls enqueueMemoryEmbedding with companyId + item id on successful proposal", async () => {
    mockEnqueueMemoryEmbedding.mockResolvedValue(undefined);
    const { db } = makeDb({
      threadRow: {
        id: "th-1",
        visibility: "company",
        allowMemoryExtraction: true,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
      memoryId: "mem-42",
    });
    const ctx = makeCtx(db);
    await proposeMemoryFromThreadTool.execute(
      { content: "indexed content", layer: "domain", sourceThreadId: "th-1" },
      ctx,
    );
    // The shared helper is called with (db, companyId, {id, title?, content?}).
    // The third arg must have at least the item id and the text fields.
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledWith(
      db,
      "co-1",
      expect.objectContaining({
        id: "mem-42",
        content: "indexed content",
      }),
    );
  });

  it("uses default 'context' category when type is omitted", async () => {
    const { db, insertValues } = makeDb({
      threadRow: {
        id: "th-1",
        visibility: "company",
        allowMemoryExtraction: true,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
    });
    const ctx = makeCtx(db);
    await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "domain", sourceThreadId: "th-1" },
      ctx,
    );
    expect(insertValues.last.category).toBe("context");
  });

  it("accepts valid type and uses it as category", async () => {
    const { db, insertValues } = makeDb({
      threadRow: {
        id: "th-1",
        visibility: "company",
        allowMemoryExtraction: true,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
    });
    const ctx = makeCtx(db);
    await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "domain", sourceThreadId: "th-1", type: "decision" },
      ctx,
    );
    expect(insertValues.last.category).toBe("decision");
  });

  it("rejects invalid type by falling back to 'context'", async () => {
    const { db, insertValues } = makeDb({
      threadRow: {
        id: "th-1",
        visibility: "company",
        allowMemoryExtraction: true,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
    });
    const ctx = makeCtx(db);
    await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "domain", sourceThreadId: "th-1", type: "random_bogus" },
      ctx,
    );
    expect(insertValues.last.category).toBe("context");
  });

  // ── Review fix (b): the action-gated path must enforce the SAME per-thread
  //    privacy gates the non-gated path runs. A founder who disabled extraction
  //    (or a private thread) must not be bypassed merely because the controller
  //    routes through the freshness-checked action queue. ──────────────────────
  describe("controller_action_gate privacy gates (review fix (b))", () => {
    it("rejects (does NOT queue) when allowMemoryExtraction=false in gated mode", async () => {
      const proposeThreadAction = vi.fn().mockResolvedValue({ id: "action-1" });
      vi.doMock("../services/thread-agent-actions.js", () => ({
        threadAgentActionService: vi.fn(() => ({ proposeThreadAction })),
      }));
      const { proposeMemoryFromThreadTool: gatedTool } = await import(
        "../services/internal-agent/tools/memory-propose.js"
      );

      const { db } = makeDb({
        threadRow: {
          id: "th-1",
          visibility: "company",
          allowMemoryExtraction: false,
        },
      });
      const ctx = makeCtx(db, {
        runId: "run-1",
        discussionRunMode: "controller_action_gate",
      } as any);

      const result = await gatedTool.execute(
        { content: "x", layer: "working", sourceThreadId: "th-1" },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("MEMORY_EXTRACTION_DISABLED");
      expect(proposeThreadAction).not.toHaveBeenCalled();
      vi.doUnmock("../services/thread-agent-actions.js");
    });

    it("rejects (does NOT queue) a private thread seeding identity layer in gated mode", async () => {
      const proposeThreadAction = vi.fn().mockResolvedValue({ id: "action-1" });
      vi.doMock("../services/thread-agent-actions.js", () => ({
        threadAgentActionService: vi.fn(() => ({ proposeThreadAction })),
      }));
      const { proposeMemoryFromThreadTool: gatedTool } = await import(
        "../services/internal-agent/tools/memory-propose.js"
      );

      const { db } = makeDb({
        threadRow: {
          id: "th-1",
          visibility: "private",
          allowMemoryExtraction: true,
        },
      });
      const ctx = makeCtx(db, {
        runId: "run-1",
        discussionRunMode: "controller_action_gate",
      } as any);

      const result = await gatedTool.execute(
        { content: "x", layer: "identity", sourceThreadId: "th-1" },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("VISIBILITY_VIOLATION");
      expect(proposeThreadAction).not.toHaveBeenCalled();
      vi.doUnmock("../services/thread-agent-actions.js");
    });
  });
});
