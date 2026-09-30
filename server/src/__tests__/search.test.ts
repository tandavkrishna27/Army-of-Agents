import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  sql: Object.assign(
    vi.fn((strings: unknown, ...values: unknown[]) => ({ strings, values })),
    {
      join: vi.fn((values: unknown[]) => values),
    },
  ),
}));

vi.mock("@armyofagents/db", () => ({
  userRoles: {
    role: "role",
    projectId: "project_id",
    companyId: "company_id",
    userId: "user_id",
  },
}));

import { searchService } from "../services/search.js";

function makeDb(userRoleRows: Array<{ role: string; projectId: string | null }>, executeRows: unknown[]) {
  let executeIndex = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(userRoleRows),
      }),
    }),
    execute: async () => ({ rows: executeRows[executeIndex++] ?? [] }),
  } as any;
}

function executeFixtures() {
  return [
    [
      {
        id: "task-1",
        identifier: "TASK-1",
        title: "Searchable task",
        subtitle: "Task description",
        status: "todo",
        score: 0.9,
        projectId: "dept-1",
        projectName: "Engineering",
        assigneeUserId: "user-1",
      },
      {
        id: "task-2",
        identifier: "TASK-2",
        title: "Unscoped task",
        subtitle: "Public task",
        status: "todo",
        score: 0.7,
        projectId: null,
        projectName: null,
        assigneeUserId: null,
      },
    ],
    [
      {
        id: "goal-1",
        title: "Search goal",
        subtitle: "Goal description",
        status: "active",
        score: 0.8,
        projectIds: ["dept-1"],
        projectNames: ["Engineering"],
      },
    ],
    [
      {
        id: "agent-1",
        name: "Atlas",
        title: "Staff Engineer",
        role: "engineer",
        status: "active",
        score: 0.75,
      },
    ],
    [
      {
        id: "brief-1",
        title: "Search brief",
        subtitle: "Brief evidence",
        status: "ready",
        score: 0.72,
        departmentId: "dept-1",
        projectId: null,
        departmentName: "Engineering",
      },
      {
        id: "brief-2",
        title: "Public brief",
        subtitle: "Public brief evidence",
        status: "ready",
        score: 0.55,
        departmentId: null,
        projectId: null,
        departmentName: null,
      },
    ],
    [
      {
        id: "memory-1",
        title: "Shared memory",
        subtitle: "Shared memory content",
        status: "approved",
        score: 0.85,
        departmentId: "dept-2",
        projectId: null,
        departmentName: "Sales",
        category: "reference",
        layer: "domain",
        visibility: "shared",
        taskAssigneeUserId: null,
      },
      {
        id: "memory-2",
        title: "Scoped memory",
        subtitle: "Scoped memory content",
        status: "approved",
        score: 0.65,
        departmentId: "dept-1",
        projectId: null,
        departmentName: "Engineering",
        category: "context",
        layer: "domain",
        visibility: "scoped",
        taskAssigneeUserId: null,
      },
      {
        id: "memory-archived",
        title: "Archived memory",
        subtitle: "Should stay hidden",
        status: "archived",
        score: 0.6,
        departmentId: null,
        projectId: null,
        departmentName: null,
        category: "reference",
        layer: "domain",
        visibility: "shared",
        taskAssigneeUserId: null,
      },
    ],
    [
      {
        id: "artifact-1",
        title: "Spec artifact",
        subtitle: "Artifact content",
        status: "active",
        score: 0.78,
        artifactType: "document",
        currentVersionNumber: 3,
        linkedIssueId: "task-1",
        linkedIssueIdentifier: "TASK-1",
        linkedIssueProjectId: "dept-1",
        linkedIssueAssigneeUserId: "user-1",
      },
      {
        id: "artifact-archived",
        title: "Archived artifact",
        subtitle: "Old artifact",
        status: "archived",
        score: 0.4,
        artifactType: "document",
        currentVersionNumber: 1,
        linkedIssueId: null,
        linkedIssueIdentifier: null,
        linkedIssueProjectId: null,
        linkedIssueAssigneeUserId: null,
      },
    ],
    [
      {
        id: "suggestion-1",
        title: "Pending suggestion",
        subtitle: "Evidence",
        status: "pending",
        score: 0.73,
        category: "memory_gap",
        relatedMemoryItemId: "memory-1",
        relatedMemoryDepartmentId: "dept-2",
        relatedMemoryProjectId: null,
        relatedMemoryVisibility: "shared",
        relatedMemoryTaskAssigneeUserId: null,
      },
      {
        id: "suggestion-2",
        title: "Dismissed suggestion",
        subtitle: "Ignored",
        status: "dismissed",
        score: 0.2,
        category: "goal_gap",
        relatedMemoryItemId: null,
        relatedMemoryDepartmentId: null,
        relatedMemoryProjectId: null,
        relatedMemoryVisibility: null,
        relatedMemoryTaskAssigneeUserId: null,
      },
    ],
  ];
}

