// server/src/__tests__/c2-thread-get-summary.test.ts
//
// Task C2 batch 1 — get_thread_summary tool tests.
// Verifies the read returns summary+intent+phase+participants, and that a
// missing thread returns NOT_FOUND.

import { describe, expect, it, vi } from "vitest";
import { getThreadSummaryTool } from "../services/internal-agent/tools/thread-get-summary.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// The tool issues two queries:
//   1. SELECT ... FROM discussions WHERE id = ? LIMIT 1
//   2. SELECT ... FROM thread_participants WHERE thread_id = ?
// Both return arrays.
function makeDbWithTwoSelects(threadRows: any[], participantRows: any[]) {
  // Each call to .select() returns a new chain. Track call count.
  let selectCallNo = 0;
  return {
    select: vi.fn(() => {
      selectCallNo++;
      const isFirst = selectCallNo === 1;
      if (isFirst) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(threadRows),
            }),
          }),
        };
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(participantRows),
        }),
      };
    }),
  };
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

describe("get_thread_summary tool (C2 batch 1)", () => {
  it("metadata: name, category=query, requiredRole=team_member, no confirmation", () => {
    expect(getThreadSummaryTool.name).toBe("get_thread_summary");
    expect(getThreadSummaryTool.category).toBe("query");
    expect(getThreadSummaryTool.requiredRole).toBe("team_member");
    expect(getThreadSummaryTool.requiresConfirmation).toBe(false);
  });

  it("returns summary + participants for an existing thread", async () => {
    const thread = {
      id: "t-1",
      summaryText: "We discussed the auth refactor.",
      summaryUpdatedAt: new Date("2026-05-20"),
      intent: ["planning", "decision"],
      phase: "scope",
      autonomyLevel: 2,
      visibility: "company",
      ownerUserId: "user-7",
    };
    const participants = [
      { id: "p-1", principalType: "user", principalId: "user-7", role: "owner" },
      { id: "p-2", principalType: "agent", principalId: "agent-1", role: "worker" },
    ];
    const ctx = makeCtx(makeDbWithTwoSelects([thread], participants));
    const result = await getThreadSummaryTool.execute(
      { threadId: "t-1" },
      ctx,
    );
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.summaryText).toBe("We discussed the auth refactor.");
    expect(data.intent).toEqual(["planning", "decision"]);
    expect(data.phase).toBe("scope");
    expect(data.participants).toHaveLength(2);
    expect(result.summary).toContain("scope");
    expect(result.summary).toContain("2");
  });

  it("returns NOT_FOUND when thread does not exist", async () => {
    const ctx = makeCtx(makeDbWithTwoSelects([], []));
    const result = await getThreadSummaryTool.execute(
      { threadId: "missing" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
  });

  it("returns the same NOT_FOUND result for a thread outside the company", async () => {
    const result = await getThreadSummaryTool.execute(
      { threadId: "foreign-thread" }, makeCtx(makeDbWithTwoSelects([], [])),
    );
    expect(result).toMatchObject({ success: false, error: "NOT_FOUND" });
  });

  it("returns INVALID_PARAMS when threadId is missing", async () => {
    const ctx = makeCtx(makeDbWithTwoSelects([], []));
    const result = await getThreadSummaryTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("returns empty participants list when none exist", async () => {
    const thread = {
      id: "t-1",
      summaryText: null,
      summaryUpdatedAt: null,
      intent: [],
      phase: "discuss",
      autonomyLevel: null,
      visibility: "private",
      ownerUserId: null,
    };
    const ctx = makeCtx(makeDbWithTwoSelects([thread], []));
    const result = await getThreadSummaryTool.execute(
      { threadId: "t-1" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).participants).toEqual([]);
    expect(result.summary).toContain("discuss");
    expect(result.summary).toContain("0");
  });
});
