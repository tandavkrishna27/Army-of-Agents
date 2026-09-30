// server/src/__tests__/c2-workspace-request-for-thread.test.ts
//
// Task C2 batch 2 — request_thread_workspace tool tests.
// Verifies: creates workspace with the right XOR shape (threadId set,
// sourceIssueId explicitly null), idempotent reuse for an existing active
// workspace, NO_PROJECT error when the thread isn't project-scoped, NOT_FOUND
// error when the thread doesn't exist, and param validation.

import { describe, expect, it, vi } from "vitest";
import { requestThreadWorkspaceTool } from "../services/internal-agent/tools/workspace-request-for-thread.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// The tool issues up to four queries in order:
//   1. SELECT ... FROM discussions WHERE id = ? LIMIT 1
//   2. SELECT ... FROM projects WHERE id/company = ? LIMIT 1
//   3. SELECT ... FROM execution_workspaces WHERE ... LIMIT 1
//   4. INSERT INTO execution_workspaces ... RETURNING
// We sequence the select results by call ordinal.
function makeDb(opts: {
  threadRows?: any[];
  projectRows?: any[];
  existingWorkspaceRows?: any[];
  insertedWorkspaceRows?: any[];
}) {
  let selectCallNo = 0;
  const select = vi.fn(() => {
    selectCallNo++;
    if (selectCallNo === 1) {
      // discussions lookup
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(opts.threadRows ?? []),
          }),
        }),
      };
    }
    if (selectCallNo === 2) {
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(opts.projectRows ?? [{ id: "proj-1" }]),
          }),
        }),
      };
    }
    // execution_workspaces lookup
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(opts.existingWorkspaceRows ?? []),
        }),
      }),
    };
  });

  const insertedValuesCapture: { values?: any } = {};
  const insertReturning = vi
    .fn()
    .mockResolvedValue(opts.insertedWorkspaceRows ?? [{ id: "ws-new" }]);
  const insertValues = vi.fn((vals: any) => {
    insertedValuesCapture.values = vals;
    return { returning: insertReturning };
  });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  return { db: { select, insert } as any, insertedValuesCapture, insertValues };
}

function makeCtx(db: any): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    agentId: "agent-eng",
    db,
    services: {} as any,
  } as unknown as ToolContext;
}

describe("request_thread_workspace tool (C2 batch 2)", () => {
  it("metadata: name, category=action, requiredRole=team_member, requires confirmation", () => {
    expect(requestThreadWorkspaceTool.name).toBe("request_thread_workspace");
    expect(requestThreadWorkspaceTool.category).toBe("action");
    expect(requestThreadWorkspaceTool.requiredRole).toBe("team_member");
    expect(requestThreadWorkspaceTool.requiresConfirmation).toBe(true);
  });

  it("creates a workspace with the XOR shape (threadId set, sourceIssueId null)", async () => {
    const { db, insertedValuesCapture } = makeDb({
      threadRows: [{ id: "thread-1", scopeType: "project", scopeId: "proj-1" }],
      existingWorkspaceRows: [],
      insertedWorkspaceRows: [{ id: "ws-new" }],
    });
    const ctx = makeCtx(db);
    const result = await requestThreadWorkspaceTool.execute(
      { threadId: "thread-1" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).workspaceId).toBe("ws-new");
    expect((result.data as any).reused).toBe(false);
    // XOR invariant: threadId set, sourceIssueId explicitly null.
    expect(insertedValuesCapture.values).toMatchObject({
      companyId: "co-1",
      projectId: "proj-1",
      threadId: "thread-1",
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "project_primary",
      status: "active",
    });
    // Auto-generated name based on threadId prefix
    expect(insertedValuesCapture.values.name).toContain("thread-");
  });

  it("idempotent: returns existing active workspace without inserting", async () => {
    const { db, insertValues } = makeDb({
      threadRows: [{ id: "thread-1", scopeType: "project", scopeId: "proj-1" }],
      existingWorkspaceRows: [{ id: "ws-existing", status: "active" }],
    });
    const ctx = makeCtx(db);
    const result = await requestThreadWorkspaceTool.execute(
      { threadId: "thread-1" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).workspaceId).toBe("ws-existing");
    expect((result.data as any).reused).toBe(true);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("creates a new workspace when the only existing one is archived", async () => {
    const { db, insertValues } = makeDb({
      threadRows: [{ id: "thread-1", scopeType: "project", scopeId: "proj-1" }],
      // Archived rows should not block creation.
      existingWorkspaceRows: [{ id: "ws-old", status: "archived" }],
      insertedWorkspaceRows: [{ id: "ws-new" }],
    });
    const ctx = makeCtx(db);
    const result = await requestThreadWorkspaceTool.execute(
      { threadId: "thread-1" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).reused).toBe(false);
    expect(insertValues).toHaveBeenCalledOnce();
  });

  it("returns NO_PROJECT when the thread isn't project-scoped", async () => {
    const { db, insertValues } = makeDb({
      threadRows: [
        { id: "thread-1", scopeType: "department", scopeId: "dept-1" },
      ],
    });
    const ctx = makeCtx(db);
    const result = await requestThreadWorkspaceTool.execute(
      { threadId: "thread-1" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("NO_PROJECT");
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("returns NO_PROJECT when scopeId is null", async () => {
    const { db } = makeDb({
      threadRows: [{ id: "thread-1", scopeType: "project", scopeId: null }],
    });
    const ctx = makeCtx(db);
    const result = await requestThreadWorkspaceTool.execute(
      { threadId: "thread-1" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("NO_PROJECT");
  });

  it("returns NOT_FOUND when the thread doesn't exist", async () => {
    const { db } = makeDb({ threadRows: [] });
    const ctx = makeCtx(db);
    const result = await requestThreadWorkspaceTool.execute(
      { threadId: "missing" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
  });

  it("returns NOT_FOUND for a thread outside the caller company", async () => {
    const { db, insertValues } = makeDb({ threadRows: [] });
    const result = await requestThreadWorkspaceTool.execute({ threadId: "foreign-thread" }, makeCtx(db));
    expect(result).toMatchObject({ success: false, error: "NOT_FOUND" });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("returns NO_PROJECT for a project outside the caller company", async () => {
    const { db, insertValues } = makeDb({
      threadRows: [{ id: "thread-1", scopeType: "project", scopeId: "foreign-project" }],
      projectRows: [],
    });
    const result = await requestThreadWorkspaceTool.execute({ threadId: "thread-1" }, makeCtx(db));
    expect(result).toMatchObject({ success: false, error: "NO_PROJECT" });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("returns INVALID_PARAMS when threadId is missing", async () => {
    const { db } = makeDb({});
    const ctx = makeCtx(db);
    const result = await requestThreadWorkspaceTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });
});
