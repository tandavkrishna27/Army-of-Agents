import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: any[]) => a),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  asc: vi.fn((c: any) => ({ asc: c })),
  desc: vi.fn((c: any) => ({ desc: c })),
  gt: vi.fn((a: any, b: any) => ({ gt: [a, b] })),
  inArray: vi.fn((c: any, v: any) => ({ inArray: [c, v] })),
  isNull: vi.fn((c: any) => ({ isNull: c })),
  or: vi.fn((...a: any[]) => a),
}));
vi.mock("@armyofagents/db", () => ({
  discussions: { id: "d_id", companyId: "d_company_id", visibility: "d_vis", ownerUserId: "d_owner", scopeType: "d_st", scopeId: "d_sid" },
  threadParticipants: { id: "tp_id", threadId: "tp_thread", principalType: "tp_pt", principalId: "tp_pid", role: "tp_role" },
  threadLinks: { id: "tl_id", fromThreadId: "tl_from", toThreadId: "tl_to" },
  userRoles: { id: "ur_id", companyId: "ur_co", userId: "ur_uid", projectId: "ur_proj" },
  threadPlanSteps: { id: "tps_id", threadId: "tps_thread", stepOrder: "tps_order", title: "tps_title", collapsed: "tps_collapsed", linkedItemId: "tps_linked", updatedAt: "tps_updated" },
  discussionEntries: {}, discussionExtractedItems: {}, scopeItemDependencies: {},
  taskDependencies: {}, issues: {}, agents: {}, authUsers: {}, companyMemberships: {},
  agentWakeupRequests: {}, notifications: {}, aoaAgentTriggers: {},
}));
vi.mock("../errors.js", () => ({
  badRequest: (m: string) => Object.assign(new Error(m), { status: 400 }),
  notFound: (m: string) => Object.assign(new Error(m), { status: 404 }),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/goals.js", () => ({ goalService: vi.fn(() => ({})) }));

import { threadService } from "../services/threads.js";

function seqDb(queue: any[][]) {
  let i = 0;
  const sel = () => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn((f: any) => Promise.resolve(f(queue[i++] ?? []))),
  });
  const db: any = {
    select: vi.fn(sel),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockReturnThis(),
        then: vi.fn((f: any) => Promise.resolve(f(queue[i++] ?? []))),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })) })),
    transaction: vi.fn(async (fn: any) => fn(db)),
  };
  return db;
}

const founder = { userId: "u1", role: "founder" as const, isHuman: true };

beforeEach(() => vi.clearAllMocks());

describe("threadService.getPlanSteps", () => {
  it("returns ordered plan steps for a viewable thread", async () => {
    const db = seqDb([
      [{ id: "t1", companyId: "co1", visibility: "company", ownerUserId: "u1", scopeType: null, scopeId: null }],
      [
        { id: "s1", threadId: "t1", stepOrder: 0, title: "Spec", collapsed: false, linkedItemId: null },
        { id: "s2", threadId: "t1", stepOrder: 1, title: "Build", collapsed: false, linkedItemId: "item-9" },
      ],
    ]);
    const steps = await threadService(db).getPlanSteps("co1", "t1", founder);
    expect(steps.map((s: any) => s.title)).toEqual(["Spec", "Build"]);
  });
});

describe("threadService.updatePlanSteps", () => {
  it("replaces the plan with the given ordered titles (founder)", async () => {
    const db = seqDb([
      [{ id: "t1", companyId: "co1", visibility: "company", ownerUserId: "u1", scopeType: null, scopeId: null }],
      [{ id: "s1" }, { id: "s2" }],
    ]);
    const res = await threadService(db).updatePlanSteps(
      "co1", "t1", [{ title: "Spec" }, { title: "Build", linkedItemId: "item-9" }], founder,
    );
    expect(res.count).toBe(2);
    expect(db.delete).toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
  });

  it("hides-don't-403: throws notFound when a non-owner team_member edits", async () => {
    const db = seqDb([
      [{ id: "t1", companyId: "co1", visibility: "private", ownerUserId: "u9", scopeType: null, scopeId: null }],
      [],
    ]);
    await expect(
      threadService(db).updatePlanSteps(
        "co1", "t1", [{ title: "x" }],
        { userId: "u2", role: "team_member", isHuman: true },
      ),
    ).rejects.toThrow(/not found/i);
  });
});
