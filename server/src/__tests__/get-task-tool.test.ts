// server/src/__tests__/get-task-tool.test.ts
//
// Task 2 (Spec B) — `get_task` tool tests.
//
// The tool lets a crew agent read its assigned task's full context. It loads
// the issue via ctx.services.issues.getById (which has NO company filter) and
// MUST itself enforce row.companyId === ctx.companyId, returning not-found on
// mismatch so a crew agent can never read another company's task.
//
// Test plan:
//   - metadata: name=get_task, category=query (confers no capability → does not
//     widen system_actions), requiredRole, no confirmation.
//   - param validation: missing/invalid taskId → INVALID_PARAMS.
//   - (a) returns the task for a same-company task.
//   - (b) returns not-found for a different-company task (companyId mismatch) —
//     and getById's row is NOT leaked in data.
//   - (c) returns not-found for a missing task (getById → null).

import { describe, expect, it, vi } from "vitest";

import { getTaskTool } from "../services/internal-agent/tools/get-task-tool.js";
import { createToolRegistry } from "../services/internal-agent/tool-registry.js";
import { authorizeToolInvocation } from "../services/internal-agent/authorize-tool.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// ─── Constants ─────────────────────────────────────────────────────────────────
const CO_ID = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa";
const OTHER_CO_ID = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb";
const TASK_ID = "cccccccc-0000-4000-8000-cccccccccccc";
const AGENT_ID = "dddddddd-0000-4000-8000-dddddddddddd";

// A representative enriched issue row (mirrors issueService.getById's shape —
// full `issues` columns + labels).
function makeIssueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TASK_ID,
    companyId: CO_ID,
    identifier: "ENG-42",
    title: "Implement the widget",
    description: "Build the thing per the spec.",
    status: "in_progress",
    priority: "high",
    projectId: "proj-1",
    goalId: "goal-1",
    sourceDiscussionId: "thread-9",
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    responsibleUserId: "user-owner",
    executionWorkspaceId: "ws-1",
    executionWorkspacePreference: "isolated_workspace",
    labels: [],
    ...overrides,
  };
}

// Build a ToolContext whose services.issues.getById resolves to `row`.
function makeCtx(
  getByIdResult: Record<string, unknown> | null,
  overrides: Partial<ToolContext> = {},
): { ctx: ToolContext; getById: ReturnType<typeof vi.fn> } {
  const getById = vi.fn().mockResolvedValue(getByIdResult);
  const ctx = {
    companyId: CO_ID,
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: [],
    agentId: AGENT_ID,
    db: {} as any,
    services: { issues: { getById } } as any,
    ...overrides,
  } as unknown as ToolContext;
  return { ctx, getById };
}

// ═════════════════════════════════════════════════════════════════════════════
// Metadata
// ═════════════════════════════════════════════════════════════════════════════

describe("get_task tool — metadata", () => {
  it("name=get_task, category=query, no confirmation", () => {
    expect(getTaskTool.name).toBe("get_task");
    // category MUST be 'query' — query confers no capability, so it does not
    // widen system_actions for the calling agent.
    expect(getTaskTool.category).toBe("query");
    expect(getTaskTool.requiresConfirmation).toBe(false);
  });

  it("is discoverable in the tool registry", () => {
    const tools = createToolRegistry();
    const found = tools.find((t) => t.name === "get_task");
    expect(found).toBeDefined();
    expect(found!.category).toBe("query");
  });

  it("query category does NOT require the system_actions capability (no widening)", () => {
    // A non-AoA caller with NO capabilities can still invoke get_task because
    // `query` is not in CAPABILITY_TO_CATEGORY. This is the security property
    // behind choosing `query` over `action`: exposing get_task does not grant
    // the agent any capability it would not otherwise have.
    const decision = authorizeToolInvocation(getTaskTool, "team_member", [], {});
    expect(decision.allowed).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Param validation
// ═════════════════════════════════════════════════════════════════════════════

describe("get_task tool — param validation", () => {
  it("returns INVALID_PARAMS when taskId is missing", async () => {
    const { ctx, getById } = makeCtx(makeIssueRow());
    const result = await getTaskTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(result.summary).toContain("taskId");
    expect(getById).not.toHaveBeenCalled();
  });

  it("returns INVALID_PARAMS when taskId is not a string", async () => {
    const { ctx } = makeCtx(makeIssueRow());
    const result = await getTaskTool.execute({ taskId: 123 as any }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (a) same-company task → returned
// ═════════════════════════════════════════════════════════════════════════════

describe("get_task tool — same-company task", () => {
  it("returns the task's key fields for a same-company task", async () => {
    const { ctx, getById } = makeCtx(makeIssueRow());
    const result = await getTaskTool.execute({ taskId: TASK_ID }, ctx);

    expect(getById).toHaveBeenCalledWith(TASK_ID);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.id).toBe(TASK_ID);
    expect(data.identifier).toBe("ENG-42");
    expect(data.title).toBe("Implement the widget");
    expect(data.description).toBe("Build the thing per the spec.");
    expect(data.status).toBe("in_progress");
    expect(data.priority).toBe("high");
    expect(data.sourceDiscussionId).toBe("thread-9");
    expect(data.assigneeAgentId).toBe(AGENT_ID);
    expect(data.assigneeUserId).toBeNull();
    expect(data.responsibleUserId).toBe("user-owner");
    expect(data.executionWorkspaceId).toBe("ws-1");
    expect(result.summary).toContain("ENG-42");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (b) different-company task → not found (company-scope enforcement)
// ═════════════════════════════════════════════════════════════════════════════

describe("get_task tool — different-company task (companyId mismatch)", () => {
  it("returns NOT_FOUND and does not leak the row when companyId differs", async () => {
    // getById has NO company filter — it returns the other company's row.
    const { ctx } = makeCtx(makeIssueRow({ companyId: OTHER_CO_ID }));
    const result = await getTaskTool.execute({ taskId: TASK_ID }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(result.data).toBeNull();
    // The mismatched row's fields must NOT appear anywhere in the result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ENG-42");
    expect(serialized).not.toContain(OTHER_CO_ID);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (c) missing task → not found
// ═════════════════════════════════════════════════════════════════════════════

describe("get_task tool — different assignee", () => {
  it("returns NOT_FOUND when another organization agent owns the task", async () => {
    const { ctx } = makeCtx(makeIssueRow({ assigneeAgentId: "agent-other" }));
    const result = await getTaskTool.execute({ taskId: TASK_ID }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(result.data).toBeNull();
  });
});

describe("get_task tool — missing task", () => {
  it("returns NOT_FOUND when getById resolves null", async () => {
    const { ctx, getById } = makeCtx(null);
    const result = await getTaskTool.execute({ taskId: TASK_ID }, ctx);

    expect(getById).toHaveBeenCalledWith(TASK_ID);
    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
    expect(result.data).toBeNull();
  });
});
