import { describe, it, expect, vi } from "vitest";

// Regression: ISSUE-001 — goalService.create inserted the goal row before
// validating parents, so a rejected (out-of-scope / cyclic) parent left an
// orphan top-level goal alongside the 400. This locks "validate before insert".
// Found by /qa on 2026-05-25.
// Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-05-25.md

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
}));

vi.mock("@armyofagents/db", () => ({
  goals: { id: "goals.id", companyId: "goals.companyId" },
  projectGoals: { goalId: "pg.goalId", projectId: "pg.projectId", companyId: "pg.companyId" },
  projects: { id: "p.id", name: "p.name", type: "p.type" },
  goalParents: { goalId: "gp.goalId", parentId: "gp.parentId" },
  issues: { goalId: "i.goalId", status: "i.status", dueDate: "i.dueDate", companyId: "i.companyId" },
}));

import { goalService } from "../services/goals.js";

describe("goalService.create — validate parents before insert (ISSUE-001)", () => {
  it("rejects an out-of-scope parent WITHOUT inserting the goal (no orphan)", async () => {
    let insertCalls = 0;
    // Sequence-aware select: assertParentsValid now runs (1) a same-tenant
    // existence check (parent rows) BEFORE (2) getGoalProjectIds(parent). The
    // parent IS same-company (passes B-M3) but scoped to ['p-other'], so the
    // scope-subset check is what must reject here.
    let selectCall = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => {
            const idx = selectCall;
            selectCall += 1;
            // 1. B-M3 parent existence/company check → same company.
            if (idx === 0) {
              return Promise.resolve([{ id: "parent-1", companyId: "co1" }]);
            }
            // 2. getGoalProjectIds(parent) → parent scoped to ['p-other'].
            return Promise.resolve([{ projectId: "p-other" }]);
          },
        }),
      }),
      insert: () => {
        insertCalls += 1;
        return {
          values: () => ({
            returning: () => Promise.resolve([{ id: "g-new" }]),
            onConflictDoNothing: () => Promise.resolve(),
          }),
        };
      },
    } as unknown as Parameters<typeof goalService>[0];

    // Child scoped to ['p-eng'] under a parent scoped to ['p-other'] → not a
    // subset → must reject, and must NOT have inserted anything.
    await expect(
      goalService(db).create("co1", {
        title: "x",
        projectIds: ["p-eng"],
        parentIds: ["parent-1"],
      } as Parameters<ReturnType<typeof goalService>["create"]>[1]),
    ).rejects.toThrow(/scope/i);

    expect(insertCalls).toBe(0);
  });
});
