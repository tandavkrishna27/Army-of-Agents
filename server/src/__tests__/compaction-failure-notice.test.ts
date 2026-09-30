import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * U13.6 — unit coverage for the founder-resolution + notification-creation
 * logic itself (agent-loop.ts / commander-degradation.test.ts only prove
 * agent-loop.ts CALLS this helper on a cloud compaction failure; this file
 * proves the helper's own body — resolving the earliest founder role row and
 * raising exactly one `internal_agent.compaction_failed` notification via the
 * canonical `createNotification` entry point — actually does the right thing,
 * and stays best-effort (never throws) on every failure mode.
 */

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => ({ __and: conditions })),
  eq: vi.fn((col: unknown, val: unknown) => ({ __eq: [col, val] })),
}));

vi.mock("@armyofagents/db", () => ({
  userRoles: { companyId: "companyId", role: "role", userId: "userId", createdAt: "createdAt" },
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const createNotificationMock = vi.fn(async () => ({}) as any);
vi.mock("../services/notifications.js", () => ({
  createNotification: (...a: unknown[]) => createNotificationMock(...a),
}));

import { notifyFounderOfCompactionFailure } from "../services/internal-agent/compaction-failure-notice.js";

function dbWithRoles(rows: Array<{ userId: string; createdAt: Date }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: (fn: (rows: any[]) => any) => Promise.resolve(fn(rows)),
    })),
  } as any;
}

beforeEach(() => {
  createNotificationMock.mockClear();
  createNotificationMock.mockResolvedValue({} as any);
});

describe("notifyFounderOfCompactionFailure", () => {
  it("resolves the earliest-created founder and raises one internal_agent.compaction_failed notification", async () => {
    const db = dbWithRoles([
      { userId: "founder-late", createdAt: new Date("2026-02-01") },
      { userId: "founder-early", createdAt: new Date("2026-01-01") },
    ]);

    await notifyFounderOfCompactionFailure(db, "company-1", new Error("sandbox boom"), "conv-1");

    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const [calledDb, params] = createNotificationMock.mock.calls[0];
    expect(calledDb).toBe(db);
    expect(params).toMatchObject({
      companyId: "company-1",
      userId: "founder-early",
      type: "internal_agent.compaction_failed",
      relatedEntityType: "internal_agent_conversation",
      relatedEntityId: "conv-1",
    });
    expect(params.title).toMatch(/could not compact/i);
    expect(params.message).toContain("sandbox boom");
  });

  it("no founder role row → does not call createNotification, does not throw", async () => {
    const db = dbWithRoles([]);
    await expect(
      notifyFounderOfCompactionFailure(db, "company-1", new Error("x")),
    ).resolves.toBeUndefined();
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("createNotification throwing is swallowed (best-effort, never affects the caller)", async () => {
    const db = dbWithRoles([{ userId: "founder-1", createdAt: new Date() }]);
    createNotificationMock.mockRejectedValueOnce(new Error("hub emit failed"));

    await expect(
      notifyFounderOfCompactionFailure(db, "company-1", new Error("x")),
    ).resolves.toBeUndefined();
  });

  it("non-Error thrown value is stringified into the message, not JSON-dumped", async () => {
    const db = dbWithRoles([{ userId: "founder-1", createdAt: new Date() }]);
    await notifyFounderOfCompactionFailure(db, "company-1", "plain string failure");
    const [, params] = createNotificationMock.mock.calls[0];
    expect(params.message).toContain("plain string failure");
  });
});
