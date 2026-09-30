import { describe, expect, it, vi } from "vitest";
import { createQueryTools } from "../services/internal-agent/tools/query-tools.js";
import type { ToolContext, ServiceContainer } from "../services/internal-agent/types.js";

function mockServices(): ServiceContainer {
  return {
    issues: { list: vi.fn().mockResolvedValue([{ id: "t1", title: "Task 1", responsibleUserId: "user-owner" }]) } as any,
    goals: { list: vi.fn().mockResolvedValue([{ id: "g1", title: "Goal 1" }]) } as any,
    agents: {
      list: vi.fn().mockResolvedValue([{ id: "a1", name: "Agent 1" }]),
      orgForCompany: vi.fn().mockResolvedValue([]),
    } as any,
    projects: { list: vi.fn().mockResolvedValue([{ id: "d1", name: "Dept 1", type: "department" }]) } as any,
    costs: { summary: vi.fn().mockResolvedValue({ totalCents: 5000, count: 10 }) } as any,
    activity: { list: vi.fn().mockResolvedValue([{ id: "act1", action: "created" }]) } as any,
    companies: { get: vi.fn().mockResolvedValue({ name: "Test Co", vision: null, mission: null, issuePrefix: "TST", stage: null }) } as any,
    humanContext: { getBundle: vi.fn() } as any,
    humanDiscovery: { search: vi.fn() } as any,
    team: { listTeam: vi.fn() } as any,
    memory: {} as any,
    discussions: {} as any,
    dependencies: {} as any,
    suggestions: {} as any,
    notifications: {} as any,
    secrets: {} as any,
    artifacts: {} as any,
    heartbeat: {} as any,
    workflows: null,
  };
}

function makeCtx(services: ServiceContainer): ToolContext {
  return {
    companyId: "comp-1",
    userId: "user-1",
    userRole: "founder",
    enabledCapabilities: [],
    db: {} as any,
    services,
  };
}

