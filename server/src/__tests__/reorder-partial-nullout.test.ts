import { describe, expect, it } from "vitest";

// Tests for the partial-reorder null-out logic. We extract the transformation
// as a pure function matching the handler's logic, test it independently,
// then verify the route applies the same logic (covered by
// internal-agent-reorder-auth.test.ts which tests the HTTP layer).

// computeReorderOps mirrors the route's logic semantically (not a literal copy).
// Structural properties (inArray bulk update, transaction, scope clauses) are
// covered by internal-agent-reorder-auth.test.ts (HTTP integration test).
function computeReorderOps(
  ownedIds: string[],
  orderedIds: string[],
): { id: string; sortOrder: number | null }[] {
  const ownedSet = new Set(ownedIds);
  const finalIds = orderedIds.filter((id) => ownedSet.has(id));
  const finalSet = new Set(finalIds);
  const omittedIds = ownedIds.filter((id) => !finalSet.has(id));

  return [
    ...finalIds.map((id, i) => ({ id, sortOrder: i })),
    ...omittedIds.map((id) => ({ id, sortOrder: null })),
  ];
}

describe("reorder handler — partial list null-out", () => {
  it("assigns sortOrder=0,1,2 to submitted IDs and null to omitted ID", () => {
    const owned = ["conv-a", "conv-b", "conv-c", "conv-d"];
    const submitted = ["conv-c", "conv-a", "conv-b"]; // conv-d is omitted

    const ops = computeReorderOps(owned, submitted);

    expect(ops).toEqual(
      expect.arrayContaining([
        { id: "conv-c", sortOrder: 0 },
        { id: "conv-a", sortOrder: 1 },
        { id: "conv-b", sortOrder: 2 },
        { id: "conv-d", sortOrder: null },
      ]),
    );
    expect(ops).toHaveLength(4);
  });

  it("nulls out ALL conversations when orderedIds is empty (full reset equivalent)", () => {
    const owned = ["conv-a", "conv-b"];
    const submitted: string[] = [];

    const ops = computeReorderOps(owned, submitted);

    expect(ops).toEqual(
      expect.arrayContaining([
        { id: "conv-a", sortOrder: null },
        { id: "conv-b", sortOrder: null },
      ]),
    );
    expect(ops).toHaveLength(2);
  });

  it("filters out foreign IDs (not in ownedSet) and nulls none when all owned are submitted", () => {
    const owned = ["conv-a", "conv-b"];
    const submitted = ["conv-a", "conv-b", "conv-foreign"]; // conv-foreign not owned

    const ops = computeReorderOps(owned, submitted);

    expect(ops.find((o) => o.id === "conv-foreign")).toBeUndefined();
    expect(ops.find((o) => o.id === "conv-a")?.sortOrder).toBe(0);
    expect(ops.find((o) => o.id === "conv-b")?.sortOrder).toBe(1);
    expect(ops.every((o) => o.sortOrder !== null)).toBe(true);
  });
});
