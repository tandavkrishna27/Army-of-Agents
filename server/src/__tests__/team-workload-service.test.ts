import { describe, expect, it, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };

  return {
    agents: makeTable("agents"),
    assets: makeTable("assets"),
    authUsers: makeTable("auth_users"),
    companyMemberships: makeTable("company_memberships"),
    companyUserProfiles: makeTable("company_user_profiles"),
    instanceUserRoles: makeTable("instance_user_roles"),
    invites: makeTable("invites"),
    issues: makeTable("issues"),
    mcpApiKeys: makeTable("mcp_api_keys"),
    principalPermissionGrants: makeTable("principal_permission_grants"),
    projects: makeTable("projects"),
    userRoles: makeTable("user_roles"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  count: () => "count",
  eq: (..._args: unknown[]) => "eq",
  inArray: (..._args: unknown[]) => "inArray",
  isNull: (..._args: unknown[]) => "isNull",
  ne: (..._args: unknown[]) => "ne",
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

import { teamService } from "../services/team.js";

type MockRow = Record<string, unknown>;

function makeChain(getResult: () => MockRow[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "set", "values", "returning", "innerJoin", "leftJoin", "orderBy", "limit"]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (value: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
  return chain;
}

function createSequenceDb(selects: MockRow[][]) {
  let selectIndex = 0;
  return {
    select: () => makeChain(() => selects[selectIndex++] ?? []),
    update: () => makeChain(() => []),
    insert: () => makeChain(() => []),
    delete: () => makeChain(() => []),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      await fn(createSequenceDb(selects));
    },
  };
}

function issueRow(overrides: Partial<MockRow>): MockRow {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "MANA-1",
    title: "Task",
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    dueDate: null,
    updatedAt: new Date("2026-07-09T00:00:00.000Z"),
    ...overrides,
  };
}

describe("teamService.getWorkload", () => {
  it("returns responsible tasks, assigned tasks, and managed-agent rollups for one company", async () => {
    const db = createSequenceDb([
      [{ id: "membership-1", status: "active" }],
      [],
      [{ id: "agent-root", name: "Lead Agent" }],
      [{ id: "agent-child" }],
      [],
      [issueRow({ id: "issue-resp", title: "Own launch", responsibleUserId: "user-1" })],
      [issueRow({ id: "issue-assigned", title: "Do founder task", assigneeUserId: "user-1" })],
      [
        { id: "agent-root", name: "Lead Agent", role: "lead", status: "idle" },
        { id: "agent-child", name: "Worker Agent", role: "engineer", status: "idle" },
      ],
      [issueRow({ id: "issue-agent", title: "Build UI", assigneeAgentId: "agent-child", status: "blocked" })],
    ]);

    const workload = await (teamService(db as never) as any).getWorkload("company-1", "user-1");

    expect(workload.summary).toMatchObject({
      responsibleOpenTaskCount: 1,
      assignedOpenTaskCount: 1,
      managedAgentCount: 2,
      managedAgentOpenTaskCount: 1,
      attentionCount: 1,
    });
    expect(workload.managedAgentTasks[0]).toMatchObject({
      id: "issue-agent",
      managedAgentId: "agent-child",
      managedAgentName: "Worker Agent",
      rootAgentId: "agent-root",
      rootAgentName: "Lead Agent",
    });
  });

  it("throws Team member not found when the target user is not active in the company", async () => {
    const db = createSequenceDb([[]]);

    await expect((teamService(db as never) as any).getWorkload("company-1", "missing-user"))
      .rejects.toThrow("Team member not found");
  });

  it("returns empty open workload when no open rows match the active member", async () => {
    const db = createSequenceDb([
      [{ id: "membership-1", status: "active" }],
      [],
      [],
      [],
      [],
      [],
      [],
    ]);

    const workload = await (teamService(db as never) as any).getWorkload("company-1", "user-1");

    expect(workload.summary.responsibleOpenTaskCount).toBe(0);
    expect(workload.summary.assignedOpenTaskCount).toBe(0);
    expect(workload.summary.managedAgentCount).toBe(0);
    expect(workload.attentionItems).toEqual([]);
  });
});