describe("Query Tools", () => {
  it("creates 11 query tools", () => {
    const tools = createQueryTools();
    expect(tools).toHaveLength(11);
    expect(tools.every((t) => t.category === "query")).toBe(true);
    expect(tools.map((tool) => tool.name)).toContain("query_team_roster");
    expect(tools.map((tool) => tool.name)).toContain("query_human_context");
    expect(tools.map((tool) => tool.name)).toContain("find_humans");
    expect(tools.map((tool) => tool.name)).toContain("query_humans");
  });

  it("query_team_roster returns humans and agents with readable parents", async () => {
    const services = mockServices();
    services.agents.orgForCompany = vi.fn().mockResolvedValue([
      {
        id: "user-founder",
        name: "Maya Founder",
        role: "founder",
        status: "active",
        nodeType: "user",
        email: "maya@example.com",
        userRole: "founder",
        departmentName: "Executive",
        children: [
          {
            id: "agent-chief",
            name: "Chief of Staff",
            role: "cxo",
            status: "idle",
            nodeType: "agent",
            adapterType: "codex_local",
            parentType: "user",
            children: [
              {
                id: "agent-research",
                name: "Research Lead",
                role: "lead",
                status: "idle",
                nodeType: "agent",
                adapterType: "claude_local",
                parentType: "agent",
                children: [],
              },
            ],
          },
        ],
      },
    ]);
    const ctx = makeCtx(services);
    const queryTeamRoster = createQueryTools().find((tool) => tool.name === "query_team_roster")!;

    const result = await queryTeamRoster.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(services.agents.orgForCompany).toHaveBeenCalledWith("comp-1");
    expect((result.data as any).counts).toEqual({ humans: 1, agents: 2, total: 3 });
    expect((result.data as any).roster).toEqual([
      expect.objectContaining({
        id: "user-founder",
        kind: "human",
        name: "Maya Founder",
        parent: null,
        childCount: 1,
        depth: 0,
        path: ["Maya Founder"],
      }),
      expect.objectContaining({
        id: "agent-chief",
        kind: "agent",
        name: "Chief of Staff",
        parent: { id: "user-founder", kind: "human", name: "Maya Founder" },
        childCount: 1,
        depth: 1,
        path: ["Maya Founder", "Chief of Staff"],
      }),
      expect.objectContaining({
        id: "agent-research",
        kind: "agent",
        name: "Research Lead",
        parent: { id: "agent-chief", kind: "agent", name: "Chief of Staff" },
        childCount: 0,
        depth: 2,
        path: ["Maya Founder", "Chief of Staff", "Research Lead"],
      }),
    ]);
    expect(result.summary).toBe("Found 3 team member(s): 1 human(s), 2 agent(s)");
  });

  it("query_team_roster respects limit and can omit the nested tree", async () => {
    const services = mockServices();
    services.agents.orgForCompany = vi.fn().mockResolvedValue([
      {
        id: "user-1",
        name: "Founder",
        role: "founder",
        status: "active",
        nodeType: "user",
        children: [
          { id: "agent-1", name: "Agent One", role: "general", status: "idle", nodeType: "agent", children: [] },
        ],
      },
    ]);
    const ctx = makeCtx(services);
    const queryTeamRoster = createQueryTools().find((tool) => tool.name === "query_team_roster")!;

    const result = await queryTeamRoster.execute({ limit: 1, includeTree: false }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as any).roster).toHaveLength(1);
    expect((result.data as any).tree).toBeUndefined();
    expect((result.data as any).counts).toEqual({ humans: 1, agents: 1, total: 2 });
  });

  it("query_humans returns the company human roster without requiring search text", async () => {
    const services = mockServices();
    services.team.listTeam = vi.fn().mockResolvedValue({
      currentUser: null,
      members: [
        {
          userId: "local-board",
          email: "local@aoa.local",
          displayName: "Live Codex Human",
          avatarUrl: null,
          title: "Human Routing Specialist",
          bio: "Owns live commander human routing validation.",
          location: null,
          timezone: null,
          socialLinks: [],
          role: "founder",
          departmentId: null,
          departmentName: null,
          permissions: [],
          isCurrentUser: true,
          isSystemAdmin: true,
          parentType: null,
          parentId: null,
        },
      ],
      pendingInvites: [],
    });
    const ctx = makeCtx(services);
    const queryHumans = createQueryTools().find((tool) => tool.name === "query_humans")!;

    const result = await queryHumans.execute({ limit: 20 }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as any).results).toHaveLength(1);
    expect((result.data as any).results[0]).toMatchObject({
      userId: "local-board",
      displayName: "Live Codex Human",
      role: "founder",
      title: "Human Routing Specialist",
    });
    expect(result.summary).toBe("Found 1 human(s)");
  });

  it("query_tasks calls issues.list and returns ToolResult", async () => {
    const services = mockServices();
    const ctx = makeCtx(services);
    const tools = createQueryTools();
    const queryTasks = tools.find((t) => t.name === "query_tasks")!;

    const result = await queryTasks.execute({ status: "todo", limit: 10 }, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.summary).toContain("1");
    expect(services.issues.list).toHaveBeenCalledWith("comp-1", expect.objectContaining({ status: "todo" }));
  });

  it("query_tasks includes responsibleUserId from returned issue rows", async () => {
    const services = mockServices();
    services.issues.list = vi.fn().mockResolvedValue([
      { id: "t1", title: "Task 1", responsibleUserId: "user-owner" },
      { id: "t2", title: "Task 2", responsibleUserId: null },
    ]);
    const ctx = makeCtx(services);
    const queryTasks = createQueryTools().find((t) => t.name === "query_tasks")!;

    const result = await queryTasks.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([
      expect.objectContaining({ id: "t1", responsibleUserId: "user-owner" }),
      expect.objectContaining({ id: "t2", responsibleUserId: null }),
    ]);
  });

  it("query_goals calls goals.list and returns ToolResult", async () => {
    const services = mockServices();
    const ctx = makeCtx(services);
    const tools = createQueryTools();
    const queryGoals = tools.find((t) => t.name === "query_goals")!;

    const result = await queryGoals.execute({}, ctx);

    expect(result.success).toBe(true);
    expect(services.goals.list).toHaveBeenCalledWith("comp-1");
  });

  it("all query tools have requiresConfirmation: false", () => {
    const tools = createQueryTools();
    expect(tools.every((t) => t.requiresConfirmation === false)).toBe(true);
  });

  it("all query tools have valid JSON Schema parameters", () => {
    const tools = createQueryTools();
    for (const tool of tools) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.properties).toBeDefined();
    }
  });
});
