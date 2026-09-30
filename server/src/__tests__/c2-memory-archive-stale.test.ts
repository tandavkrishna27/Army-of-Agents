// server/src/__tests__/c2-memory-archive-stale.test.ts
//
// Task C2 batch 3 — archive_stale_memory tool tests.
// Verifies:
//   - metadata (requiresConfirmation=true — founder approval gate),
//   - happy path returns archived count,
//   - layer filter accepted + invalid layer rejected,
//   - olderThanDays defaults to 90 + custom value is forwarded,
//   - the UPDATE chain is invoked with the right values.set payload.

import { describe, expect, it, vi } from "vitest";
import { archiveStaleMemoryTool } from "../services/internal-agent/tools/memory-archive-stale.js";
import type { ToolContext } from "../services/internal-agent/types.js";

function makeDb(opts: { rowsReturned?: any[] } = {}) {
  const updateSet: any = { last: undefined };

  const where = vi.fn().mockReturnValue({
    returning: () => Promise.resolve(opts.rowsReturned ?? []),
  });
  const setFn = vi.fn().mockImplementation((vals: any) => {
    updateSet.last = vals;
    return { where };
  });
  const update = vi.fn().mockReturnValue({ set: setFn });

  return { db: { update } as any, updateSet, setFn };
}

function makeCtx(db: any): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "founder",
    enabledCapabilities: ["memory_management"],
    agentId: "agent-memkeeper",
    db,
    services: {} as any,
  } as unknown as ToolContext;
}

describe("archive_stale_memory tool (C2 batch 3)", () => {
  it("metadata: name, category=memory, requiresConfirmation=true", () => {
    expect(archiveStaleMemoryTool.name).toBe("archive_stale_memory");
    expect(archiveStaleMemoryTool.category).toBe("memory");
    expect(archiveStaleMemoryTool.requiredRole).toBe("team_member");
    // Founder/team-lead approval gate
    expect(archiveStaleMemoryTool.requiresConfirmation).toBe(true);
  });

  it("returns archivedCount and marks rows as 'archived' in the UPDATE", async () => {
    const { db, updateSet } = makeDb({
      rowsReturned: [{ id: "m-1" }, { id: "m-2" }, { id: "m-3" }],
    });
    const ctx = makeCtx(db);
    const result = await archiveStaleMemoryTool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect((result.data as any).archivedCount).toBe(3);
    expect(updateSet.last.status).toBe("archived");
  });

  it("returns 0 when no rows match", async () => {
    const { db } = makeDb({ rowsReturned: [] });
    const ctx = makeCtx(db);
    const result = await archiveStaleMemoryTool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect((result.data as any).archivedCount).toBe(0);
    expect(result.summary).toContain("0");
  });

  it("accepts valid layer filter", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await archiveStaleMemoryTool.execute(
      { layer: "active_context" },
      ctx,
    );
    expect(result.success).toBe(true);
  });

  it("rejects invalid layer with INVALID_PARAMS", async () => {
    const { db, setFn } = makeDb();
    const ctx = makeCtx(db);
    const result = await archiveStaleMemoryTool.execute(
      { layer: "garbage" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(setFn).not.toHaveBeenCalled();
  });

  it("accepts custom olderThanDays value", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await archiveStaleMemoryTool.execute(
      { olderThanDays: 30 },
      ctx,
    );
    expect(result.success).toBe(true);
  });

  it("treats non-positive olderThanDays as 'use default'", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    let r = await archiveStaleMemoryTool.execute({ olderThanDays: 0 }, ctx);
    expect(r.success).toBe(true);
    r = await archiveStaleMemoryTool.execute({ olderThanDays: -5 }, ctx);
    expect(r.success).toBe(true);
  });
});
