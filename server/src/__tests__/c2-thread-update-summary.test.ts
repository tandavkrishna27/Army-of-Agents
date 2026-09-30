// server/src/__tests__/c2-thread-update-summary.test.ts
//
// Task C2 batch 1 — thread.updateSummary tool tests.
// Verifies summary persistence, summaryUpdatedAt timestamp advance, embedding
// enqueueing (best-effort), and graceful behavior when the embedding service
// is absent.

import { describe, expect, it, vi } from "vitest";
import { threadUpdateSummaryTool } from "../services/internal-agent/tools/thread-update-summary.js";
import type { ToolContext } from "../services/internal-agent/types.js";

function makeDb(opts: { companyId?: string; threadExists?: boolean; crewPaused?: boolean; companyCrewPaused?: boolean } = {}) {
  const {
    companyId = "co-1",
    threadExists = true,
    crewPaused = false,
    companyCrewPaused = false,
  } = opts;

  // Pre-flight select: the tool checks thread existence + companyId before UPDATE.
  // Chain: .select().from().where().then(cb) — resolves via .then() to a single row or null.
  const selectResults = [
    threadExists ? [{ companyId, crewPaused }] : [],
    [{ crewPaused: companyCrewPaused }],
  ];
  let selectIdx = 0;
  const makeSelectChain = () => {
    const chain: any = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.then = (resolve: any) => Promise.resolve(resolve(selectResults[selectIdx++] ?? []));
    return chain;
  };
  const select = vi.fn(() => makeSelectChain());

  const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
  const update = vi.fn().mockReturnValue({ set: setMock });
  return { db: { select, update } as any, setMock };
}

function makeCtx(db: any, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    db,
    services: {} as any,
    ...overrides,
  } as unknown as ToolContext;
}

describe("thread.updateSummary tool (C2 batch 1)", () => {
  it("metadata: name, category=action, requiredRole=team_member, no confirmation", () => {
    expect(threadUpdateSummaryTool.name).toBe("thread.updateSummary");
    expect(threadUpdateSummaryTool.category).toBe("action");
    expect(threadUpdateSummaryTool.requiredRole).toBe("team_member");
    expect(threadUpdateSummaryTool.requiresConfirmation).toBe(false);
  });

  it("saves summary and stamps summaryUpdatedAt with a current Date", async () => {
    const { db, setMock } = makeDb();
    const before = Date.now();
    const ctx = makeCtx(db);
    const result = await threadUpdateSummaryTool.execute(
      { threadId: "t-1", summary: "Recent progress: shipped login flow." },
      ctx,
    );
    const after = Date.now();
    expect(result.success).toBe(true);

    const setCall = setMock.mock.calls[0][0];
    expect(setCall.summaryText).toBe("Recent progress: shipped login flow.");
    expect(setCall.summaryUpdatedAt).toBeInstanceOf(Date);
    const ts = (setCall.summaryUpdatedAt as Date).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("enqueues summary embedding when embedding service is wired", async () => {
    const { db } = makeDb();
    const enqueue = vi.fn().mockResolvedValue({ id: "queue-1" });
    const ctx = makeCtx(db, {
      services: { embeddings: { enqueue } } as any,
    });

    const result = await threadUpdateSummaryTool.execute(
      { threadId: "t-1", summary: "summary text" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith({
      companyId: "co-1",
      targetTable: "discussions",
      targetId: "t-1",
      targetColumn: "summary_embedding",
      inputText: "summary text",
    });
    expect((result.data as any).embeddingQueued).toBe(true);
  });

  it("does NOT fail when embedding service is missing", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await threadUpdateSummaryTool.execute(
      { threadId: "t-1", summary: "summary text" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).embeddingQueued).toBe(false);
  });

  it("does NOT fail when embedding enqueue throws (best-effort)", async () => {
    const { db } = makeDb();
    const enqueue = vi
      .fn()
      .mockRejectedValue(new Error("queue write failed"));
    const ctx = makeCtx(db, {
      services: { embeddings: { enqueue } } as any,
    });
    const result = await threadUpdateSummaryTool.execute(
      { threadId: "t-1", summary: "summary" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).embeddingQueued).toBe(false);
  });

  it("returns INVALID_PARAMS when threadId is missing", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await threadUpdateSummaryTool.execute(
      { summary: "x" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("returns INVALID_PARAMS when summary is not a string", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await threadUpdateSummaryTool.execute(
      { threadId: "t-1", summary: 42 as any },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  // ── Cross-tenant guards (#7) ─────────────────────────────────────────────────

  it("returns THREAD_NOT_FOUND when the thread does not exist (pre-flight)", async () => {
    const { db } = makeDb({ threadExists: false });
    const ctx = makeCtx(db);
    const result = await threadUpdateSummaryTool.execute(
      { threadId: "ghost-thread", summary: "some summary" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("THREAD_NOT_FOUND");
    // No UPDATE should be issued.
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns COMPANY_MISMATCH when thread belongs to a different company", async () => {
    // Thread row has companyId='company-B', caller's ctx has companyId='co-1'.
    const { db } = makeDb({ companyId: "company-B" });
    const ctx = makeCtx(db);
    const result = await threadUpdateSummaryTool.execute(
      { threadId: "t-cross", summary: "attempted cross-tenant update" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("COMPANY_MISMATCH");
    // No UPDATE should be issued.
    expect(db.update).not.toHaveBeenCalled();
  });

  it("blocks agent summary writes when thread crew is paused", async () => {
    const { db } = makeDb({ crewPaused: true });
    const ctx = makeCtx(db, { agentId: "agent-chronicler-1" });
    const result = await threadUpdateSummaryTool.execute(
      { threadId: "t-paused", summary: "paused summary should not be written" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("THREAD_PAUSED");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("blocks agent summary writes when company crew is paused", async () => {
    const { db } = makeDb({ companyCrewPaused: true });
    const ctx = makeCtx(db, { agentId: "agent-chronicler-1" });
    const result = await threadUpdateSummaryTool.execute(
      { threadId: "t-company-paused", summary: "company pause should block this write" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("COMPANY_PAUSED");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("same-company thread (happy path) still updates + returns summaryUpdatedAt", async () => {
    // Explicit: same companyId as ctx ('co-1') → guard passes, update proceeds.
    const { db, setMock } = makeDb({ companyId: "co-1" });
    const ctx = makeCtx(db);
    const result = await threadUpdateSummaryTool.execute(
      { threadId: "t-1", summary: "same-company update" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).summaryUpdatedAt).toBeDefined();
    const setCall = setMock.mock.calls[0][0];
    expect(setCall.summaryText).toBe("same-company update");
    expect(setCall.summaryUpdatedAt).toBeInstanceOf(Date);
  });
});
