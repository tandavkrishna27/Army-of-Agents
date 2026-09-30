// Milestone F1: an @mention on a kind='aoa' agent must NOT call heartbeat.wakeup
// (which enqueues a heartbeat_run AND a queued agent_wakeup_requests row →
// dual execution because the AoA dispatcher Phase-3 also drains that queued
// row). Instead, mirror delegate-to-subagent.ts: insert the wakeup row
// directly and let Phase-3 own the single execution. kind='org' agents keep
// heartbeat.wakeup (heartbeat is their only runtime).
//
// Contract test (proxy-table + hoisted-mock harness, copied verbatim from
// aoa-mention-resolution.test.ts).  Windows-runnable.
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above top-level consts, so mock fns we also assert on
// must be created via vi.hoisted (vitest-sanctioned pattern).
const { inArrayMock, andMock, eqMock } = vi.hoisted(() => ({
  inArrayMock: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
  andMock: vi.fn((...a: unknown[]) => ({ and: a })),
  eqMock: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));

vi.mock("drizzle-orm", () => ({
  and: andMock,
  eq: eqMock,
  inArray: inArrayMock,
  asc: vi.fn((c: unknown) => ({ asc: c })),
  desc: vi.fn((c: unknown) => ({ desc: c })),
  isNull: vi.fn((c: unknown) => ({ isNull: c })),
  or: vi.fn((...a: unknown[]) => ({ or: a })),
  sql: vi.fn((s: unknown, ...v: unknown[]) => { const o: any = { sql: s, v }; o.as = () => o; return o; }),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") return Symbol(`${name}.${prop}`);
        return undefined;
      },
    });
  // Exactly the tables issues.ts imports (lines 3-24 of issues.ts), plus
  // agentWakeupRequests (added by F1 for the direct-insert path).
  return {
    activityLog: makeTable("activity_log"),
    agents: makeTable("agents"),
    agentWakeupRequests: makeTable("agent_wakeup_requests"),
    assets: makeTable("assets"),
    authUsers: makeTable("auth_users"),
    companies: makeTable("companies"),
    companyMemberships: makeTable("company_memberships"),
    executionWorkspaces: makeTable("execution_workspaces"),
    goals: makeTable("goals"),
    heartbeatRuns: makeTable("heartbeat_runs"),
    issueAttachments: makeTable("issue_attachments"),
    issueLabels: makeTable("issue_labels"),
    issueComments: makeTable("issue_comments"),
    issueMonitors: makeTable("issue_monitors"),
    issueReadStates: makeTable("issue_read_states"),
    issues: makeTable("issues"),
    labels: makeTable("labels"),
    projectWorkspaces: makeTable("project_workspaces"),
    projects: makeTable("projects"),
    taskDependencies: makeTable("task_dependencies"),
    userRoles: makeTable("user_roles"),
    // Required by services/embeddings.ts (B1: createEmbeddingService target map)
    memoryItems: makeTable("memory_items"),
    discussions: makeTable("discussions"),
    discussionExtractedItems: makeTable("discussion_extracted_items"),
    embeddingQueue: makeTable("embedding_queue"),
  };
});

vi.mock("@armyofagents/shared", () => ({
  extractProjectMentionIds: vi.fn(() => []),
}));

// issues.ts now imports hub-items.ts (W1a Task 10); mock it so the real module
// (and its @armyofagents/shared imports) never load — this suite tests mention
// wakeup routing, not the emit path.
vi.mock("../services/hub-items.js", () => ({
  hubItemsService: vi.fn(() => ({ emit: vi.fn(async () => ({ id: "hub-1" })) })),
}));

vi.mock("../errors.js", () => ({
  conflict: (m: string) => new Error(m),
  notFound: (m: string) => new Error(m),
  unprocessable: (m: string) => new Error(m),
}));

vi.mock("../middleware/logger.js", () => {
  function makeLogger(): any {
    const l: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    l.child = () => makeLogger();
    return l;
  }
  return { logger: makeLogger() };
});

vi.mock("./dependencies.js", () => ({
  dependencyService: vi.fn(() => ({})),
}));

vi.mock("./heartbeat.js", () => ({
  heartbeatService: vi.fn(() => ({})),
}));

vi.mock("./instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({})),
}));

vi.mock("./issue-user-context.js", () => ({
  deriveIssueUserContext: vi.fn(() => ({})),
}));

vi.mock("./execution-workspace-policy.js", () => ({
  issueExecutionWorkspaceModeForPersistedWorkspace: vi.fn(() => "none"),
}));

vi.mock("./notifications.js", () => ({
  notificationService: vi.fn(() => ({})),
}));

vi.mock("../routes/issues-planning-mode-dispatch.js", () => ({
  shouldDispatchIssueWakeup: vi.fn(() => true),
}));

vi.mock("./issue-execution-policy.js", () => ({
  buildInitialIssueMonitorFields: vi.fn(() => ({})),
  buildIssueMonitorClearedPatch: vi.fn(() => ({})),
  normalizeIssueMonitorPolicy: vi.fn((p: unknown) => p),
}));

import { issueService } from "../services/issues.js";

// A chain that returns the given rows (so the select resolves to them).
function makeSelectChain(rows: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin"]) {
    chain[m] = (..._a: unknown[]) => chain;
  }
  chain.then = (resolve: (v: unknown[]) => unknown) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

describe("F1: AoA @mention uses direct wakeup insert, never heartbeat (single execution)", () => {
  beforeEach(() => {
    inArrayMock.mockClear();
    andMock.mockClear();
    eqMock.mockClear();
  });

  it("resolveAgentKinds returns a Map<id,kind> from one agents query", async () => {
    const db: any = { select: () => makeSelectChain([
      { id: "a-aoa", kind: "aoa" }, { id: "a-org", kind: "org" },
    ]) };
    const svc = issueService(db);
    const kinds = await svc.resolveAgentKinds(["a-aoa", "a-org"]);
    expect(kinds.get("a-aoa")).toBe("aoa");
    expect(kinds.get("a-org")).toBe("org");
  });

  it("resolveAgentKinds([]) returns empty Map without querying", async () => {
    const select = vi.fn();
    const svc = issueService({ select } as any);
    const kinds = await svc.resolveAgentKinds([]);
    expect(kinds.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });

  it("enqueueAoaMentionWakeup inserts ONE agent_wakeup_requests row status=queued", async () => {
    // Round-17 #2: the insert now chains .onConflictDoNothing(...) (idempotent
    // dedup on the comment-wakeup idempotency key).
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const insertValues = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insertedInto: unknown[] = [];
    const db: any = { insert: (tbl: unknown) => { insertedInto.push(tbl); return { values: insertValues }; } };
    const svc = issueService(db);
    await svc.enqueueAoaMentionWakeup("co-1", "a-aoa", {
      source: "automation", reason: "issue_comment_mentioned",
      payload: { issueId: "i-1", commentId: "c-1" },
    });
    expect(insertValues).toHaveBeenCalledTimes(1);
    const row = insertValues.mock.calls[0][0];
    expect(row).toMatchObject({
      companyId: "co-1", agentId: "a-aoa", status: "queued",
      reason: "issue_comment_mentioned", payload: { issueId: "i-1", commentId: "c-1" },
    });
    expect(typeof row.source).toBe("string");
  });
});
