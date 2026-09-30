import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => ({ and: args })),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
  isNotNull: vi.fn((col: any) => ({ isNotNull: col })),
  isNull: vi.fn((col: any) => ({ isNull: col })),
  or: vi.fn((...args: any[]) => ({ or: args })),
  desc: vi.fn((col: any) => ({ desc: col })),
  asc: vi.fn((col: any) => ({ asc: col })),
  sql: Object.assign(
    vi.fn((_s: any) => {
      const tag: any = { as: vi.fn().mockReturnThis(), mapWith: vi.fn().mockReturnThis() };
      return tag;
    }),
    { raw: vi.fn((s: any) => s), placeholder: vi.fn((s: any) => s) },
  ),
}));

function tableProxy(name: string) {
  return new Proxy(
    {},
    { get(_t, prop) { return `${name}_${String(prop)}`; } },
  );
}

vi.mock("@armyofagents/db", () => ({
  issues: tableProxy("issues"),
  companies: tableProxy("companies"),
  discussions: tableProxy("discussions"),
  agents: tableProxy("agents"),
  agentWakeupRequests: tableProxy("awr"),
  companyMemberships: tableProxy("cm"),
  activityLog: tableProxy("al"),
  assets: tableProxy("assets"),
  authUsers: tableProxy("au"),
  executionWorkspaces: tableProxy("ew"),
  goals: tableProxy("goals"),
  heartbeatRuns: tableProxy("hr"),
  issueAttachments: tableProxy("ia"),
  issueLabels: tableProxy("il"),
  issueComments: tableProxy("ic"),
  issueMonitors: tableProxy("im"),
  issueReadStates: tableProxy("irs"),
  labels: tableProxy("labels"),
  projectWorkspaces: tableProxy("pw"),
  projects: tableProxy("projects"),
  taskDependencies: tableProxy("td"),
  userRoles: tableProxy("ur"),
  memoryItems: tableProxy("mi"),
  discussionExtractedItems: tableProxy("dei"),
  artifacts: tableProxy("art"),
  artifactVersions: tableProxy("av"),
  instanceSettings: tableProxy("is"),
  instanceExperimentalSettings: tableProxy("ies"),
  workQuestions: tableProxy("wq"),
  workQuestionContinuationRequests: tableProxy("wqcr"),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: false }),
  })),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
  publishIssueStatusChanged: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: vi.fn(() => ({
    reconcile: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../services/issue-agent-status-guard.js", () => ({
  assertAgentStatusTransition: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/agent-completion-policy.js", () => ({
  resolveAgentCompletionPolicy: vi.fn().mockResolvedValue({
    policy: "review_required",
    source: "company",
    sourceId: "company-1",
    guardrailApplied: false,
    resolvedAt: new Date("2026-07-11T00:00:00.000Z"),
  }),
}));

vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => Object.assign(new Error(msg), { status: 400 }),
  conflict: (msg: string) => Object.assign(new Error(msg), { status: 409 }),
  notFound: (msg: string) => Object.assign(new Error(msg), { status: 404 }),
  unprocessable: (msg: string) => Object.assign(new Error(msg), { status: 422 }),
  forbidden: (msg: string) => Object.assign(new Error(msg), { status: 403 }),
}));

const COMPANY_ID = "company-1";
const ISSUE_ID = "issue-1";

import { issueService } from "../services/issues.js";

type AgentRow = {
  id: string;
  companyId?: string;
  status?: string;
  parentType?: string | null;
  parentId?: string | null;
  reportsTo?: string | null;
};

type ExistingIssue = {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  responsibleUserId: string | null;
  projectId?: string | null;
  executionWorkspaceId?: string | null;
};

function chainForRows(rows: unknown[]) {
  const c: any = {};
  c.from = () => c;
  c.where = () => c;
  c.innerJoin = () => c;
  c.leftJoin = () => c;
  c.orderBy = () => c;
  c.limit = () => c;
  c.for = () => c;
  c.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return c;
}

