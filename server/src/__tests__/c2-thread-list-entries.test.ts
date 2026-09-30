// server/src/__tests__/c2-thread-list-entries.test.ts
//
// Task C2 batch 1 — thread.listEntries tool tests.
// Verifies cap-at-200, chronological order (reversed from desc query),
// param validation, and empty-result behavior.

import { describe, expect, it, vi } from "vitest";
import { threadListEntriesTool } from "../services/internal-agent/tools/thread-list-entries.js";
import type { ToolContext } from "../services/internal-agent/types.js";

function makeDbReturning(rows: any[]) {
  // The tool issues: db.select().from().where().orderBy().limit() → Promise<rows>
  const chain: any = {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  };
  return { select: vi.fn().mockReturnValue(chain) };
}

function makeCtx(db: any): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: [],
    db,
    services: {} as any,
  } as unknown as ToolContext;
}

describe("thread.listEntries tool (C2 batch 1)", () => {
  it("metadata: name, category=query, requiredRole=team_member, no confirmation", () => {
    expect(threadListEntriesTool.name).toBe("thread.listEntries");
    expect(threadListEntriesTool.category).toBe("query");
    expect(threadListEntriesTool.requiredRole).toBe("team_member");
    expect(threadListEntriesTool.requiresConfirmation).toBe(false);
  });

  it("returns entries (reversed back to chronological order)", async () => {
    // DB returns desc-ordered rows — tool reverses to chronological.
    const dbRows = [
      { id: "e3", createdAt: "2026-01-03" },
      { id: "e2", createdAt: "2026-01-02" },
      { id: "e1", createdAt: "2026-01-01" },
    ];
    const ctx = makeCtx(makeDbReturning(dbRows));
    const result = await threadListEntriesTool.execute(
      { threadId: "t-1" },
      ctx,
    );
    expect(result.success).toBe(true);
    const data = result.data as Array<{ id: string }>;
    expect(data.map((r) => r.id)).toEqual(["e1", "e2", "e3"]);
    expect(result.summary).toContain("3");
  });

  it("returns success=false with INVALID_PARAMS when threadId is missing", async () => {
    const ctx = makeCtx(makeDbReturning([]));
    const result = await threadListEntriesTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("caps the limit at 200 even when caller requests more", async () => {
    // Capture the limit() call to verify the cap.
    const limitMock = vi.fn().mockResolvedValue([]);
    const db: any = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({ limit: limitMock }),
            }),
          }),
        }),
      }),
    };
    const ctx = makeCtx(db);
    await threadListEntriesTool.execute(
      { threadId: "t-1", limit: 1000 },
      ctx,
    );
    expect(limitMock).toHaveBeenCalledWith(200);
  });

  it("uses default limit of 200 when limit param is absent", async () => {
    const limitMock = vi.fn().mockResolvedValue([]);
    const db: any = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({ limit: limitMock }),
            }),
          }),
        }),
      }),
    };
    const ctx = makeCtx(db);
    await threadListEntriesTool.execute({ threadId: "t-1" }, ctx);
    expect(limitMock).toHaveBeenCalledWith(200);
  });

  it("handles empty result set gracefully", async () => {
    const ctx = makeCtx(makeDbReturning([]));
    const result = await threadListEntriesTool.execute(
      { threadId: "t-1" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.summary).toContain("0");
  });
});
