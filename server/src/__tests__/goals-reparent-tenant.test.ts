import { describe, it, expect, vi } from "vitest";

// B-M3 — goal re-parent must reject cross-tenant parent edges.
//
// PUT /goals/:id/parents validates the CHILD's company but passed parentIds
// straight to setGoalParents with no check that the parent goals belong to the
// same company. A FOREIGN company-wide goal (no project_goals rows) trivially
// passed isScopeWithinParent (parentProjectIds.length === 0 → true), so a
// founder of company A could attach their goal to a company B goal.
//
// Fix: setGoalParents → assertParentsValid loads the parent goals and rejects
// any whose companyId !== child's companyId. The existence (length) check is
// required so a non-existent / foreign id (which returns no row) is also
// rejected, not silently dropped.

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

type Svc = ReturnType<typeof goalService>;

/**
 * Sequence-based mock db for setGoalParents. setGoalParents runs, in order:
 *   1. getGoalProjectIds(child)   → select project_goals where goalId = child
 *   2. load child goal companyId  → select goals where id = child
 *   3. load parent goals          → select goals where id IN parentIds
 *   4. collectDescendants (BFS)   → select goal_parents (one+ queries; empty)
 *   5. per-parent getGoalProjectIds → select project_goals per parent
 * Then (if valid) delete + insert. We count inserts so a rejection proves no
 * edge was written.
 */
function makeDb(opts: {
  childProjectIds?: { projectId: string }[];
  childCompany: { id: string; companyId: string }[];
  parentRows: { id: string; companyId: string }[];
  parentProjectIds?: Record<string, { projectId: string }[]>;
}) {
  const selectResults: unknown[][] = [];
  // 1. getGoalProjectIds(child)
  selectResults.push(opts.childProjectIds ?? []);
  // 2. child goal row (companyId)
  selectResults.push(opts.childCompany);
  // 3. parent goal rows (existence + companyId)
  selectResults.push(opts.parentRows);
  // 4..N collectDescendants — return empty (no descendants)
  // 5..N per-parent getGoalProjectIds — keyed lookups appended lazily below.

  let selectCall = 0;
  let inserts = 0;
  let deletes = 0;

  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          const idx = selectCall;
          selectCall += 1;
          // First three calls are deterministic; after that we are in the
          // descendants BFS or per-parent scope loads. Return [] (no
          // descendants) then per-parent project ids.
          if (idx < selectResults.length) {
            return Promise.resolve(selectResults[idx]);
          }
          return Promise.resolve([]);
        },
      }),
    }),
    delete: () => {
      deletes += 1;
      return { where: () => Promise.resolve() };
    },
    insert: () => {
      inserts += 1;
      return {
        values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
      };
    },
  } as unknown as Parameters<typeof goalService>[0];

  return {
    db,
    get inserts() {
      return inserts;
    },
    get deletes() {
      return deletes;
    },
  };
}

describe("setGoalParents — cross-tenant parent rejection (B-M3)", () => {
  it("rejects a parent that belongs to ANOTHER company (no edge written)", async () => {
    const h = makeDb({
      childCompany: [{ id: "g-child", companyId: "co-A" }],
      // Foreign company-wide goal (no projects) in company B.
      parentRows: [{ id: "g-foreign", companyId: "co-B" }],
    });
    await expect(
      (goalService(h.db) as Svc).setGoalParents("g-child", ["g-foreign"]),
    ).rejects.toThrow(/company/i);
    expect(h.inserts).toBe(0);
  });

  it("rejects a NON-EXISTENT parent id (proves the length check)", async () => {
    const h = makeDb({
      childCompany: [{ id: "g-child", companyId: "co-A" }],
      // Requested parent does not exist → no row returned.
      parentRows: [],
    });
    await expect(
      (goalService(h.db) as Svc).setGoalParents("g-child", ["g-missing"]),
    ).rejects.toThrow(/company/i);
    expect(h.inserts).toBe(0);
  });

  it("allows same-company multi-parent (both company-wide)", async () => {
    const h = makeDb({
      childCompany: [{ id: "g-child", companyId: "co-A" }],
      parentRows: [
        { id: "g-p1", companyId: "co-A" },
        { id: "g-p2", companyId: "co-A" },
      ],
    });
    await expect(
      (goalService(h.db) as Svc).setGoalParents("g-child", ["g-p1", "g-p2"]),
    ).resolves.toBeUndefined();
    // delete-then-insert path executed → one insert of the new edges.
    expect(h.inserts).toBe(1);
  });

  it("allows a same-company company-wide parent (no projects) — does not over-reject", async () => {
    const h = makeDb({
      // Child is scoped to a project; parent is company-wide (no projects).
      childProjectIds: [{ projectId: "p-eng" }],
      childCompany: [{ id: "g-child", companyId: "co-A" }],
      parentRows: [{ id: "g-wide", companyId: "co-A" }],
    });
    await expect(
      (goalService(h.db) as Svc).setGoalParents("g-child", ["g-wide"]),
    ).resolves.toBeUndefined();
    expect(h.inserts).toBe(1);
  });
});
