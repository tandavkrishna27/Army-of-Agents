import { describe, expect, it, vi } from "vitest";
import { createActionTools } from "../services/internal-agent/tools/action-tools.js";
import type { ServiceContainer, ToolContext } from "../services/internal-agent/types.js";

function mockServices(): ServiceContainer {
  return {
    issues: {
      create: vi.fn().mockResolvedValue({ id: "task-1", title: "Launch plan" }),
      update: vi.fn().mockResolvedValue({ id: "task-1", title: "Launch plan" }),
    } as any,
    goals: { create: vi.fn() } as any,
    agents: { create: vi.fn(), update: vi.fn() } as any,
    projects: { create: vi.fn() } as any,
    companies: { update: vi.fn() } as any,
    heartbeat: { wakeup: vi.fn() } as any,
    memory: {} as any,
    discussions: {} as any,
    dependencies: {} as any,
    suggestions: {} as any,
    notifications: {} as any,
    secrets: {} as any,
    artifacts: {} as any,
    costs: {} as any,
    activity: {} as any,
    workflows: null,
    humanContext: {} as any,
    humanDiscovery: {} as any,
    team: {} as any,
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

describe("Action Tools", () => {
  it("create_task schema exposes responsibleUserId as accountable human distinct from executor assignee", () => {
    const createTask = createActionTools().find((tool) => tool.name === "create_task")!;
    const properties = createTask.parameters.properties as Record<string, any>;

    expect(properties.responsibleUserId).toBeDefined();
    expect(properties.responsibleUserId.type).toBe("string");
    expect(properties.responsibleUserId.description).toMatch(/human accountable/i);
    expect(properties.responsibleUserId.description).toMatch(/outcome/i);
    expect(properties.responsibleUserId.description).toMatch(/separate from.*executor assignee/i);
    expect(properties.assigneeType).toBeDefined();
    expect(properties.assigneeType.enum).toEqual(["agent", "user"]);
    expect(properties.assigneeId.description).toMatch(/assignee id/i);
  });

  it("assign_task requires explicit assigneeType because agent and human ids share one field", () => {
    const assignTask = createActionTools().find((tool) => tool.name === "assign_task")!;

    expect(assignTask.parameters.required).toEqual(["taskId", "assigneeType", "assigneeId"]);
  });

  it("create_task passes responsibleUserId through to the issue service when provided", async () => {
    const services = mockServices();
    const ctx = makeCtx(services);
    const createTask = createActionTools().find((tool) => tool.name === "create_task")!;

    await createTask.execute(
      {
        title: "Launch plan",
        assigneeType: "agent",
        assigneeId: "agent-1",
        responsibleUserId: "user-owner",
      },
      ctx,
    );

    expect(services.issues.create).toHaveBeenCalledWith(
      "comp-1",
      expect.objectContaining({
        title: "Launch plan",
        assigneeAgentId: "agent-1",
        responsibleUserId: "user-owner",
      }),
    );
  });

  it("create_task passes the current user as responsible fallback for unassigned tasks", async () => {
    const services = mockServices();
    const ctx = makeCtx(services);
    const createTask = createActionTools().find((tool) => tool.name === "create_task")!;

    await createTask.execute(
      {
        title: "Unassigned commander task",
      },
      ctx,
    );

    expect(services.issues.create).toHaveBeenCalledWith(
      "comp-1",
      expect.objectContaining({
        title: "Unassigned commander task",
        responsibleFallbackUserId: "user-1",
      }),
    );
  });

  it("create_task can create a human-assigned task and clears agent assignee", async () => {
    const services = mockServices();
    const ctx = makeCtx(services);
    const createTask = createActionTools().find((tool) => tool.name === "create_task")!;

    await createTask.execute(
      {
        title: "Human follow-up",
        assigneeType: "user",
        assigneeId: "user-2",
      },
      ctx,
    );

    expect(services.issues.create).toHaveBeenCalledWith(
      "comp-1",
      expect.objectContaining({
        assigneeAgentId: null,
        assigneeUserId: "user-2",
      }),
    );
  });

  it("create_task rejects assigneeId without assigneeType instead of assuming agent", async () => {
    const services = mockServices();
    const ctx = makeCtx(services);
    const createTask = createActionTools().find((tool) => tool.name === "create_task")!;

    const result = await createTask.execute(
      {
        title: "Ambiguous task",
        assigneeId: "user-or-agent",
      },
      ctx,
    );

    expect(result).toMatchObject({
      success: false,
      error: "assigneeType is required when assigneeId is provided",
    });
    expect(services.issues.create).not.toHaveBeenCalled();
  });

  it("assign_task can assign a task to a human and clears agent assignee", async () => {
    const services = mockServices();
    const ctx = makeCtx(services);
    const assignTask = createActionTools().find((tool) => tool.name === "assign_task")!;

    await assignTask.execute(
      {
        taskId: "task-1",
        assigneeType: "user",
        assigneeId: "user-2",
      },
      ctx,
    );

    expect(services.issues.update).toHaveBeenCalledWith("task-1", {
      assigneeAgentId: null,
      assigneeUserId: "user-2",
    });
  });

  it("assign_task rejects missing assigneeType before updating a task", async () => {
    const services = mockServices();
    const ctx = makeCtx(services);
    const assignTask = createActionTools().find((tool) => tool.name === "assign_task")!;

    const result = await assignTask.execute(
      {
        taskId: "task-1",
        assigneeId: "user-or-agent",
      },
      ctx,
    );

    expect(result).toMatchObject({
      success: false,
      error: "assigneeType must be agent or user",
    });
    expect(services.issues.update).not.toHaveBeenCalled();
  });

  it("update_task schema exposes responsibleUserId and documents that null clears it", () => {
    const updateTask = createActionTools().find((tool) => tool.name === "update_task")!;
    const properties = updateTask.parameters.properties as Record<string, any>;

    expect(updateTask.requiredRole).toBe("team_lead");
    expect(updateTask.description).not.toMatch(/executor assignee/i);
    expect(updateTask.description).toMatch(/assign_task.*assignee reassignment/i);
    expect(properties.responsibleUserId).toBeDefined();
    expect(properties.responsibleUserId.type).toEqual(["string", "null"]);
    expect(properties.responsibleUserId.description).toMatch(/human accountable/i);
    expect(properties.responsibleUserId.description).toMatch(/null clears/i);
  });

  it("update_task preserves explicit responsibleUserId null when clearing the responsible human", async () => {
    const services = mockServices();
    const ctx = makeCtx(services);
    const updateTask = createActionTools().find((tool) => tool.name === "update_task")!;

    await updateTask.execute(
      {
        taskId: "task-1",
        responsibleUserId: null,
      },
      ctx,
    );

    expect(services.issues.update).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        responsibleUserId: null,
      }),
    );
  });

  it("update_task only forwards documented update fields to the issue service", async () => {
    const services = mockServices();
    const ctx = makeCtx(services);
    const updateTask = createActionTools().find((tool) => tool.name === "update_task")!;

    await updateTask.execute(
      {
        taskId: "task-1",
        title: "Updated launch plan",
        status: "in_progress",
        priority: "high",
        responsibleUserId: "user-owner",
        assigneeAgentId: "agent-should-not-forward",
        departmentId: "dept-should-not-forward",
      },
      ctx,
    );

    expect(services.issues.update).toHaveBeenCalledWith("task-1", {
      title: "Updated launch plan",
      status: "in_progress",
      priority: "high",
      responsibleUserId: "user-owner",
    });
  });
});
