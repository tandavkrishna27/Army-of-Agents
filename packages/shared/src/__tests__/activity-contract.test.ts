import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../types/activity.js";

describe("activity contracts", () => {
  it("allows autonomous actors for system-handled activity", () => {
    const event: ActivityEvent = {
      id: "activity-1",
      companyId: "company-1",
      actorType: "autonomy",
      actorId: "autopilot",
      action: "hub_item.resolve",
      entityType: "hub_item",
      entityId: "hub-item-1",
      agentId: null,
      runId: null,
      details: null,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
    };

    expect(event.actorType).toBe("autonomy");
  });
});
