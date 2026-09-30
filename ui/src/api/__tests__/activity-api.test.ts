import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();

vi.mock("../client", () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
  },
}));

import { activityApi } from "../activity";

describe("activityApi", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serializes actor filters with entity filters", async () => {
    get.mockResolvedValueOnce([]);

    await activityApi.list("company-1", {
      actorType: "user",
      actorId: "user-1",
      entityType: "issue",
      entityId: "issue-1",
    });

    expect(get).toHaveBeenCalledWith(
      "/companies/company-1/activity?entityType=issue&entityId=issue-1&actorType=user&actorId=user-1",
    );
  });
});
