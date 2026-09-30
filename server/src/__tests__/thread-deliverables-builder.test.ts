/**
 * P1-T8b: Tests for default-builder selection and needs-worker flagging.
 *
 * Covers:
 *  A. findDefaultBuilder — returns engineer agent id or null.
 *  B. flagNeedsWorker — pure description helper.
 *  C. createDeliverableTasks — builder selection integration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Drizzle + DB mocks ────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: any, b: any) => ({ _tag: "eq", a, b })),
  and: vi.fn((...args: any[]) => ({ _tag: "and", args })),
  ne: vi.fn((a: any, b: any) => ({ _tag: "ne", a, b })),
  gt: vi.fn((a: any, b: any) => ({ _tag: "gt", a, b })),
  asc: vi.fn((col: any) => ({ _tag: "asc", col })),
  desc: vi.fn((col: any) => ({ _tag: "desc", col })),
  inArray: vi.fn((col: any, vals: any) => ({ _tag: "inArray", col, vals })),
  sql: vi.fn(),
}));

vi.mock("@armyofagents/db", () => ({
  discussionEntries: new Proxy({} as any, { get: (_t, p) => p }),
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
  agents: new Proxy({} as any, { get: (_t, p) => p }),
  threadPlanSteps: new Proxy({} as any, { get: (_t, p) => p }),
  threadInboxItems: new Proxy({} as any, { get: (_t, p) => p }),
  userRoles: new Proxy({} as any, { get: (_t, p) => p }),
  activityLog: new Proxy({} as any, { get: (_t, p) => p }),
  issues: new Proxy({} as any, { get: (_t, p) => p }),
  projects: new Proxy({} as any, { get: (_t, p) => p }),
  goals: new Proxy({} as any, { get: (_t, p) => p }),
  projectGoals: new Proxy({} as any, { get: (_t, p) => p }),
  assets: new Proxy({} as any, { get: (_t, p) => p }),
  artifacts: new Proxy({} as any, { get: (_t, p) => p }),
  memoryItems: new Proxy({} as any, { get: (_t, p) => p }),
  heartbeatRuns: new Proxy({} as any, { get: (_t, p) => p }),
}));

// ── issueService mock ─────────────────────────────────────────────────────────
const mockIssueCreate = vi.fn();

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({ create: mockIssueCreate })),
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import {
  findDefaultBuilder,
  flagNeedsWorker,
  threadDeliverablesService,
} from "../services/thread-deliverables.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID  = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID    = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ENGINEER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

// ── Mock DB factory ───────────────────────────────────────────────────────────
function makeMockDb(opts: { selectResults?: any[][] } = {}) {
  const selectQueue = [...(opts.selectResults ?? [])];
  let selectCallIdx = 0;

  function selectChain(): any {
    const idx = selectCallIdx++;
    const result = selectQueue[idx] ?? [];
    const chain: any = {};
    chain.from = () => chain;
    chain.where = () => {
      const inner: any = {};
      inner.limit = () => Promise.resolve(result);
      // Also resolve directly (for queries without .limit())
      inner.then = (resolve: any) => Promise.resolve(resolve(result));
      return inner;
    };
    chain.then = (resolve: any) => Promise.resolve(resolve(result));
    return chain;
  }

  return { select: vi.fn(selectChain) };
}

// ── A. findDefaultBuilder ─────────────────────────────────────────────────────

describe("findDefaultBuilder", () => {
  it("returns null when no Engineer agent exists", async () => {
    const db = makeMockDb({ selectResults: [[]] });
    const result = await findDefaultBuilder(db as any, COMPANY_ID);
    expect(result).toBeNull();
  });

  it("returns the agent id when Engineer exists", async () => {
    const db = makeMockDb({ selectResults: [[{ id: ENGINEER_ID }]] });
    const result = await findDefaultBuilder(db as any, COMPANY_ID);
    expect(result).toBe(ENGINEER_ID);
  });
});

// ── B. flagNeedsWorker ────────────────────────────────────────────────────────

describe("flagNeedsWorker", () => {
  const NOTICE = "⚠️ Needs a worker: assign an agent to this task before it can be built.";

  it("returns just the notice when description is null", () => {
    expect(flagNeedsWorker(null)).toBe(NOTICE);
  });

  it("returns just the notice when description is undefined", () => {
    expect(flagNeedsWorker(undefined)).toBe(NOTICE);
  });

  it("appends notice to existing description with double newline separator", () => {
    const result = flagNeedsWorker("Do the thing");
    expect(result).toBe(`Do the thing\n\n${NOTICE}`);
  });
});

// ── C. createDeliverableTasks — builder selection ─────────────────────────────

describe("createDeliverableTasks — builder selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes existing assigneeAgentId through without using builder result", async () => {
    // Even though builder lookup always fires, the existing assigneeAgentId should
    // be used as-is for proposals that already have one.
    const db = makeMockDb({ selectResults: [[{ id: ENGINEER_ID }]] });
    mockIssueCreate.mockResolvedValue({ id: "issue-1", assigneeAgentId: "existing-agent", workMode: null });

    const svc = threadDeliverablesService(db as any);
    await svc.createDeliverableTasks({
      threadId: THREAD_ID,
      companyId: COMPANY_ID,
      proposals: [{ title: "Task A", assigneeAgentId: "existing-agent" }],
      createdBy: { userId: USER_ID },
    });

    expect(mockIssueCreate).toHaveBeenCalledTimes(1);
    const createArg = mockIssueCreate.mock.calls[0][1];
    expect(createArg.assigneeAgentId).toBe("existing-agent");
  });

  it("assigns Engineer agent id when proposal has no assigneeAgentId and Engineer exists", async () => {
    const db = makeMockDb({ selectResults: [[{ id: ENGINEER_ID }]] });
    mockIssueCreate.mockResolvedValue({ id: "issue-2", assigneeAgentId: ENGINEER_ID, workMode: null });

    const svc = threadDeliverablesService(db as any);
    await svc.createDeliverableTasks({
      threadId: THREAD_ID,
      companyId: COMPANY_ID,
      proposals: [{ title: "Build feature X" }],
      createdBy: { userId: USER_ID },
    });

    expect(mockIssueCreate).toHaveBeenCalledTimes(1);
    const createArg = mockIssueCreate.mock.calls[0][1];
    expect(createArg.assigneeAgentId).toBe(ENGINEER_ID);
  });

  it("flags description when no assigneeAgentId and no Engineer found", async () => {
    const db = makeMockDb({ selectResults: [[]] }); // no Engineer
    mockIssueCreate.mockResolvedValue({ id: "issue-3", assigneeAgentId: null, workMode: null });

    const svc = threadDeliverablesService(db as any);
    await svc.createDeliverableTasks({
      threadId: THREAD_ID,
      companyId: COMPANY_ID,
      proposals: [{ title: "Build X", description: "Do the thing" }],
      createdBy: { userId: USER_ID },
    });

    expect(mockIssueCreate).toHaveBeenCalledTimes(1);
    const createArg = mockIssueCreate.mock.calls[0][1];
    expect(createArg.description).toContain("⚠️ Needs a worker");
    expect(createArg.description).toContain("Do the thing");
  });

  it("flags description when no assigneeAgentId, no Engineer, and description is null", async () => {
    const db = makeMockDb({ selectResults: [[]] }); // no Engineer
    mockIssueCreate.mockResolvedValue({ id: "issue-4", assigneeAgentId: null, workMode: null });

    const svc = threadDeliverablesService(db as any);
    await svc.createDeliverableTasks({
      threadId: THREAD_ID,
      companyId: COMPANY_ID,
      proposals: [{ title: "Build Y", description: null }],
      createdBy: { userId: USER_ID },
    });

    expect(mockIssueCreate).toHaveBeenCalledTimes(1);
    const createArg = mockIssueCreate.mock.calls[0][1];
    expect(createArg.description).toContain("⚠️ Needs a worker");
  });
});