function makeDb(options: {
  activeUsers?: string[];
  inactiveUsers?: string[];
  agents?: AgentRow[];
  founderUsers?: string[];
  existing?: ExistingIssue;
} = {}) {
  const activeUsers = new Set(options.activeUsers ?? []);
  const inactiveUsers = new Set(options.inactiveUsers ?? []);
  const agentsById = new Map((options.agents ?? []).map((agent) => [agent.id, agent]));
  const founderUsers = options.founderUsers ?? [];
  let capturedInsert: Record<string, unknown> | null = null;
  let capturedPatch: Record<string, unknown> | null = null;
  const capturedWhere: unknown[] = [];

  const db: any = {
    transaction: vi.fn((fn: (tx: any) => Promise<any>) => fn(db)),
    select: vi.fn((selection?: Record<string, unknown>) => {
      const c: any = chainForRows(options.existing && selection === undefined ? [options.existing] : []);
      c.where = vi.fn((condition: unknown) => {
        capturedWhere.push(condition);
        const text = JSON.stringify(condition);
        if (selection?.id === "cm_id") {
          const userId = [...activeUsers, ...inactiveUsers].find((id) => text.includes(id));
          return chainForRows(userId && activeUsers.has(userId) ? [{ id: `membership-${userId}` }] : []);
        }
        if (selection?.id === "agents_id" && selection?.status === "agents_status") {
          const agent = [...agentsById.values()].find((row) => text.includes(row.id));
          return chainForRows(agent ? [{
            id: agent.id,
            companyId: agent.companyId ?? COMPANY_ID,
            status: agent.status ?? "idle",
          }] : []);
        }
        if (selection?.parentType === "agents_parentType") {
          const agent = [...agentsById.values()].find((row) => text.includes(row.id));
          return chainForRows(agent && (agent.companyId ?? COMPANY_ID) === COMPANY_ID ? [{
            parentType: agent.parentType ?? null,
            parentId: agent.parentId ?? null,
            reportsTo: agent.reportsTo ?? null,
          }] : []);
        }
        if (selection?.userId === "ur_userId") {
          return chainForRows(founderUsers.map((userId) => ({ userId })));
        }
        return c;
      });
      return c;
    }),
    update: vi.fn((table: { id?: string }) => {
      const u: any = {};
      u.set = vi.fn((patch: Record<string, unknown>) => {
        if (
          table?.id === "issues_id" &&
          !Object.prototype.hasOwnProperty.call(patch, "clearReason")
        ) {
          capturedPatch = patch;
        }
        return u;
      });
      u.where = () => u;
      u.returning = vi.fn((selection?: Record<string, unknown>) => {
        if (table?.id === "wq_id") {
          return Promise.resolve([]);
        }
        if (selection?.issueCounter === "companies_issueCounter") {
          return Promise.resolve([{ issueCounter: 1, issuePrefix: "TASK" }]);
        }
        const updated = { ...(options.existing ?? {}), ...capturedPatch };
        return Promise.resolve([{ ...updated, labels: [] }]);
      });
      return u;
    }),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        capturedInsert = values;
        return {
          returning: vi.fn().mockResolvedValue([{
            ...values,
            id: ISSUE_ID,
            labels: [],
          }]),
          onConflictDoNothing: vi.fn().mockReturnThis(),
          onConflictDoUpdate: vi.fn().mockReturnThis(),
        };
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    getCapturedInsert: () => capturedInsert,
    getCapturedPatch: () => capturedPatch,
    getCapturedWhere: () => capturedWhere,
  };
  return db;
}