describe("searchService", () => {
  it("returns grouped results across entity types", async () => {
    const svc = searchService(makeDb([], executeFixtures()));

    const result = await svc.search("company-1", {
      query: "search",
      actor: { type: "board", source: "local_implicit", userId: "founder-1" },
    });

    expect(result.groups.map((group) => group.type)).toEqual([
      "task",
      "goal",
      "agent",
      "brief",
      "memory",
      "artifact",
      "suggestion",
    ]);
    expect(result.totalCount).toBeGreaterThanOrEqual(7);
  });

  it("filters team member results to assigned tasks and public entities", async () => {
    const svc = searchService(
      makeDb([{ role: "team_member", projectId: "dept-1" }], executeFixtures()),
    );

    const result = await svc.search("company-1", {
      query: "search",
      actor: { type: "board", source: "session", userId: "user-1" },
    });

    const taskGroup = result.groups.find((group) => group.type === "task");
    const memoryGroup = result.groups.find((group) => group.type === "memory");
    const briefGroup = result.groups.find((group) => group.type === "brief");

    expect(taskGroup?.items.map((item) => item.id)).toEqual(["task-1", "task-2"]);
    expect(memoryGroup?.items.map((item) => item.id)).toEqual(["memory-1"]);
    expect(briefGroup?.items.map((item) => item.id)).toEqual(["brief-2"]);
  });

  it("shows department-scoped results to a team lead", async () => {
    const svc = searchService(
      makeDb([{ role: "team_lead", projectId: "dept-1" }], executeFixtures()),
    );

    const result = await svc.search("company-1", {
      query: "search",
      actor: { type: "board", source: "session", userId: "lead-1" },
    });

    const briefGroup = result.groups.find((group) => group.type === "brief");
    const memoryGroup = result.groups.find((group) => group.type === "memory");

    expect(briefGroup?.items.map((item) => item.id)).toEqual(["brief-1", "brief-2"]);
    expect(memoryGroup?.items.map((item) => item.id)).toEqual(["memory-1", "memory-2"]);
  });

  it("keeps shared memory visible to all roles and excludes archived by default", async () => {
    const svc = searchService(
      makeDb([{ role: "team_member", projectId: "dept-1" }], executeFixtures()),
    );

    const result = await svc.search("company-1", {
      query: "search",
      actor: { type: "board", source: "session", userId: "user-1" },
    });

    const memoryIds = result.groups.find((group) => group.type === "memory")?.items.map((item) => item.id) ?? [];
    const artifactIds = result.groups.find((group) => group.type === "artifact")?.items.map((item) => item.id) ?? [];
    const suggestionIds = result.groups.find((group) => group.type === "suggestion")?.items.map((item) => item.id) ?? [];

    expect(memoryIds).toContain("memory-1");
    expect(memoryIds).not.toContain("memory-archived");
    expect(artifactIds).not.toContain("artifact-archived");
    expect(suggestionIds).toEqual(["suggestion-1"]);
  });

  it("records a fast response time for the aggregated result", async () => {
    const svc = searchService(makeDb([], executeFixtures()));

    const result = await svc.search("company-1", {
      query: "search",
      actor: { type: "board", source: "local_implicit", userId: "founder-1" },
    });

    expect(result.tookMs).toBeLessThan(200);
  });
});
