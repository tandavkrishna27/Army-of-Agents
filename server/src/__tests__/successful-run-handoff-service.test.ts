import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: "eq", left, right })),
  sql: Object.assign(vi.fn((...args: unknown[]) => ({ op: "sql", args })), { raw: vi.fn() }),
}));

vi.mock("@armyofagents/db", () => {
  const table = (name: string) => new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => `${name}.${String(property)}`,
  });
  return {
    activityLog: table("activity_log"),
    agentWakeupRequests: table("agent_wakeup_requests"),
    heartbeatRuns: table("heartbeat_runs"),
    issueComments: table("issue_comments"),
    issues: table("issues"),
  };
});

import { recoveryService } from "../services/recovery/service.js";

const COMPANY_ID = "company-1";
const AGENT_ID = "agent-1";
const ISSUE_ID = "issue-1";
const RUN_ID = "run-1";

function makeDb(rows: unknown[]) {
  let index = 0;
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: (resolve: (value: unknown[]) => unknown) => resolve(rows[index++] ?? []),
        })),
      })),
    })),
  };
  return db;
}

describe("successful run recovery service", () => {
  it("enqueues recovery through heartbeat so an org-agent wake gets a linked run", async () => {
    const run = {
      id: RUN_ID,
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      status: "succeeded",
      livenessState: "advanced",
      issueCommentStatus: "not_applicable",
      contextSnapshot: { issueId: ISSUE_ID },
    };
    const issue = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "in_progress",
      assigneeAgentId: AGENT_ID,
      executionRunId: RUN_ID,
    };
    const db = makeDb([[run], [issue], []]);
    const tx = {
      insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    };
    const enqueueWakeup = vi.fn(async (_agentId: string, options: Record<string, any>) => {
      await options.beforeIssueWakeCommit(tx, { id: "recovery-run", wakeupRequestId: "recovery-wakeup" });
      return { id: "recovery-run", wakeupRequestId: "recovery-wakeup" };
    });

    const result = await recoveryService(db as any, { enqueueWakeup }).handleCompletedRun(RUN_ID);

    expect(result).toMatchObject({ action: "queue_handoff", issueId: ISSUE_ID, agentId: AGENT_ID });
    expect(enqueueWakeup).toHaveBeenCalledWith(AGENT_ID, expect.objectContaining({
      source: "automation",
      reason: "finish_successful_run_handoff",
      idempotencyKey: `finish_successful_run_handoff:${ISSUE_ID}:${RUN_ID}:1`,
      contextSnapshot: expect.objectContaining({ issueId: ISSUE_ID }),
      beforeIssueWakeCommit: expect.any(Function),
    }));
    expect(tx.insert).toHaveBeenCalledTimes(2);
  });

  it("bounds recovery to one handoff per task, including later recovery runs", async () => {
    const run = {
      id: "recovery-run-2",
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      status: "succeeded",
      livenessState: "advanced",
      contextSnapshot: { issueId: ISSUE_ID, wakeReason: "finish_successful_run_handoff" },
    };
    const issue = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "in_progress",
      assigneeAgentId: AGENT_ID,
      executionRunId: "recovery-run-2",
    };
    const db = makeDb([[run], [issue], [{ id: "first-recovery-wakeup" }]]);
    const enqueueWakeup = vi.fn();

    const result = await recoveryService(db as any, { enqueueWakeup }).handleCompletedRun(RUN_ID);

    expect(result).toMatchObject({ action: "none", reason: "attempts_exhausted" });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});
