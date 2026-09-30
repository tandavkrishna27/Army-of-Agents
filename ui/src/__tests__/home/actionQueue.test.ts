import { describe, it, expect } from "vitest";
import { AlertCircle } from "lucide-react";
import type { ActionGroup } from "../../components/home/actionQueue";
import { allocateActionGroups } from "../../components/home/actionQueue";

function group(id: string, itemCount: number): ActionGroup {
  return {
    id,
    title: id,
    icon: AlertCircle,
    items: Array.from({ length: itemCount }, (_, i) => ({ key: `${id}-${i}`, label: `${id} item ${i}`, to: `/x/${i}` })),
  };
}

describe("allocateActionGroups", () => {
  it("returns every group untouched and zero overflow when the total fits the budget", () => {
    const groups = [group("a", 1), group("b", 1)];
    const { allocated, overflow } = allocateActionGroups(groups, 6);
    expect(allocated).toEqual([
      { group: groups[0], maxItems: 1 },
      { group: groups[1], maxItems: 1 },
    ]);
    expect(overflow).toBe(0);
  });

  it("fills groups in order, truncating the group that exhausts the budget", () => {
    const groups = [group("a", 1), group("b", 5)];
    const { allocated, overflow } = allocateActionGroups(groups, 2);
    expect(allocated).toEqual([
      { group: groups[0], maxItems: 1 },
      { group: groups[1], maxItems: 1 },
    ]);
    expect(overflow).toBe(4); // group b had 5, only 1 shown
  });

  it("drops a group entirely (not a 0-item entry) once the budget is already exhausted, folding its full count into overflow", () => {
    const groups = [group("a", 2), group("b", 3)];
    const { allocated, overflow } = allocateActionGroups(groups, 2);
    expect(allocated).toEqual([{ group: groups[0], maxItems: 2 }]);
    expect(overflow).toBe(3);
  });

  it("returns an empty allocation with zero overflow for an empty group list", () => {
    const { allocated, overflow } = allocateActionGroups([], 6);
    expect(allocated).toEqual([]);
    expect(overflow).toBe(0);
  });

  it("allocates exactly at the boundary with no overflow when totals equal the budget", () => {
    const groups = [group("a", 2), group("b", 4)];
    const { allocated, overflow } = allocateActionGroups(groups, 6);
    expect(allocated).toEqual([
      { group: groups[0], maxItems: 2 },
      { group: groups[1], maxItems: 4 },
    ]);
    expect(overflow).toBe(0);
  });
});
