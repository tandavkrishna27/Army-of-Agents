// server/src/__tests__/c2-thread-set-intent.test.ts
//
// Task C2 batch 1 — thread.setIntent tool tests.
// Verifies validation against THREAD_INTENTS, error on invalid values, and
// happy-path persistence.

import { describe, expect, it, vi } from "vitest";
import { threadSetIntentTool } from "../services/internal-agent/tools/thread-set-intent.js";
import type { ToolContext } from "../services/internal-agent/types.js";

function makeDb(updatedRows: any[] = [{ id: "t-1" }]) {
  const returning = vi.fn().mockResolvedValue(updatedRows);
  const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) });
  const update = vi.fn().mockReturnValue({ set: setMock });
  return { db: { update } as any, setMock };
}

function makeCtx(db: any): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    db,
    services: {} as any,
  } as unknown as ToolContext;
}

describe("thread.setIntent tool (C2 batch 1)", () => {
  it("metadata: name, category=action, requiredRole=team_member, no confirmation", () => {
    expect(threadSetIntentTool.name).toBe("thread.setIntent");
    expect(threadSetIntentTool.category).toBe("action");
    expect(threadSetIntentTool.requiredRole).toBe("team_member");
    expect(threadSetIntentTool.requiresConfirmation).toBe(false);
  });

  it("persists valid intents", async () => {
    const { db, setMock } = makeDb();
    const ctx = makeCtx(db);
    const result = await threadSetIntentTool.execute(
      { threadId: "t-1", intent: ["planning", "decision"] },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(setMock).toHaveBeenCalledOnce();
    const setCall = setMock.mock.calls[0][0];
    expect(setCall.intent).toEqual(["planning", "decision"]);
    expect((result.data as any).intent).toEqual(["planning", "decision"]);
  });

  it("rejects invalid intent values with INVALID_INTENT", async () => {
    const { db, setMock } = makeDb();
    const ctx = makeCtx(db);
    const result = await threadSetIntentTool.execute(
      { threadId: "t-1", intent: ["bogus_intent", "research"] },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_INTENT");
    expect(result.summary).toContain("bogus_intent");
    expect(setMock).not.toHaveBeenCalled();
  });

  it("rejects missing threadId with INVALID_PARAMS", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await threadSetIntentTool.execute(
      { intent: ["planning"] },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("rejects non-array intent param with INVALID_PARAMS", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await threadSetIntentTool.execute(
      { threadId: "t-1", intent: "planning" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("accepts empty intent array (clears the intent)", async () => {
    const { db, setMock } = makeDb();
    const ctx = makeCtx(db);
    const result = await threadSetIntentTool.execute(
      { threadId: "t-1", intent: [] },
      ctx,
    );
    expect(result.success).toBe(true);
    const setCall = setMock.mock.calls[0][0];
    expect(setCall.intent).toEqual([]);
  });

  it("fails closed without leaking when the thread is outside the company", async () => {
    const { db, setMock } = makeDb([]);
    const result = await threadSetIntentTool.execute(
      { threadId: "foreign-thread", intent: ["planning"] }, makeCtx(db),
    );
    expect(result).toMatchObject({ success: false, error: "NOT_FOUND" });
    expect(setMock).toHaveBeenCalledOnce();
  });
});
