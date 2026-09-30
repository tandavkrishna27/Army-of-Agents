import { describe, expect, it, vi, beforeEach } from "vitest";
import { createNotifyOwnerTool } from "../services/internal-agent/tools/notify-owner-tool.js";
import type { ToolContext } from "../services/internal-agent/types.js";

const { publishLiveEventMock, emitMock } = vi.hoisted(() => ({
  publishLiveEventMock: vi.fn(),
  emitMock: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: publishLiveEventMock,
}));

// notify_owner now routes through hubItems.emit (W1a Task 10). Mock the service
// so we can assert the emit shape (semanticType/sourceType/sourceId/owner).
vi.mock("../services/hub-items.js", () => ({
  hubItemsService: vi.fn(() => ({ emit: emitMock })),
}));

describe("notify_owner tool (P2.4)", () => {
  beforeEach(() => {
    publishLiveEventMock.mockClear();
    emitMock.mockReset();
  });

  function makeMockDb(rows: Array<{ ownerUserId: string | null }>) {
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      }),
    };
  }

  function makeCtx(
    dbRows: Array<{ ownerUserId: string | null }>,
    notifResult?: any,
  ): ToolContext {
    // The hub emit resolves to the inserted row (carries `.id`, used for the
    // returned notificationId + the LiveEvent payload).
    emitMock.mockResolvedValue(notifResult ?? { id: "notif-1" });
    return {
      companyId: "co-1",
      userId: "u-1",
      userRole: "team_member",
      enabledCapabilities: [],
      db: makeMockDb(dbRows) as any,
      services: {
        notifications: {
          create: vi.fn().mockResolvedValue(notifResult ?? { id: "notif-1" }),
        },
      } as any,
    } as unknown as ToolContext;
  }

  it("category/meta: name, category, requiresConfirmation, requiredRole", () => {
    const tool = createNotifyOwnerTool();
    expect(tool.name).toBe("notify_owner");
    expect(tool.category).toBe("coordination");
    expect(tool.requiresConfirmation).toBe(false);
    expect(tool.requiredRole).toBe("team_member");
  });

  it("returns NOT_FOUND when thread missing", async () => {
    const ctx = makeCtx([]);
    const tool = createNotifyOwnerTool();

    const result = await tool.execute(
      { threadId: "t-1", message: "test" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(emitMock).not.toHaveBeenCalled();
    expect(publishLiveEventMock).not.toHaveBeenCalled();
  });

  it("returns NO_OWNER when ownerUserId is null", async () => {
    const ctx = makeCtx([{ ownerUserId: null }]);
    const tool = createNotifyOwnerTool();

    const result = await tool.execute(
      { threadId: "t-1", message: "test" },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("NO_OWNER");
    expect(emitMock).not.toHaveBeenCalled();
    expect(publishLiveEventMock).not.toHaveBeenCalled();
  });

  it("creates notification and emits LiveEvent", async () => {
    const ctx = makeCtx([{ ownerUserId: "user-99" }], { id: "notif-1" });
    const tool = createNotifyOwnerTool();

    const result = await tool.execute(
      { threadId: "t-1", message: "blocked" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ notificationId: "notif-1" });
    // Routed through hubItems.emit: semanticType `mention`, sourceType
    // `discussion`, sourceId = threadId, owner = the resolved thread owner.
    expect(emitMock).toHaveBeenCalledWith({
      companyId: "co-1",
      semanticType: "mention",
      sourceType: "discussion",
      sourceId: "t-1",
      title: "Thread notification",
      summary: "blocked",
      ownerUserId: "user-99",
    });
    expect(publishLiveEventMock).toHaveBeenCalledWith({
      companyId: "co-1",
      type: "internal_agent.notification",
      payload: { notificationId: "notif-1", threadId: "t-1" },
    });
  });

  it("level is included in title when warning/urgent", async () => {
    const ctx = makeCtx([{ ownerUserId: "user-1" }], { id: "notif-2" });
    const tool = createNotifyOwnerTool();

    const result = await tool.execute(
      { threadId: "t-1", message: "blocked", level: "urgent" },
      ctx,
    );

    expect(result.success).toBe(true);
    const callArgs = emitMock.mock.calls[0];
    expect(callArgs[0].title).toContain("[urgent]");
  });
});
