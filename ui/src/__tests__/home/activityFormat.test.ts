import { describe, it, expect } from "vitest";
import type { RecentActivityItem } from "@armyofagents/shared";
import { collapseActivity } from "../../components/home/activityFormat";

function item(overrides: Partial<RecentActivityItem> & Pick<RecentActivityItem, "id">): RecentActivityItem {
  return {
    actorType: "agent",
    actorId: "z",
    action: "issue.completed",
    entityType: "issue",
    entityId: "i1",
    details: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("collapseActivity", () => {
  it("collapses 3 identical consecutive items (same action+entityType+entityId) into one entry with count 3, keeping the newest createdAt", () => {
    // Items arrive newest-first, so a1 (index 0) is the newest of the run.
    const items: RecentActivityItem[] = [
      item({ id: "a1", createdAt: "2026-07-30T03:00:00.000Z" }),
      item({ id: "a2", createdAt: "2026-07-30T02:00:00.000Z" }),
      item({ id: "a3", createdAt: "2026-07-30T01:00:00.000Z" }),
    ];

    const result = collapseActivity(items);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "a1", count: 3, createdAt: "2026-07-30T03:00:00.000Z" });
  });

  it("keeps non-adjacent duplicates separate when a different item interrupts the run", () => {
    const items: RecentActivityItem[] = [
      item({ id: "a1" }),
      item({ id: "a2", action: "issue.created", entityId: "i2" }),
      item({ id: "a3" }), // same key as a1, but not adjacent to it
    ];

    const result = collapseActivity(items);

    expect(result.map((r) => r.id)).toEqual(["a1", "a2", "a3"]);
    expect(result.every((r) => r.count === 1)).toBe(true);
  });

  it("leaves consecutive items with distinct action, entityType, or entityId untouched", () => {
    const items: RecentActivityItem[] = [
      item({ id: "a1", action: "issue.created" }),
      item({ id: "a2", action: "issue.completed" }), // different action
      item({ id: "a3", action: "issue.completed", entityType: "cost", entityId: "c1" }), // different entityType/Id
      item({ id: "a4", action: "issue.completed", entityType: "cost", entityId: "c2" }), // different entityId
    ];

    const result = collapseActivity(items);

    expect(result).toHaveLength(4);
    expect(result.every((r) => r.count === 1)).toBe(true);
  });

  it("returns an empty array for empty input", () => {
    expect(collapseActivity([])).toEqual([]);
  });

  it("preserves order across mixed runs of collapsed and distinct items", () => {
    const items: RecentActivityItem[] = [
      item({ id: "a1" }),
      item({ id: "a2" }), // dup of a1 -> collapses into it
      item({ id: "a3", action: "issue.created" }),
      item({ id: "a4", action: "issue.created" }), // dup of a3 -> collapses
      item({ id: "a5", action: "issue.created" }), // dup of a3/a4 -> collapses
    ];

    const result = collapseActivity(items);

    expect(result.map((r) => ({ id: r.id, count: r.count }))).toEqual([
      { id: "a1", count: 2 },
      { id: "a3", count: 3 },
    ]);
  });

  it("does not mutate the input array", () => {
    const items: RecentActivityItem[] = [item({ id: "a1" }), item({ id: "a2" })];
    const snapshot = JSON.parse(JSON.stringify(items));
    collapseActivity(items);
    expect(items).toEqual(snapshot);
  });
});
