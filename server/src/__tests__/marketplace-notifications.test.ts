import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  recordLifecycleAction: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@armyofagents/db", () => ({
  userRoles: new Proxy({}, { get: () => Symbol("column") }),
  hubItems: new Proxy({}, { get: () => Symbol("column") }),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: vi.fn(() => ({
    emit: mocks.emit,
    recordLifecycleAction: mocks.recordLifecycleAction,
  })),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { error: mocks.loggerError },
}));

import { marketplaceNotifications } from "../services/marketplace-notifications.js";

function founderDb(
  userIds = ["founder-1"],
  legacyRows: Array<{ id: string; version: number; sourceId: string }> = []
) {
  return {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () =>
          Promise.resolve(
            "userId" in selection
              ? userIds.map((userId) => ({ userId }))
              : legacyRows
          ),
      }),
    }),
  };
}

describe("marketplaceNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emit.mockResolvedValue({ id: "hub-1" });
    mocks.recordLifecycleAction.mockResolvedValue({ id: "audit-1" });
  });

  it("propagates update notification failures after logging them", async () => {
    const error = new Error("hub unavailable");
    mocks.emit.mockRejectedValueOnce(error);

    await expect(
      marketplaceNotifications.updateAvailable(
        founderDb() as any,
        "company-1",
        "skill:code-review",
        "Code Review",
        "1.0.0",
        "1.1.0"
      )
    ).rejects.toBe(error);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      { err: error, companyId: "company-1" },
      "marketplace-notifications: failed to notify founders"
    );
  });

  it("retries an update with the same idempotent founder source key", async () => {
    mocks.emit
      .mockRejectedValueOnce(new Error("temporary hub failure"))
      .mockResolvedValueOnce({ id: "hub-1" });
    const db = founderDb() as any;

    await expect(
      marketplaceNotifications.updateAvailable(
        db,
        "company-1",
        "skill:code-review",
        "Code Review",
        "1.0.0",
        "1.1.0"
      )
    ).rejects.toThrow("temporary hub failure");

    await expect(
      marketplaceNotifications.updateAvailable(
        db,
        "company-1",
        "skill:code-review",
        "Code Review",
        "1.0.0",
        "1.1.0"
      )
    ).resolves.toBeUndefined();

    expect(mocks.emit).toHaveBeenCalledTimes(2);
    expect(mocks.emit.mock.calls[0]?.[0]).toEqual(
      mocks.emit.mock.calls[1]?.[0]
    );
    expect(mocks.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        semanticType: "marketplace_op",
        sourceType: "marketplace_update",
        sourceId: "update_available:skill:code-review:founder-1",
        ownerUserId: "founder-1",
      })
    );
  });

  it("archives legacy version-keyed rows before emitting the stable catalog key", async () => {
    const db = founderDb(["founder-1"], [
      {
        id: "legacy-hub-1",
        version: 2,
        sourceId: "update_available:Code Review:1.1.0:founder-1",
      },
      {
        id: "other-update",
        version: 0,
        sourceId: "update_available:Web Search:1.1.0:founder-1",
      },
    ]) as any;

    await marketplaceNotifications.updateAvailable(
      db,
      "company-1",
      "skill:code-review",
      "Code Review",
      "1.0.0",
      "1.2.0",
      { reopenWhenArchived: true }
    );

    expect(mocks.recordLifecycleAction).toHaveBeenCalledOnce();
    expect(mocks.recordLifecycleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        hubItemId: "legacy-hub-1",
        action: "archive",
        expectedVersion: 2,
        actorType: "system",
      })
    );
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "update_available:skill:code-review:founder-1",
        reopenWhenArchived: true,
      })
    );
  });
});
