import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  sql: Object.assign(vi.fn((strings: unknown, ...values: unknown[]) => ({ strings, values })), {
    join: vi.fn((values: unknown[]) => values),
  }),
}));
vi.mock("@armyofagents/db", () => ({
  userRoles: { role: "role", projectId: "project_id", companyId: "company_id", userId: "user_id" },
}));

import { searchService } from "../services/search.js";

// userRoleRows: result of resolveScope's userRoles query (ONLY reached for board sessions).
// executeRows: per-entity-type execute() result arrays.
function makeDb(userRoleRows: Array<{ role: string; projectId: string | null }>, executeRows: unknown[]) {
  let userRolesQueried = false;
  let executeIndex = 0;
  const db = {
    select: () => ({ from: () => ({ where: () => { userRolesQueried = true; return Promise.resolve(userRoleRows); } }) }),
    execute: async () => ({ rows: executeRows[executeIndex++] ?? [] }),
  } as any;
  return { db, wasUserRolesQueried: () => userRolesQueried };
}

// Same fixtures as search.test.ts: task-1 (dept-1, assignee user-1) + task-2 (unscoped);
// brief-1 (dept-1) + brief-2 (unscoped); memory-1 (shared) + memory-2 (scoped dept-1, no assignee) + memory-archived.
function executeFixtures() {
  return [
    [
      { id: "task-1", identifier: "TASK-1", title: "Searchable task", subtitle: "d", status: "todo", score: 0.9, projectId: "dept-1", projectName: "Engineering", assigneeUserId: "user-1" },
      { id: "task-2", identifier: "TASK-2", title: "Unscoped task", subtitle: "p", status: "todo", score: 0.7, projectId: null, projectName: null, assigneeUserId: null },
    ],
    [{ id: "goal-1", title: "Search goal", subtitle: "d", status: "active", score: 0.8, projectIds: ["dept-1"], projectNames: ["Engineering"] }],
    [{ id: "agent-1", name: "Atlas", title: "Staff Engineer", role: "engineer", status: "active", score: 0.75 }],
    [
      { id: "brief-1", title: "Search brief", subtitle: "e", status: "ready", score: 0.72, departmentId: "dept-1", projectId: null, departmentName: "Engineering" },
      { id: "brief-2", title: "Public brief", subtitle: "e", status: "ready", score: 0.55, departmentId: null, projectId: null, departmentName: null },
    ],
    [
      { id: "memory-1", title: "Shared memory", subtitle: "c", status: "approved", score: 0.85, departmentId: "dept-2", projectId: null, departmentName: "Sales", category: "reference", layer: "domain", visibility: "shared", taskAssigneeUserId: null },
      { id: "memory-2", title: "Scoped memory", subtitle: "c", status: "approved", score: 0.65, departmentId: "dept-1", projectId: null, departmentName: "Engineering", category: "context", layer: "domain", visibility: "scoped", taskAssigneeUserId: null },
    ],
    [
      { id: "artifact-1", title: "Spec artifact", subtitle: "c", status: "active", score: 0.78, artifactType: "document", currentVersionNumber: 3, linkedIssueId: "task-1", linkedIssueIdentifier: "TASK-1", linkedIssueProjectId: "dept-1", linkedIssueAssigneeUserId: "user-1" },
    ],
    [
      { id: "suggestion-1", title: "Pending suggestion", subtitle: "e", status: "pending", score: 0.73, category: "memory_gap", relatedMemoryItemId: "memory-1", relatedMemoryDepartmentId: "dept-2", relatedMemoryProjectId: null, relatedMemoryVisibility: "shared", relatedMemoryTaskAssigneeUserId: null },
    ],
  ];
}

describe("search resolveScope founder-MCP/agent bypass", () => {
  it("MCP token (replayed founder userId) is demoted to team_member, NOT founder — excludes scoped/other-user entities", async () => {
    const { db, wasUserRolesQueried } = makeDb([{ role: "founder", projectId: null }], executeFixtures());
    const result = await searchService(db).search("company-1", {
      query: "search",
      actor: { type: "mcp", source: "mcp_key", userId: "founder-1", companyId: "company-1" } as any,
    });
    const ids = (t: string) => result.groups.find((g) => g.type === t)?.items.map((i) => i.id) ?? [];
    // Pre-fix: mcp → founder → sees ALL (task-1, memory-2, brief-1). Post-fix: team_member (no scoped projects, userId founder-1 owns none of these).
    expect(ids("task")).toEqual(["task-2"]);          // task-1 (dept-1, assignee user-1) excluded
    expect(ids("memory")).toEqual(["memory-1"]);      // memory-2 (scoped) excluded
    expect(ids("brief")).toEqual(["brief-2"]);        // brief-1 (dept-1) excluded
    expect(ids("goal")).toEqual([]);                  // goal-1 (dept-1 scoped) excluded for team_member without that project
    expect(ids("suggestion")).toEqual(["suggestion-1"]); // shared-memory-linked suggestion still visible
    // Even though the mocked userRoles row says "founder", the board-gate must NOT consult it for an mcp actor.
    expect(wasUserRolesQueried()).toBe(false);
  });

  it("agent token is demoted to team_member with no owner identity — sees only unscoped/shared (null-safe)", async () => {
    const { db, wasUserRolesQueried } = makeDb([{ role: "founder", projectId: null }], executeFixtures());
    const result = await searchService(db).search("company-1", {
      query: "search",
      actor: { type: "agent", agentId: "agent-x", companyId: "company-1" } as any,
    });
    const ids = (t: string) => result.groups.find((g) => g.type === t)?.items.map((i) => i.id) ?? [];
    expect(ids("task")).toEqual(["task-2"]);          // unscoped only; task-1 excluded
    expect(ids("memory")).toEqual(["memory-1"]);      // shared only; memory-2 (null-assignee scoped) must NOT leak via null===null
    expect(ids("brief")).toEqual(["brief-2"]);        // unscoped only
    expect(ids("goal")).toEqual([]);                  // dept-scoped goal excluded
    expect(ids("suggestion")).toEqual(["suggestion-1"]); // shared-linked suggestion visible
    expect(wasUserRolesQueried()).toBe(false);
  });

  it("board local_implicit founder still sees everything (regression guard)", async () => {
    const { db } = makeDb([], executeFixtures());
    const result = await searchService(db).search("company-1", {
      query: "search",
      actor: { type: "board", source: "local_implicit", userId: "founder-1" } as any,
    });
    const ids = (t: string) => result.groups.find((g) => g.type === t)?.items.map((i) => i.id) ?? [];
    expect(ids("task")).toEqual(["task-1", "task-2"]);
    expect(ids("memory")).toEqual(["memory-1", "memory-2"]);
    expect(ids("brief")).toEqual(["brief-1", "brief-2"]);
  });
});
