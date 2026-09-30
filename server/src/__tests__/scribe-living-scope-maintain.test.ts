import { beforeEach, describe, it, expect, vi } from "vitest";

const updatePlanSteps = vi.fn().mockResolvedValue({ count: 1 });
const updateSummary = vi.fn().mockResolvedValue({ id: "t1" });

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: any[]) => a),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  inArray: vi.fn((c: any, v: any) => ({ inArray: [c, v] })),
}));
vi.mock("@armyofagents/db", () => ({
  discussions: { id: "d_id", companyId: "d_co", phase: "d_phase" },
  discussionEntries: { id: "de_id", discussionId: "de_disc" },
  discussionExtractedItems: {
    id: "dei_id", discussionEntryId: "dei_entry",
    type: "dei_type", title: "dei_title", createdAt: "dei_created",
  },
}));
vi.mock("../services/threads.js", () => ({
  threadService: () => ({ updatePlanSteps, updateSummary }),
}));

import { maintainLivingScope } from "../services/internal-agent/aoa-agents/scribe-living-scope.js";

function seqDb(queue: any[][]) {
  let i = 0;
  const sel = () => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: vi.fn((f: any) => Promise.resolve(f(queue[i++] ?? []))),
  });
  return { select: vi.fn(sel) } as any;
}

beforeEach(() => vi.clearAllMocks());

describe("maintainLivingScope", () => {
  it("rebuilds the Plan from task items while in discuss", async () => {
    const db = seqDb([
      [{ id: "t1", phase: "discuss", companyId: "co1" }],
      [{ id: "e1" }],
      [{ id: "a", type: "task", title: "Spec", createdAt: "1" }],
    ]);
    await maintainLivingScope(db, "co1", "t1", { userId: "scribe", role: "founder", isHuman: false });
    expect(updatePlanSteps).toHaveBeenCalledWith(
      "co1", "t1",
      [{ title: "Spec", linkedItemId: "a" }],
      expect.anything(),
    );
  });

  it("replaces with an empty plan when there are no task items", async () => {
    const db = seqDb([
      [{ id: "t1", phase: "discuss", companyId: "co1" }],
      [{ id: "e1" }],
      [],
    ]);
    await maintainLivingScope(db, "co1", "t1", { userId: "scribe", role: "founder", isHuman: false });
    expect(updatePlanSteps).toHaveBeenCalledWith("co1", "t1", [], expect.anything());
  });

  it("returns early when thread not found (no service calls)", async () => {
    const db = seqDb([[]]);
    await maintainLivingScope(db, "co1", "missing", { userId: "scribe", role: "founder", isHuman: false });
    expect(updatePlanSteps).not.toHaveBeenCalled();
  });

  it("skips the entries query when there are no entries", async () => {
    const db = seqDb([
      [{ id: "t1", phase: "discuss", companyId: "co1" }],
      [],
    ]);
    await maintainLivingScope(db, "co1", "t1", { userId: "scribe", role: "founder", isHuman: false });
    expect(updatePlanSteps).toHaveBeenCalledWith("co1", "t1", [], expect.anything());
  });
});
