// server/src/__tests__/c2-inbox-attach-to-thread.test.ts
//
// Originally: Task C2 batch 2 — attach_to_thread tool tests.
// Updated (Task 1.8): tool was rewritten to honor the routing dial and route
// through the shared attachInboxItemToThread service.  These tests now focus on
// the contracts that carry over unchanged from C2 (metadata, INVALID_PARAMS) and
// on confirming the new shared-service integration for the act path.
//
// Full dial-gate coverage lives in inbox-attach-to-thread.test.ts.

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Module-level mocks ─────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ _op: "and", args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
}));

vi.mock("@armyofagents/db", () => ({
  threadInboxItems: new Proxy({} as any, { get: (_t, p) => p }),
  internalAgentConfig: new Proxy({} as any, { get: (_t, p) => p }),
}));

const mockAttachInboxItemToThread = vi.fn();

vi.mock("../services/inbox-attach.js", () => ({
  attachInboxItemToThread: (...args: any[]) => mockAttachInboxItemToThread(...args),
}));

import { attachToThreadTool } from "../services/internal-agent/tools/inbox-attach-to-thread.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb(opts: { dialLevel?: string } = {}) {
  const dialLevel = opts.dialLevel ?? "auto_attach";
  // select index 0: internalAgentConfig (dial)
  // select index 1: threadInboxItems (suggest path)
  const selectQueue: any[][] = [
    [{ level: dialLevel }],
    [{ id: "inbox-1", companyId: "co-1" }],
  ];
  let callIdx = 0;
  const makeChain = (idx: number) => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(selectQueue[idx] ?? []),
  });
  const select = vi.fn(() => makeChain(callIdx++));
  // The act-path race-guard (Codex round-3 P1) issues an escalated-claim
  // UPDATE … .where(…).returning({ id }). where() therefore returns an object
  // that is both awaitable (→ []) and exposes .returning() (→ non-empty, so the
  // guard treats the claim as succeeded and falls through to the act path).
  const update = vi.fn(() => ({
    set: vi.fn().mockReturnThis(),
    where: vi.fn(() => {
      const whereResult: any = Promise.resolve([]);
      whereResult.returning = vi.fn().mockResolvedValue([{ id: "inbox-1" }]);
      return whereResult;
    }),
  }));
  return { db: { select, update } as any };
}

function makeCtx(db: any): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    agentId: "agent-router",
    db,
    services: {} as any,
  } as unknown as ToolContext;
}

beforeEach(() => {
  mockAttachInboxItemToThread.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("attach_to_thread tool (C2 batch 2)", () => {
  it("metadata: name, category=action, requiredRole=team_member, no confirmation", () => {
    expect(attachToThreadTool.name).toBe("attach_to_thread");
    expect(attachToThreadTool.category).toBe("action");
    expect(attachToThreadTool.requiredRole).toBe("team_member");
    expect(attachToThreadTool.requiresConfirmation).toBe(false);
  });

  it("returns INVALID_PARAMS when inboxItemId is missing", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute({ threadId: "thread-9" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(mockAttachInboxItemToThread).not.toHaveBeenCalled();
  });

  it("returns INVALID_PARAMS when threadId is missing", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute({ inboxItemId: "inbox-1" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(mockAttachInboxItemToThread).not.toHaveBeenCalled();
  });

  it("happy path (auto_attach): routes through shared service and returns entryId", async () => {
    mockAttachInboxItemToThread.mockResolvedValue({
      posted: true,
      entryId: "entry-1",
      alreadyHandled: false,
    });
    const { db } = makeDb({ dialLevel: "auto_attach" });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: "inbox-1", threadId: "thread-9" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).entryId).toBe("entry-1");
    expect(mockAttachInboxItemToThread).toHaveBeenCalledOnce();
    // Passes correct actor shape
    const [, args] = mockAttachInboxItemToThread.mock.calls[0];
    expect(args.actor.actorType).toBe("agent");
    expect(args.actor.agentId).toBe("agent-router");
  });

  it("shared service returns alreadyHandled → success with 'already attached' summary", async () => {
    mockAttachInboxItemToThread.mockResolvedValue({
      posted: false,
      entryId: null,
      alreadyHandled: true,
    });
    const { db } = makeDb({ dialLevel: "auto_attach" });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: "inbox-1", threadId: "thread-9" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).alreadyHandled).toBe(true);
    expect(result.summary).toContain("already attached");
  });

  it("shared service throws → TRANSACTION_FAILED with error message", async () => {
    mockAttachInboxItemToThread.mockRejectedValue(new Error("simulated insert failure"));
    const { db } = makeDb({ dialLevel: "auto_attach" });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: "inbox-1", threadId: "thread-9" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("TRANSACTION_FAILED");
    expect(result.summary).toContain("simulated insert failure");
  });

  it("shared service throws COMPANY_MISMATCH → tool surfaces COMPANY_MISMATCH error", async () => {
    mockAttachInboxItemToThread.mockRejectedValue(
      new Error("COMPANY_MISMATCH: item not in this company"),
    );
    const { db } = makeDb({ dialLevel: "auto_attach" });
    const ctx = makeCtx(db);
    const result = await attachToThreadTool.execute(
      { inboxItemId: "inbox-1", threadId: "thread-9" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("COMPANY_MISMATCH");
  });
});
