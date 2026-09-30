import { beforeEach, describe, expect, it, vi } from "vitest";

const workingMemoryMocks = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

import {
  commanderWorkingMemoryService,
  defaultWorkingMemoryExpiry,
} from "../services/internal-agent/working-memory.js";

function baseScope(overrides: Record<string, string | null> = {}) {
  return {
    surface: "task",
    route: null,
    departmentId: "dept-1",
    projectId: null,
    goalId: null,
    taskId: "task-1",
    memoryFolderPath: null,
    conversationId: "conv-1",
    ...overrides,
  };
}

beforeEach(() => {
  workingMemoryMocks.create.mockReset();
  workingMemoryMocks.getById.mockReset();
  workingMemoryMocks.update.mockReset();
  workingMemoryMocks.create.mockImplementation(async (_companyId, input) => ({ id: "memory-1", ...input }));
  workingMemoryMocks.update.mockImplementation(async (_companyId, _id, input) => ({ id: _id, ...input }));
  workingMemoryMocks.getById.mockResolvedValue({
    id: "memory-owned-by-user-1",
    source: "commander",
    layer: "working",
    status: "approved",
    createdBy: "user-1",
    departmentId: "dept-1",
    projectId: null,
    goalId: null,
    taskId: "task-1",
    conversationId: "conv-1",
  });
});

describe("Commander working memory", () => {
  it("creates approved scoped working memory attributed to Commander", async () => {
    const service = commanderWorkingMemoryService(workingMemoryMocks);

    const item = await service.remember({
      companyId: "co-1",
      userId: "user-1",
      userRole: "team_member",
      title: "Current onboarding concern",
      content: "User is evaluating UI context.",
      scope: baseScope(),
    });

    expect(workingMemoryMocks.create).toHaveBeenCalledWith("co-1", expect.objectContaining({
      source: "commander",
      status: "approved",
      layer: "working",
      visibility: "scoped",
      createdBy: "user-1",
      conversationId: "conv-1",
      taskId: "task-1",
      folderPath: "Commander/Working",
    }));
    expect(item.expiresAt).toBeTruthy();
  });

  it("uses the 7 day TTL for task-scoped working memory", () => {
    const now = new Date("2026-05-31T00:00:00.000Z");
    const expiresAt = defaultWorkingMemoryExpiry(baseScope({ taskId: "task-1" }), now);
    expect(expiresAt.toISOString()).toBe("2026-06-07T00:00:00.000Z");
  });

  it("uses the 14 day TTL for conversation-scoped working memory", () => {
    const now = new Date("2026-05-31T00:00:00.000Z");
    const expiresAt = defaultWorkingMemoryExpiry(baseScope({ taskId: null, conversationId: "conv-1" }), now);
    expect(expiresAt.toISOString()).toBe("2026-06-14T00:00:00.000Z");
  });

  it("uses the 30 day TTL for project-scoped working memory", () => {
    const now = new Date("2026-05-31T00:00:00.000Z");
    const expiresAt = defaultWorkingMemoryExpiry(baseScope({ taskId: null, conversationId: null, projectId: "project-1" }), now);
    expect(expiresAt.toISOString()).toBe("2026-06-30T00:00:00.000Z");
  });

  it("rejects unscoped working memory for non-founder users", async () => {
    const service = commanderWorkingMemoryService(workingMemoryMocks);

    await expect(service.remember({
      companyId: "co-1",
      userId: "user-1",
      userRole: "team_member",
      title: "Too broad",
      content: "Remember this everywhere.",
      scope: baseScope({ taskId: null, conversationId: null, projectId: null, goalId: null }),
    })).rejects.toThrow(/working memory requires project, goal, task, or conversation scope/i);
  });

  it("allows founder-created company-level working memory with a TTL", async () => {
    const service = commanderWorkingMemoryService(workingMemoryMocks);

    const item = await service.remember({
      companyId: "co-1",
      userId: "founder-1",
      userRole: "founder",
      title: "Temporary company note",
      content: "Keep this visible during the current planning run.",
      scope: baseScope({ taskId: null, conversationId: null, projectId: null, goalId: null }),
    });

    expect(item).toMatchObject({
      source: "commander",
      status: "approved",
      layer: "working",
      visibility: "scoped",
      createdBy: "founder-1",
    });
    expect(item.expiresAt).toBeTruthy();
  });

  it("blocks a team member from updating another user's working memory", async () => {
    const service = commanderWorkingMemoryService(workingMemoryMocks);

    await expect(service.update({
      companyId: "co-1",
      userId: "user-2",
      userRole: "team_member",
      memoryId: "memory-owned-by-user-1",
      content: "overwrite attempt",
      scope: baseScope(),
    })).rejects.toThrow(/not allowed to update this working memory/i);
  });

  it("blocks a team lead from updating working memory outside the current scope", async () => {
    const service = commanderWorkingMemoryService(workingMemoryMocks);

    await expect(service.update({
      companyId: "co-1",
      userId: "lead-1",
      userRole: "team_lead",
      memoryId: "memory-owned-by-user-1",
      content: "cross-scope attempt",
      scope: baseScope({ taskId: "task-2", conversationId: "conv-2" }),
    })).rejects.toThrow(/not allowed to update this working memory/i);
  });

  it("allows a team lead to update working memory in the current scope", async () => {
    const service = commanderWorkingMemoryService(workingMemoryMocks);

    const item = await service.update({
      companyId: "co-1",
      userId: "lead-1",
      userRole: "team_lead",
      memoryId: "memory-owned-by-user-1",
      content: "scope-local update",
      scope: baseScope(),
    });

    expect(item.content).toBe("scope-local update");
  });

  it("blocks a team member from forgetting another user's working memory", async () => {
    const service = commanderWorkingMemoryService(workingMemoryMocks);

    await expect(service.forget({
      companyId: "co-1",
      userId: "user-2",
      userRole: "team_member",
      memoryId: "memory-owned-by-user-1",
      scope: baseScope(),
    })).rejects.toThrow(/not allowed to forget this working memory/i);
  });

  it("archives working memory instead of hard deleting it", async () => {
    const service = commanderWorkingMemoryService(workingMemoryMocks);

    const item = await service.forget({
      companyId: "co-1",
      userId: "user-1",
      userRole: "team_member",
      memoryId: "memory-owned-by-user-1",
      scope: baseScope(),
    });

    expect(workingMemoryMocks.update).toHaveBeenCalledWith("co-1", "memory-owned-by-user-1", { status: "archived" });
    expect(item.status).toBe("archived");
  });
});
