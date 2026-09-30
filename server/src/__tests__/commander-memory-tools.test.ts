import { describe, expect, it, vi } from "vitest";

const memoryToolMocks = vi.hoisted(() => ({
  recordMemoryRetrievals: vi.fn(async () => undefined),
}));

vi.mock("../services/memory-retrieval-audit.js", () => ({
  recordMemoryRetrievals: memoryToolMocks.recordMemoryRetrievals,
}));

// DAT-007: query_memory now threads the enterprise RBAC gate for agent actors
// (actorForAgentRun + memoryAccessConditions), which touch the DB. These stubs
// keep this unit file DB-free — the gate's own row-level correctness is proven
// in memory-tools-agent-rbac.{unit,integration}.test.ts. Non-agent tests here
// never invoke either (the gate is `actorType==="agent" && agentId` only).
vi.mock("../services/memory-access-sql.js", () => ({
  actorForAgentRun: vi.fn(async (_db: unknown, _companyId: string, agentId: string) => ({
    kind: "agent",
    agentId,
    departmentIds: [],
  })),
  memoryAccessConditions: vi.fn(() => []),
}));

import { createMemoryTools } from "../services/internal-agent/tools/memory-tools.js";

function buildCtx(memory: Record<string, unknown>) {
  return {
    companyId: "company-1",
    userId: "user-1",
    userRole: "team_member",
    enabledCapabilities: ["memory_management"],
    db: {},
    runId: "run-1",
    contextScope: {
      surface: "task",
      route: null,
      departmentId: "dept-1",
      projectId: null,
      goalId: null,
      taskId: "task-1",
      memoryFolderPath: null,
      conversationId: "conv-1",
    },
    services: { memory },
  } as any;
}

describe("Commander memory tools", () => {
  it("query_memory uses searchMultiPath for text queries", async () => {
    const memory = {
      searchMultiPath: vi.fn(async () => [{
        id: "m1",
        title: "Refund policy",
        content: "30 days",
        layer: "domain",
        status: "approved",
        visibility: "scoped",
        departmentId: "dept-1",
        taskId: null,
        expiresAt: null,
        createdBy: "founder-1",
        similarity: 0.9,
      }]),
      list: vi.fn(async () => []),
    };
    const tool = createMemoryTools().find((candidate) => candidate.name === "query_memory")!;

    const result = await tool.execute({ query: "refunds", limit: 5 }, buildCtx(memory));

    expect(memory.searchMultiPath).toHaveBeenCalledWith("company-1", "refunds", { limit: 5 });
    expect(result.success).toBe(true);
    expect(result.data).toEqual([
      expect.objectContaining({ id: "m1" }),
    ]);
    expect(memoryToolMocks.recordMemoryRetrievals).toHaveBeenCalledWith({}, {
      companyId: "company-1",
      agentId: null,
      runId: "run-1",
      taskId: "task-1",
      conversationId: "conv-1",
      triggeredBy: "commander_query",
      query: "refunds",
      items: [{ id: "m1", rank: 1, similarityScore: 0.9, shownToAgent: true }],
    });
  });

  it("query_memory hides pending and cross-scope results while auditing them", async () => {
    memoryToolMocks.recordMemoryRetrievals.mockClear();
    const memory = {
      searchMultiPath: vi.fn(async () => [
        {
          id: "shown",
          title: "Task memory",
          content: "Current task",
          layer: "working",
          status: "approved",
          visibility: "scoped",
          taskId: "task-1",
          expiresAt: null,
          createdBy: "user-1",
        },
      ]),
      searchAuditCandidates: vi.fn(async () => [
        {
          id: "pending",
          title: "Pending",
          content: "Do not show",
          layer: "domain",
          status: "pending",
          visibility: "shared",
          expiresAt: null,
          createdBy: "founder-1",
        },
        {
          id: "other-task",
          title: "Other task",
          content: "Do not show",
          layer: "working",
          status: "approved",
          visibility: "scoped",
          taskId: "task-2",
          expiresAt: null,
          createdBy: "user-2",
        },
      ]),
      list: vi.fn(async () => []),
    };
    const tool = createMemoryTools().find((candidate) => candidate.name === "query_memory")!;

    const result = await tool.execute({ query: "task", limit: 10 }, buildCtx(memory));

    expect(result.data).toEqual([expect.objectContaining({ id: "shown" })]);
    expect(memory.searchAuditCandidates).toHaveBeenCalledWith("company-1", "task", { limit: 50 });
    expect(memoryToolMocks.recordMemoryRetrievals).toHaveBeenCalledWith({}, expect.objectContaining({
      triggeredBy: "commander_query",
      items: [
        { id: "shown", rank: 1, similarityScore: null, shownToAgent: true },
        { id: "pending", rank: 2, similarityScore: null, shownToAgent: false },
        { id: "other-task", rank: 3, similarityScore: null, shownToAgent: false },
      ],
    }));
  });

  it("query_memory audits layer browsing without a text query", async () => {
    memoryToolMocks.recordMemoryRetrievals.mockClear();
    const memory = {
      searchMultiPath: vi.fn(async () => []),
      list: vi.fn(async () => [
        {
          id: "shown",
          title: "Task memory",
          content: "Current task",
          layer: "working",
          status: "approved",
          visibility: "scoped",
          taskId: "task-1",
          expiresAt: null,
          createdBy: "user-1",
        },
        {
          id: "other-task",
          title: "Other task",
          content: "Do not show",
          layer: "working",
          status: "approved",
          visibility: "scoped",
          taskId: "task-2",
          expiresAt: null,
          createdBy: "user-2",
        },
      ]),
    };
    const tool = createMemoryTools().find((candidate) => candidate.name === "query_memory")!;

    const result = await tool.execute({ layer: "working", limit: 5 }, buildCtx(memory));

    expect(result.data).toEqual([expect.objectContaining({ id: "shown" })]);
    expect(memoryToolMocks.recordMemoryRetrievals).toHaveBeenCalledWith({}, expect.objectContaining({
      triggeredBy: "commander_query",
      query: null,
      items: [
        { id: "shown", rank: 1, similarityScore: null, shownToAgent: true },
        { id: "other-task", rank: 2, similarityScore: null, shownToAgent: false },
      ],
    }));
  });

  it("query_memory lets an agent browse identity memory without query text", async () => {
    const memory = {
      list: vi.fn(async () => [
        {
          id: "identity-1",
          title: "Company Vision",
          content: "Build the company brain",
          layer: "identity",
          status: "approved",
          visibility: "company",
          expiresAt: null,
          createdBy: "system",
        },
      ]),
    };
    const tool = createMemoryTools().find((candidate) => candidate.name === "query_memory")!;
    const ctx = { ...buildCtx(memory), actorType: "agent", agentId: "agent-1" };

    const result = await tool.execute({ layer: "identity" }, ctx);

    expect(result.data).toEqual([expect.objectContaining({ id: "identity-1" })]);
  });

  it("suggest_memory attributes durable proposals to Commander while keeping approval pending", async () => {
    const memory = {
      create: vi.fn(async (_companyId, input) => ({ id: "m2", ...input })),
    };
    const tool = createMemoryTools().find((candidate) => candidate.name === "suggest_memory")!;

    await tool.execute({
      title: "Positioning",
      content: "Enterprise-grade recall matters.",
      layer: "domain",
    }, buildCtx(memory));

    expect(memory.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      source: "commander",
      status: "pending",
    }));
  });
});
