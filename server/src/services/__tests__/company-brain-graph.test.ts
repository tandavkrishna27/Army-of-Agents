import { describe, expect, it } from "vitest";
import {
  __companyBrainGraphTest,
  buildCompanyGraphOverview,
  buildMemoryItemNeighborGraph,
  canSeeMemoryItemForGraph,
  type GraphActorScope,
  type MemoryItemGraphRow,
} from "../company-brain-graph.js";

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const MARKETING_ID = "00000000-0000-0000-0000-000000000101";
const PRODUCT_ID = "00000000-0000-0000-0000-000000000102";
const GOAL_ID = "00000000-0000-0000-0000-000000000201";
const TASK_ID = "00000000-0000-0000-0000-000000000301";
const ARTIFACT_ID = "00000000-0000-0000-0000-000000000401";
const AGENT_ID = "00000000-0000-0000-0000-000000000501";
const COMPANY_FOLDER_ID = "00000000-0000-0000-0000-000000000601";
const COMPANY_PEOPLE_FOLDER_ID = "00000000-0000-0000-0000-000000000602";
const MARKETING_FOLDER_ID = "00000000-0000-0000-0000-000000000603";

function memory(overrides: Partial<MemoryItemGraphRow> = {}): MemoryItemGraphRow {
  return {
    id: "00000000-0000-0000-0000-000000000901",
    companyId: COMPANY_ID,
    title: "Pricing decision",
    content: "We price by seat.",
    status: "approved",
    category: "decision",
    layer: "domain",
    visibility: "scoped",
    departmentId: MARKETING_ID,
    projectId: PRODUCT_ID,
    goalId: GOAL_ID,
    taskId: TASK_ID,
    sourceArtifactId: ARTIFACT_ID,
    agentId: AGENT_ID,
    folderPath: "Pricing",
    createdBy: "founder@example.com",
    createdAt: new Date("2026-06-02T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    ...overrides,
  };
}

const founder: GraphActorScope = {
  actorType: "user",
  principalId: "founder@example.com",
  role: "founder",
  departmentIds: [],
  activeCompanyMember: true,
};

describe("memory item graph query columns", () => {
  it("omits vector embeddings from graph reads", () => {
    const columns = __companyBrainGraphTest.memoryItemGraphSelectColumnNames();

    expect(columns).toContain("id");
    expect(columns).toContain("title");
    expect(columns).toContain("visibility");
    expect(columns).not.toContain("embedding");
  });
});

describe("canSeeMemoryItemForGraph", () => {
  it("allows company-wide identity memory to active company members", () => {
    const item = memory({
      layer: "identity",
      visibility: "shared",
      departmentId: null,
      projectId: null,
      goalId: null,
      taskId: null,
      sourceArtifactId: null,
      agentId: null,
    });

    expect(canSeeMemoryItemForGraph(item, {
      actorType: "user",
      principalId: "member@example.com",
      role: "team_member",
      departmentIds: [],
      activeCompanyMember: true,
    })).toBe(true);
  });

  it("hides agent-personal memory from unrelated team members", () => {
    const item = memory({ agentId: AGENT_ID });

    expect(canSeeMemoryItemForGraph(item, {
      actorType: "user",
      principalId: "member@example.com",
      role: "team_member",
      departmentIds: [MARKETING_ID],
      activeCompanyMember: true,
    })).toBe(false);
  });

  it("allows the owning agent to see its own personal memory", () => {
    const item = memory({ agentId: AGENT_ID });

    expect(canSeeMemoryItemForGraph(item, {
      actorType: "agent",
      principalId: AGENT_ID,
      role: "team_member",
      departmentIds: [MARKETING_ID],
      activeCompanyMember: true,
    })).toBe(true);
  });
});

describe("buildMemoryItemNeighborGraph", () => {
  it("derives first-hop structural edges from the memory item row", () => {
    const graph = buildMemoryItemNeighborGraph({
      companyId: COMPANY_ID,
      center: memory(),
      actor: founder,
      relatedItems: [],
      semanticEdges: [],
      linked: {
        departments: [{ id: MARKETING_ID, name: "Marketing", type: "department", status: "active" }],
        projects: [{ id: PRODUCT_ID, name: "Pricing App", type: "project", status: "active" }],
        goals: [{ id: GOAL_ID, title: "Launch pricing", status: "active" }],
        tasks: [{ id: TASK_ID, title: "Draft pricing memo", status: "in_progress" }],
        artifacts: [{ id: ARTIFACT_ID, title: "Pricing Memo", status: "active" }],
        agents: [{ id: AGENT_ID, name: "Market Analyst", status: "idle" }],
      },
    });

    expect(graph.center.id).toBe("00000000-0000-0000-0000-000000000901");
    expect(graph.nodes.map((node) => `${node.type}:${node.id}`)).toEqual([
      "memory_item:00000000-0000-0000-0000-000000000901",
      `department:${MARKETING_ID}`,
      `project:${PRODUCT_ID}`,
      `goal:${GOAL_ID}`,
      `task:${TASK_ID}`,
      `artifact:${ARTIFACT_ID}`,
      `agent:${AGENT_ID}`,
    ]);
    expect(graph.edges.map((edge) => edge.kind)).toEqual([
      "belongs_to",
      "belongs_to",
      "applies_to",
      "applies_to",
      "derived_from",
      "created_by",
    ]);
    expect(graph.edges.every((edge) => edge.sourceClass === "derived")).toBe(true);
  });

  it("filters semantic edges unless both endpoints are visible", () => {
    const center = memory({ agentId: null });
    const visible = memory({
      id: "00000000-0000-0000-0000-000000000902",
      title: "Visible decision",
      agentId: null,
    });
    const privateTarget = memory({
      id: "00000000-0000-0000-0000-000000000903",
      title: "Agent private note",
      agentId: AGENT_ID,
    });

    const graph = buildMemoryItemNeighborGraph({
      companyId: COMPANY_ID,
      center,
      actor: {
        actorType: "user",
        principalId: "member@example.com",
        role: "team_member",
        departmentIds: [MARKETING_ID],
        activeCompanyMember: true,
      },
      relatedItems: [visible, privateTarget],
      semanticEdges: [
        {
          id: "rel-visible",
          fromType: "memory_item",
          fromId: center.id,
          toType: "memory_item",
          toId: visible.id,
          kind: "related_to",
          confidence: null,
          evidence: null,
          createdByPrincipalType: "system",
          createdByPrincipalId: "system",
          source: "manual",
          status: "active",
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        },
        {
          id: "rel-private",
          fromType: "memory_item",
          fromId: center.id,
          toType: "memory_item",
          toId: privateTarget.id,
          kind: "related_to",
          confidence: null,
          evidence: null,
          createdByPrincipalType: "system",
          createdByPrincipalId: "system",
          source: "manual",
          status: "active",
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        },
      ],
      linked: {},
    });

    expect(graph.nodes.map((node) => node.id)).toContain(visible.id);
    expect(graph.nodes.map((node) => node.id)).not.toContain(privateTarget.id);
    expect(graph.edges.map((edge) => edge.id)).toEqual(["rel-visible"]);
  });
});

describe("buildCompanyGraphOverview", () => {
  it("shows approved visible memory nodes and semantic edges", () => {
    const first = memory({ id: "00000000-0000-0000-0000-000000000911", title: "Pricing policy", agentId: null });
    const second = memory({ id: "00000000-0000-0000-0000-000000000912", title: "Seat billing", agentId: null });

    const graph = buildCompanyGraphOverview({
      companyId: COMPANY_ID,
      actor: founder,
      memoryItems: [first, second],
      semanticEdges: [
        {
          id: "edge-visible",
          fromType: "memory_item",
          fromId: first.id,
          toType: "memory_item",
          toId: second.id,
          kind: "supports",
          confidence: null,
          evidence: null,
          createdByPrincipalType: "user",
          createdByPrincipalId: "founder@example.com",
          source: "manual",
          status: "active",
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        },
      ],
      linked: {},
      includeStructural: false,
      limit: 100,
    });

    expect(graph.nodes.map((node) => node.label)).toEqual(["Pricing policy", "Seat billing"]);
    expect(graph.edges.map((edge) => edge.id)).toEqual(["edge-visible"]);
    expect(graph.truncated).toBe(false);
  });

  it("hides pending, archived, and scoped-invisible endpoints", () => {
    const visible = memory({ id: "00000000-0000-0000-0000-000000000921", title: "Visible", agentId: null });
    const pending = memory({ id: "00000000-0000-0000-0000-000000000922", title: "Pending", status: "pending", agentId: null });
    const archived = memory({ id: "00000000-0000-0000-0000-000000000923", title: "Archived", status: "archived", agentId: null });
    const privateTarget = memory({
      id: "00000000-0000-0000-0000-000000000924",
      title: "Agent private",
      agentId: AGENT_ID,
    });

    const graph = buildCompanyGraphOverview({
      companyId: COMPANY_ID,
      actor: {
        actorType: "user",
        principalId: "member@example.com",
        role: "team_member",
        departmentIds: [MARKETING_ID],
        activeCompanyMember: true,
      },
      memoryItems: [visible, pending, archived, privateTarget],
      semanticEdges: [
        {
          id: "edge-hidden",
          fromType: "memory_item",
          fromId: visible.id,
          toType: "memory_item",
          toId: privateTarget.id,
          kind: "related_to",
          confidence: null,
          evidence: null,
          createdByPrincipalType: "system",
          createdByPrincipalId: "system",
          source: "manual",
          status: "active",
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
        },
      ],
      linked: {},
      includeStructural: false,
      limit: 100,
    });

    expect(graph.nodes.map((node) => node.label)).toEqual(["Visible"]);
    expect(graph.edges).toEqual([]);
  });

  it("bounds visible memory nodes and reports truncation", () => {
    const rows = [
      memory({ id: "00000000-0000-0000-0000-000000000931", title: "One", agentId: null }),
      memory({ id: "00000000-0000-0000-0000-000000000932", title: "Two", agentId: null }),
      memory({ id: "00000000-0000-0000-0000-000000000933", title: "Three", agentId: null }),
    ];

    const graph = buildCompanyGraphOverview({
      companyId: COMPANY_ID,
      actor: founder,
      memoryItems: rows,
      semanticEdges: [],
      linked: {},
      includeStructural: false,
      limit: 2,
    });

    expect(graph.nodes.map((node) => node.label)).toEqual(["One", "Two"]);
    expect(graph.truncated).toBe(true);
    expect(graph.limit).toBe(2);
  });

  it("can include or exclude structural nodes", () => {
    const center = memory({ agentId: null });

    const withStructural = buildCompanyGraphOverview({
      companyId: COMPANY_ID,
      actor: founder,
      memoryItems: [center],
      semanticEdges: [],
      linked: {
        departments: [{ id: MARKETING_ID, name: "Marketing", type: "department", status: "active" }],
      },
      includeStructural: true,
      limit: 100,
    });
    const withoutStructural = buildCompanyGraphOverview({
      companyId: COMPANY_ID,
      actor: founder,
      memoryItems: [center],
      semanticEdges: [],
      linked: {
        departments: [{ id: MARKETING_ID, name: "Marketing", type: "department", status: "active" }],
      },
      includeStructural: false,
      limit: 100,
    });

    expect(withStructural.nodes.map((node) => `${node.type}:${node.id}`)).toContain(`department:${MARKETING_ID}`);
    expect(withStructural.edges.map((edge) => edge.kind)).toContain("belongs_to");
    expect(withoutStructural.nodes.map((node) => `${node.type}:${node.id}`)).not.toContain(`department:${MARKETING_ID}`);
    expect(withoutStructural.edges).toEqual([]);
  });

  it("includes seeded memory folders even when no memory exists inside them", () => {
    const graph = buildCompanyGraphOverview({
      companyId: COMPANY_ID,
      actor: founder,
      memoryItems: [],
      semanticEdges: [],
      linked: {
        departments: [{ id: MARKETING_ID, name: "Marketing", type: "department", status: "active" }],
        memoryFolders: [
          {
            id: COMPANY_FOLDER_ID,
            displayName: "Company",
            path: "Company",
            departmentId: null,
            seedKey: "company.root",
            sortOrder: 0,
          },
          {
            id: COMPANY_PEOPLE_FOLDER_ID,
            displayName: "People",
            path: "Company/People",
            departmentId: null,
            seedKey: "company.people",
            sortOrder: 50,
          },
          {
            id: MARKETING_FOLDER_ID,
            displayName: "Decisions",
            path: "marketing/Decisions",
            departmentId: MARKETING_ID,
            seedKey: "marketing.decisions",
            sortOrder: 30,
          },
        ],
      },
      includeStructural: true,
      limit: 100,
    });

    expect(graph.nodes.map((node) => `${node.type}:${node.label}`)).toEqual([
      "department:Marketing",
      "memory_folder:Company",
      "memory_folder:People",
      "memory_folder:Decisions",
    ]);
    expect(graph.edges.map((edge) => `${edge.from.type}:${edge.from.id}->${edge.to.type}:${edge.to.id}`)).toEqual([
      `memory_folder:${COMPANY_PEOPLE_FOLDER_ID}->memory_folder:${COMPANY_FOLDER_ID}`,
      `memory_folder:${MARKETING_FOLDER_ID}->department:${MARKETING_ID}`,
    ]);
  });

  it("lets the local board operator see structural department folders", () => {
    const graph = buildCompanyGraphOverview({
      companyId: COMPANY_ID,
      actor: {
        actorType: "user",
        principalId: "local-board",
        role: "team_member",
        departmentIds: [],
        activeCompanyMember: true,
      },
      memoryItems: [],
      semanticEdges: [],
      linked: {
        departments: [{ id: MARKETING_ID, name: "Marketing", type: "department", status: "active" }],
        memoryFolders: [
          {
            id: MARKETING_FOLDER_ID,
            displayName: "Decisions",
            path: "marketing/Decisions",
            departmentId: MARKETING_ID,
            seedKey: "marketing.decisions",
            sortOrder: 30,
          },
        ],
      },
      includeStructural: true,
      limit: 100,
    });

    expect(graph.nodes.map((node) => `${node.type}:${node.label}`)).toEqual([
      "department:Marketing",
      "memory_folder:Decisions",
    ]);
    expect(graph.edges.map((edge) => `${edge.from.type}:${edge.from.id}->${edge.to.type}:${edge.to.id}`))
      .toContain(`memory_folder:${MARKETING_FOLDER_ID}->department:${MARKETING_ID}`);
  });

  it("connects memory items to matching folder nodes", () => {
    const item = memory({
      id: "00000000-0000-0000-0000-000000000941",
      title: "Campaign decision",
      folderPath: "marketing/Decisions",
      agentId: null,
    });

    const graph = buildCompanyGraphOverview({
      companyId: COMPANY_ID,
      actor: founder,
      memoryItems: [item],
      semanticEdges: [],
      linked: {
        departments: [{ id: MARKETING_ID, name: "Marketing", type: "department", status: "active" }],
        memoryFolders: [
          {
            id: MARKETING_FOLDER_ID,
            displayName: "Decisions",
            path: "marketing/Decisions",
            departmentId: MARKETING_ID,
            seedKey: "marketing.decisions",
            sortOrder: 30,
          },
        ],
      },
      includeStructural: true,
      limit: 100,
    });

    expect(graph.nodes.map((node) => `${node.type}:${node.label}`)).toContain("memory_folder:Decisions");
    expect(graph.edges.map((edge) => `${edge.from.type}:${edge.from.id}->${edge.to.type}:${edge.to.id}:${edge.kind}`))
      .toContain(`memory_item:${item.id}->memory_folder:${MARKETING_FOLDER_ID}:belongs_to`);
  });
});

describe("aggregateMemoryUsage", () => {
  it("aggregates retrievals by agent without exposing run rows", () => {
    const usage = __companyBrainGraphTest.aggregateMemoryUsage("item-1", [
      {
        agentId: AGENT_ID,
        agentName: "Memory Keeper",
        taskId: TASK_ID,
        createdAt: new Date("2026-06-02T08:00:00.000Z"),
      },
      {
        agentId: AGENT_ID,
        agentName: "Memory Keeper",
        taskId: TASK_ID,
        createdAt: new Date("2026-06-02T09:00:00.000Z"),
      },
      {
        agentId: AGENT_ID,
        agentName: "Memory Keeper",
        taskId: "00000000-0000-0000-0000-000000000302",
        createdAt: new Date("2026-06-02T07:00:00.000Z"),
      },
    ]);

    expect(usage).toEqual({
      itemId: "item-1",
      agents: [
        {
          agentId: AGENT_ID,
          agentName: "Memory Keeper",
          retrievalCount: 3,
          lastRetrievedAt: "2026-06-02T09:00:00.000Z",
          linkedTaskCount: 2,
        },
      ],
    });
  });
});