describe("issueService responsibleUserId resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults responsible user to the human assignee on create", async () => {
    const db = makeDb({ activeUsers: ["user-1"] });
    const created = await issueService(db).create(COMPANY_ID, {
      title: "Human task",
      status: "todo",
      assigneeUserId: "user-1",
    } as any);

    expect(created?.assigneeUserId).toBe("user-1");
    expect(created?.responsibleUserId).toBe("user-1");
    expect(db.getCapturedInsert()).toMatchObject({ responsibleUserId: "user-1" });
  });

  it("defaults responsible user to fallback user when a task has no assignee", async () => {
    const db = makeDb({ activeUsers: ["founder-user"] });
    const created = await issueService(db).create(COMPANY_ID, {
      title: "Unassigned operator-owned task",
      status: "todo",
      responsibleFallbackUserId: "founder-user",
    } as any);

    expect(created?.responsibleUserId).toBe("founder-user");
    expect(created?.assigneeAgentId ?? null).toBeNull();
    expect(created?.assigneeUserId ?? null).toBeNull();
    expect(db.getCapturedInsert()).toMatchObject({ responsibleUserId: "founder-user" });
    expect(db.getCapturedInsert()).not.toHaveProperty("responsibleFallbackUserId");
  });

  it("defaults an agent-assigned task to the nearest human manager", async () => {
    const db = makeDb({
      activeUsers: ["manager-user"],
      agents: [{ id: "agent-1", parentType: "user", parentId: "manager-user" }],
    });

    const created = await issueService(db).create(COMPANY_ID, {
      title: "Agent task",
      status: "todo",
      assigneeAgentId: "agent-1",
    } as any);

    expect(created?.assigneeAgentId).toBe("agent-1");
    expect(created?.responsibleUserId).toBe("manager-user");
  });

  it("falls back to a single active founder when the default human manager is inactive", async () => {
    const db = makeDb({
      activeUsers: ["founder-user"],
      inactiveUsers: ["former-manager"],
      founderUsers: ["founder-user"],
      agents: [{ id: "agent-1", parentType: "user", parentId: "former-manager" }],
    });

    const created = await issueService(db).create(COMPANY_ID, {
      title: "Agent task with inactive manager",
      status: "todo",
      assigneeAgentId: "agent-1",
    } as any);

    expect(created?.responsibleUserId).toBe("founder-user");
    expect(db.getCapturedInsert()).toMatchObject({ responsibleUserId: "founder-user" });
  });

  it("walks agent parent chains and falls back to legacy reportsTo for agent parents", async () => {
    const db = makeDb({
      activeUsers: ["director-user"],
      agents: [
        { id: "agent-1", reportsTo: "agent-2" },
        { id: "agent-2", parentType: "agent", parentId: "agent-3" },
        { id: "agent-3", parentType: "user", parentId: "director-user" },
      ],
    });

    const created = await issueService(db).create(COMPANY_ID, {
      title: "Chain task",
      status: "todo",
      assigneeAgentId: "agent-1",
    } as any);

    expect(created?.responsibleUserId).toBe("director-user");
  });

  it("lets an explicit responsible user override the default after membership validation", async () => {
    const db = makeDb({
      activeUsers: ["assignee-user", "owner-user"],
    });

    const created = await issueService(db).create(COMPANY_ID, {
      title: "Override task",
      status: "todo",
      assigneeUserId: "assignee-user",
      responsibleUserId: "owner-user",
    } as any);

    expect(created?.responsibleUserId).toBe("owner-user");
  });

  it("preserves explicit responsibleUserId null on create and update", async () => {
    const createDb = makeDb({ activeUsers: ["user-1"] });
    const created = await issueService(createDb).create(COMPANY_ID, {
      title: "Cleared create",
      status: "todo",
      assigneeUserId: "user-1",
      responsibleUserId: null,
    } as any);
    expect(created?.responsibleUserId).toBeNull();

    const updateDb = makeDb({
      existing: {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        responsibleUserId: "user-1",
      },
    });
    const updated = await issueService(updateDb).update(ISSUE_ID, { responsibleUserId: null } as any);
    expect(updated?.responsibleUserId).toBeNull();
    expect(updateDb.getCapturedPatch()).toMatchObject({ responsibleUserId: null });
  });

  it("rejects explicit out-of-company or inactive responsible users", async () => {
    const db = makeDb({ activeUsers: ["assignee-user"], inactiveUsers: ["inactive-user"] });

    await expect(
      issueService(db).create(COMPANY_ID, {
        title: "Inactive owner",
        status: "todo",
        assigneeUserId: "assignee-user",
        responsibleUserId: "inactive-user",
      } as any),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      issueService(db).create(COMPANY_ID, {
        title: "Other company owner",
        status: "todo",
        responsibleUserId: "other-company-user",
      } as any),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects an explicit empty string responsible user", async () => {
    const db = makeDb({ activeUsers: ["assignee-user"] });

    await expect(
      issueService(db).create(COMPANY_ID, {
        title: "Empty owner",
        status: "todo",
        assigneeUserId: "assignee-user",
        responsibleUserId: "",
      } as any),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("does not hang on broken or cyclic agent hierarchy and falls back to a single active founder or null", async () => {
    const founderDb = makeDb({
      activeUsers: ["founder-user"],
      founderUsers: ["founder-user"],
      agents: [
        { id: "agent-1", parentType: "agent", parentId: "agent-2" },
        { id: "agent-2", parentType: "agent", parentId: "agent-1" },
      ],
    });
    const withFounder = await issueService(founderDb).create(COMPANY_ID, {
      title: "Cycle with founder",
      status: "todo",
      assigneeAgentId: "agent-1",
    } as any);
    expect(withFounder?.responsibleUserId).toBe("founder-user");

    const noFounderDb = makeDb({
      agents: [{ id: "agent-1", parentType: "agent", parentId: "missing-agent" }],
    });
    const withoutFounder = await issueService(noFounderDb).create(COMPANY_ID, {
      title: "Broken without founder",
      status: "todo",
      assigneeAgentId: "agent-1",
    } as any);
    expect(withoutFounder?.responsibleUserId).toBeNull();
  });

  it("recomputes on executor change and preserves existing responsible user otherwise", async () => {
    const reassignmentDb = makeDb({
      activeUsers: ["manager-user"],
      agents: [{ id: "agent-1", parentType: "user", parentId: "manager-user" }],
      existing: {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        responsibleUserId: "user-1",
      },
    });
    const reassigned = await issueService(reassignmentDb).update(ISSUE_ID, { assigneeAgentId: "agent-1", assigneeUserId: null } as any);
    expect(reassigned?.responsibleUserId).toBe("manager-user");
    expect(reassignmentDb.getCapturedPatch()).toMatchObject({ responsibleUserId: "manager-user" });

    const unchangedDb = makeDb({
      existing: {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        responsibleUserId: "owner-user",
      },
    });
    const renamed = await issueService(unchangedDb).update(ISSUE_ID, { title: "Rename only" } as any);
    expect(renamed?.responsibleUserId).toBe("owner-user");
    expect(unchangedDb.getCapturedPatch()).not.toHaveProperty("responsibleUserId");
  });

  it("keeps an existing manual responsible human when only the assignee changes", async () => {
    const db = makeDb({
      activeUsers: ["owner-user", "manager-user"],
      agents: [{ id: "agent-1", parentType: "user", parentId: "manager-user" }],
      existing: {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        responsibleUserId: "owner-user",
      },
    });

    const updated = await issueService(db).update(ISSUE_ID, {
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    } as any);

    expect(updated?.responsibleUserId).toBe("owner-user");
    expect(db.getCapturedPatch()).not.toHaveProperty("responsibleUserId");
  });

  it("recomputes auto responsible human when reassigning between managed agents", async () => {
    const db = makeDb({
      activeUsers: ["old-manager", "new-manager"],
      agents: [
        { id: "agent-1", parentType: "user", parentId: "old-manager" },
        { id: "agent-2", parentType: "user", parentId: "new-manager" },
      ],
      existing: {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        status: "todo",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        responsibleUserId: "old-manager",
      },
    });

    const updated = await issueService(db).update(ISSUE_ID, {
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
    } as any);

    expect(updated?.responsibleUserId).toBe("new-manager");
    expect(db.getCapturedPatch()).toMatchObject({ responsibleUserId: "new-manager" });
  });

  it("preserves manual responsible human when reassigning between managed agents", async () => {
    const db = makeDb({
      activeUsers: ["old-manager", "new-manager", "manual-owner"],
      agents: [
        { id: "agent-1", parentType: "user", parentId: "old-manager" },
        { id: "agent-2", parentType: "user", parentId: "new-manager" },
      ],
      existing: {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        status: "todo",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        responsibleUserId: "manual-owner",
      },
    });

    const updated = await issueService(db).update(ISSUE_ID, {
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
    } as any);

    expect(updated?.responsibleUserId).toBe("manual-owner");
    expect(db.getCapturedPatch()).not.toHaveProperty("responsibleUserId");
  });

  it("preserves responsible user when update resends the same assignee and omits responsible user", async () => {
    const db = makeDb({
      activeUsers: ["user-1"],
      existing: {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        responsibleUserId: "owner-user",
      },
    });

    const updated = await issueService(db).update(ISSUE_ID, { assigneeUserId: "user-1" } as any);

    expect(updated?.responsibleUserId).toBe("owner-user");
    expect(db.getCapturedPatch()).not.toHaveProperty("responsibleUserId");
  });

  it("adds company, responsible user, and hidden predicates when listing by responsible user", async () => {
    const db = makeDb();

    await issueService(db).list(COMPANY_ID, {
      responsibleUserId: "owner-user",
      taskScope: "all",
    });

    expect(db.getCapturedWhere()).toContainEqual({
      and: expect.arrayContaining([
        { eq: ["issues_companyId", COMPANY_ID] },
        { eq: ["issues_responsibleUserId", "owner-user"] },
        { isNull: "issues_hiddenAt" },
      ]),
    });
  });
});
