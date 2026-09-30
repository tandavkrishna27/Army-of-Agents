import { describe, it, expect } from "vitest";
import { groupScopeItems, type ScopeItem, type GroupedScope } from "../scopeGrouping";

function makeItem(overrides: Partial<ScopeItem> = {}): ScopeItem {
  return {
    id: "item-1",
    type: "task",
    title: "Default item",
    description: null,
    status: "pending",
    conflictsWith: null,
    suggestedPriority: null,
    suggestedAssigneeId: null,
    suggestedDepartmentId: null,
    suggestedLayer: null,
    layer: null,
    dedupAction: null,
    resultTaskId: null,
    resultMemoryId: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("groupScopeItems", () => {
  it("places rejected items in no group (skips them)", () => {
    const items = [makeItem({ id: "r1", status: "rejected" })];
    const result = groupScopeItems(items);
    expect(result.needsInput).toHaveLength(0);
    expect(result.confirmed).toHaveLength(0);
    expect(result.references).toHaveLength(0);
    expect(result.artifacts).toHaveLength(0);
  });

  it("places pending items in needsInput", () => {
    const item = makeItem({ id: "p1", status: "pending", type: "task" });
    const result = groupScopeItems([item]);
    expect(result.needsInput).toHaveLength(1);
    expect(result.needsInput[0].item.id).toBe("p1");
    expect(result.needsInput[0].hasConflict).toBe(false);
  });

  it("sets hasConflict=true when conflictsWith is non-empty", () => {
    const item = makeItem({
      id: "p2",
      status: "pending",
      conflictsWith: "some-other-item",
    });
    const result = groupScopeItems([item]);
    expect(result.needsInput[0].hasConflict).toBe(true);
  });

  it("places edited items in needsInput as well (still needs input)", () => {
    const item = makeItem({ id: "e1", status: "edited", type: "task" });
    const result = groupScopeItems([item]);
    expect(result.needsInput).toHaveLength(1);
  });

  it("places approved task in confirmed", () => {
    const item = makeItem({ id: "a1", status: "approved", type: "task" });
    const result = groupScopeItems([item]);
    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0].id).toBe("a1");
  });

  it("places approved reference type in references group", () => {
    const item = makeItem({ id: "ref1", status: "approved", type: "reference" });
    const result = groupScopeItems([item]);
    expect(result.references).toHaveLength(1);
    expect(result.confirmed).toHaveLength(0);
  });

  it("places approved artifact type in artifacts group", () => {
    const item = makeItem({ id: "art1", status: "approved", type: "artifact" });
    const result = groupScopeItems([item]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.confirmed).toHaveLength(0);
  });

  it("groups mixed items correctly", () => {
    const items = [
      makeItem({ id: "r1", status: "rejected" }),
      makeItem({ id: "p1", status: "pending", type: "task" }),
      makeItem({ id: "p2", status: "pending", conflictsWith: "conflict", type: "task" }),
      makeItem({ id: "a1", status: "approved", type: "task" }),
      makeItem({ id: "ref1", status: "approved", type: "reference" }),
      makeItem({ id: "art1", status: "approved", type: "artifact" }),
    ];
    const result = groupScopeItems(items);
    expect(result.needsInput).toHaveLength(2);
    expect(result.needsInput.find((x) => x.item.id === "p2")?.hasConflict).toBe(true);
    expect(result.confirmed).toHaveLength(1);
    expect(result.references).toHaveLength(1);
    expect(result.artifacts).toHaveLength(1);
  });
});
