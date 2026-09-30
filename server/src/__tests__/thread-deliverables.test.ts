/**
 * P1-T1: Unit tests for `server/src/services/thread-deliverables.ts`
 *
 * Tests:
 *  A. Pure-function: `buildDeliverableInsert` assembles the correct payload.
 *  B. Service: `createDeliverableTasks` calls `issueService.create` once per
 *     proposal with `sourceDiscussionId = threadId` and returns the results.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock issueService so we don't pull drizzle/db into this test ───────────────

const mockCreate = vi.fn();

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({
    create: mockCreate,
  })),
}));

import {
  buildDeliverableInsert,
  threadDeliverablesService,
  type DeliverableProposal,
} from "../services/thread-deliverables.js";

// ── Mock DB factory (needed by T8b: createDeliverableTasks now calls findDefaultBuilder) ──
function makeMockDb() {
  function selectChain(): any {
    const result = [{ id: "default-engineer-id" }];
    const chain: any = {};
    chain.from = () => chain;
    chain.where = () => {
      const inner: any = {};
      inner.limit = () => Promise.resolve(result);
      inner.then = (resolve: any) => Promise.resolve(resolve(result));
      return inner;
    };
    chain.then = (resolve: any) => Promise.resolve(resolve(result));
    return chain;
  }
  return { select: vi.fn(selectChain) };
}

// ── Constants ──────────────────────────────────────────────────────────────────

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID  = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID    = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// ── A. Pure-function tests ─────────────────────────────────────────────────────

describe("buildDeliverableInsert", () => {
  it("sets sourceDiscussionId to threadId", () => {
    const payload = buildDeliverableInsert(
      COMPANY_ID,
      THREAD_ID,
      { title: "Write the hero copy" },
      { userId: USER_ID },
    );
    expect(payload.sourceDiscussionId).toBe(THREAD_ID);
  });

  it("defaults status to 'todo' when proposal omits it", () => {
    const payload = buildDeliverableInsert(
      COMPANY_ID,
      THREAD_ID,
      { title: "Untitled task" },
      { userId: USER_ID },
    );
    expect(payload.status).toBe("todo");
  });

  it("preserves an explicit status from the proposal", () => {
    const payload = buildDeliverableInsert(
      COMPANY_ID,
      THREAD_ID,
      { title: "Backlog item", status: "backlog" },
      { userId: USER_ID },
    );
    expect(payload.status).toBe("backlog");
  });

  it("maps createdBy.userId to createdByUserId", () => {
    const payload = buildDeliverableInsert(
      COMPANY_ID,
      THREAD_ID,
      { title: "By user" },
      { userId: USER_ID },
    );
    expect(payload.createdByUserId).toBe(USER_ID);
    expect(payload.createdByAgentId).toBeNull();
  });

  it("maps createdBy.agentId to createdByAgentId", () => {
    const AGENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const payload = buildDeliverableInsert(
      COMPANY_ID,
      THREAD_ID,
      { title: "By agent" },
      { agentId: AGENT_ID },
    );
    expect(payload.createdByAgentId).toBe(AGENT_ID);
    expect(payload.createdByUserId).toBeNull();
  });

  it("forwards proposal fields (projectId, priority, description) unchanged", () => {
    const proposal: DeliverableProposal = {
      title: "Full proposal",
      description: "A thorough description",
      priority: "high",
      projectId: "proj-1",
      goalId: "goal-1",
    };
    const payload = buildDeliverableInsert(COMPANY_ID, THREAD_ID, proposal, { userId: USER_ID });
    expect(payload.description).toBe("A thorough description");
    expect(payload.priority).toBe("high");
    expect(payload.projectId).toBe("proj-1");
    expect(payload.goalId).toBe("goal-1");
  });

  it("omits priority when the proposal has none so the DB default applies (F4: 23502 not-null guard)", () => {
    // issues.priority is NOT NULL DEFAULT 'medium'. The proposal mapping coerces
    // an unspecified priority to null; an EXPLICIT null overrides the default and
    // violates the constraint. The builder must OMIT the column entirely so the
    // DB default applies (this is what blocked every Adjutant scope-approval).
    const nullPriority = buildDeliverableInsert(
      COMPANY_ID,
      THREAD_ID,
      { title: "No priority", priority: null },
      { userId: USER_ID },
    );
    expect("priority" in nullPriority).toBe(false);

    const undefPriority = buildDeliverableInsert(
      COMPANY_ID,
      THREAD_ID,
      { title: "Unspecified priority" },
      { userId: USER_ID },
    );
    expect("priority" in undefPriority).toBe(false);
  });

  it("overwrites any sourceDiscussionId the proposal may already have", () => {
    const proposal: DeliverableProposal = {
      title: "Already has a stale id",
      sourceDiscussionId: "old-thread-id",
    };
    const payload = buildDeliverableInsert(COMPANY_ID, THREAD_ID, proposal, { userId: USER_ID });
    expect(payload.sourceDiscussionId).toBe(THREAD_ID);
  });

  it("stamps originKind as 'crew_thread'", () => {
    const payload = buildDeliverableInsert(
      COMPANY_ID,
      THREAD_ID,
      { title: "Some task" },
      { userId: USER_ID },
    );
    expect(payload.originKind).toBe("crew_thread");
  });

  it("does NOT set originId (must remain absent/undefined)", () => {
    const payload = buildDeliverableInsert(
      COMPANY_ID,
      THREAD_ID,
      { title: "Some task" },
      { userId: USER_ID },
    );
    expect(payload.originId).toBeUndefined();
  });

  it("originKind 'crew_thread' wins over any originKind in the proposal spread", () => {
    const proposal: DeliverableProposal = {
      title: "Proposal with existing originKind",
      originKind: "routine",
    };
    const payload = buildDeliverableInsert(COMPANY_ID, THREAD_ID, proposal, { userId: USER_ID });
    expect(payload.originKind).toBe("crew_thread");
  });
});

// ── B. Service tests ───────────────────────────────────────────────────────────

describe("threadDeliverablesService.createDeliverableTasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls issueService.create once per proposal", async () => {
    const fakeIssue = (n: number) => ({ id: `issue-${n}`, title: `Task ${n}` });
    mockCreate
      .mockResolvedValueOnce(fakeIssue(1))
      .mockResolvedValueOnce(fakeIssue(2));

    const proposals: DeliverableProposal[] = [
      { title: "Task 1" },
      { title: "Task 2" },
    ];

    const svc = threadDeliverablesService(makeMockDb() as any);
    const result = await svc.createDeliverableTasks({
      threadId: THREAD_ID,
      companyId: COMPANY_ID,
      proposals,
      createdBy: { userId: USER_ID },
    });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it("passes sourceDiscussionId=threadId to every create() call", async () => {
    const fakeIssue = { id: "issue-1", title: "Hero copy" };
    mockCreate.mockResolvedValue(fakeIssue);

    const svc = threadDeliverablesService(makeMockDb() as any);
    await svc.createDeliverableTasks({
      threadId: THREAD_ID,
      companyId: COMPANY_ID,
      proposals: [{ title: "Hero copy" }],
      createdBy: { userId: USER_ID },
    });

    const createArg = mockCreate.mock.calls[0][1];
    expect(createArg).toMatchObject({ sourceDiscussionId: THREAD_ID });
  });

  it("returns created issues in proposal order", async () => {
    mockCreate
      .mockResolvedValueOnce({ id: "i1", title: "First" })
      .mockResolvedValueOnce({ id: "i2", title: "Second" });

    const svc = threadDeliverablesService(makeMockDb() as any);
    const result = await svc.createDeliverableTasks({
      threadId: THREAD_ID,
      companyId: COMPANY_ID,
      proposals: [{ title: "First" }, { title: "Second" }],
      createdBy: { userId: USER_ID },
    });

    expect(result[0].id).toBe("i1");
    expect(result[1].id).toBe("i2");
  });

  it("returns an empty array when proposals is empty", async () => {
    const svc = threadDeliverablesService(makeMockDb() as any);
    const result = await svc.createDeliverableTasks({
      threadId: THREAD_ID,
      companyId: COMPANY_ID,
      proposals: [],
      createdBy: { userId: USER_ID },
    });

    expect(result).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("passes companyId to issueService.create as the first positional arg", async () => {
    mockCreate.mockResolvedValue({ id: "i1", title: "Test" });

    const svc = threadDeliverablesService(makeMockDb() as any);
    await svc.createDeliverableTasks({
      threadId: THREAD_ID,
      companyId: COMPANY_ID,
      proposals: [{ title: "Test" }],
      createdBy: { userId: USER_ID },
    });

    // First positional arg to create() is companyId
    expect(mockCreate.mock.calls[0][0]).toBe(COMPANY_ID);
  });
});
