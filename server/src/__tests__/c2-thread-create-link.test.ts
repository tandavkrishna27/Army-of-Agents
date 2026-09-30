// server/src/__tests__/c2-thread-create-link.test.ts
//
// Task C2 batch 1 — thread.createLink tool tests.
// Verifies valid-kind persistence + invalid-kind rejection + param checks.

import { describe, expect, it, vi } from "vitest";
import { threadCreateLinkTool } from "../services/internal-agent/tools/thread-create-link.js";
import type { ToolContext } from "../services/internal-agent/types.js";

function makeDb(returningRows: any[] = [{ id: "link-1" }], endpointRows: any[] = [{ id: "t-1" }, { id: "t-2" }]) {
  const returning = vi.fn().mockResolvedValue(returningRows);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(endpointRows) }),
  });
  return { db: { select, insert } as any, valuesMock: values };
}

function makeCtx(db: any): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    agentId: "agent-7",
    db,
    services: {} as any,
  } as unknown as ToolContext;
}

describe("thread.createLink tool (C2 batch 1)", () => {
  it("metadata: name, category=action, requiredRole=team_member, no confirmation", () => {
    expect(threadCreateLinkTool.name).toBe("thread.createLink");
    expect(threadCreateLinkTool.category).toBe("action");
    expect(threadCreateLinkTool.requiredRole).toBe("team_member");
    expect(threadCreateLinkTool.requiresConfirmation).toBe(false);
  });

  it("persists a valid link with companyId and agentId attribution", async () => {
    const { db, valuesMock } = makeDb([{ id: "link-1" }]);
    const ctx = makeCtx(db);
    const result = await threadCreateLinkTool.execute(
      { fromId: "t-1", toId: "t-2", kind: "spinoff" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).id).toBe("link-1");
    expect(valuesMock).toHaveBeenCalledOnce();
    const insertedValues = valuesMock.mock.calls[0][0];
    expect(insertedValues).toMatchObject({
      companyId: "co-1",
      fromThreadId: "t-1",
      toThreadId: "t-2",
      kind: "spinoff",
      createdBy: "agent-7",
    });
  });

  it("falls back to 'aoa-agent' for createdBy when ctx.agentId is absent", async () => {
    const { db, valuesMock } = makeDb();
    const ctx = makeCtx(db);
    delete (ctx as any).agentId;
    await threadCreateLinkTool.execute(
      { fromId: "t-1", toId: "t-2", kind: "link" },
      ctx,
    );
    const insertedValues = valuesMock.mock.calls[0][0];
    expect(insertedValues.createdBy).toBe("aoa-agent");
  });

  it.each([
    "link",
    "spinoff",
    "fork",
    "merge",
    "goal_cluster",
    "spawned_from_task",
  ])("accepts kind=%s", async (kind) => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await threadCreateLinkTool.execute(
      { fromId: "t-1", toId: "t-2", kind },
      ctx,
    );
    expect(result.success).toBe(true);
  });

  it("rejects invalid kind with INVALID_KIND error", async () => {
    const { db, valuesMock } = makeDb();
    const ctx = makeCtx(db);
    const result = await threadCreateLinkTool.execute(
      { fromId: "t-1", toId: "t-2", kind: "bogus" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_KIND");
    expect(valuesMock).not.toHaveBeenCalled();
  });

  it("rejects missing fromId with INVALID_PARAMS", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await threadCreateLinkTool.execute(
      { toId: "t-2", kind: "link" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("rejects missing toId with INVALID_PARAMS", async () => {
    const { db } = makeDb();
    const ctx = makeCtx(db);
    const result = await threadCreateLinkTool.execute(
      { fromId: "t-1", kind: "link" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it.each([
    ["foreign source", [{ id: "t-2" }]],
    ["foreign target", [{ id: "t-1" }]],
    ["both foreign", []],
  ])("fails closed when %s is outside the company", async (_label, endpointRows) => {
    const { db, valuesMock } = makeDb([{ id: "link-1" }], endpointRows);
    const result = await threadCreateLinkTool.execute(
      { fromId: "t-1", toId: "t-2", kind: "link" }, makeCtx(db),
    );
    expect(result).toMatchObject({ success: false, error: "NOT_FOUND" });
    expect(valuesMock).not.toHaveBeenCalled();
  });
});
