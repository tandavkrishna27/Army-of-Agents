// B2 port — Approval-family oversight tools for Commander (Plan 3, Task 2).
//
// Mock style mirrors artifact-create-version-delegates.test.ts: ctx.services
// is a hand-built stub (approvalService / issueApprovalService are NOT
// exercised for real — only their public shape). The tool module itself also
// reaches directly for logActivity + the hub-sync helpers (NOT through
// ctx.services), so those three collaborator modules are mocked at the
// import path the tool uses, keeping this test hermetic (no real db/drizzle
// touched — see CLAUDE.md's drizzle-orm ESM cycle workaround note).
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logActivity: vi.fn(),
  emitHubItem: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("../../../activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

vi.mock("../../../hub-items.js", () => ({
  hubItemsService: () => ({ reconcile: mocks.reconcile }),
}));

vi.mock("../../../hub-source-producers.js", () => ({
  buildApprovalHubEmit: (approval: unknown) => approval,
  emitHubItem: mocks.emitHubItem,
}));

import { approvalTools } from "../approval-tools.js";

const byName = Object.fromEntries(approvalTools.map((t) => [t.name, t]));

function ctx(overrides: any = {}) {
  return {
    companyId: "c1",
    userId: "u1",
    userRole: "founder",
    db: {},
    services: {
      approvals: {
        list: vi.fn().mockResolvedValue([{ id: "a1", companyId: "c1", status: "pending", type: "crew_dispatch" }]),
        getById: vi.fn().mockResolvedValue({ id: "a1", companyId: "c1", status: "pending" }),
        listComments: vi.fn().mockResolvedValue([]),
        approve: vi.fn().mockResolvedValue({ id: "a1", companyId: "c1", status: "approved" }),
        reject: vi.fn(),
        requestRevision: vi.fn(),
        resubmit: vi.fn(),
      },
      issueApprovals: { listIssuesForApproval: vi.fn().mockResolvedValue([{ issueId: "t1", projectId: "p1" }]) },
    },
    ...overrides,
  } as any;
}

describe("approval-tools (B2 port)", () => {
  it("exports exactly the 5 ported tools, all founder-only", () => {
    const names = approvalTools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["approval_decision", "get_approval", "get_approval_tasks", "list_approval_comments", "list_approvals"].sort(),
    );
    for (const tool of approvalTools) {
      expect(tool.requiredRole).toBe("founder");
    }
  });

  it("list_approvals returns the company's approvals", async () => {
    const res = await byName.list_approvals.execute({ status: "pending" }, ctx());
    expect(res.success).toBe(true);
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("get_approval returns NOT_FOUND for a cross-company approval", async () => {
    const c = ctx();
    c.services.approvals.getById.mockResolvedValue({ id: "a1", companyId: "other", status: "pending" });
    const res = await byName.get_approval.execute({ approvalId: "a1" }, c);
    expect(res.success).toBe(false);
    expect(res.error).toBe("NOT_FOUND");
  });

  it("get_approval_tasks returns linked tasks for an owned approval", async () => {
    const c = ctx();
    const res = await byName.get_approval_tasks.execute({ approvalId: "a1" }, c);
    expect(res.success).toBe(true);
    expect(c.services.issueApprovals.listIssuesForApproval).toHaveBeenCalledWith("a1");
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("list_approval_comments returns comments for an owned approval", async () => {
    const c = ctx();
    const res = await byName.list_approval_comments.execute({ approvalId: "a1" }, c);
    expect(res.success).toBe(true);
    expect(c.services.approvals.listComments).toHaveBeenCalledWith("a1");
  });

  it("approval_decision approve calls approvals.approve with company + user", async () => {
    const c = ctx();
    const res = await byName.approval_decision.execute({ approvalId: "a1", action: "approve" }, c);
    expect(c.services.approvals.approve).toHaveBeenCalledWith("a1", "c1", "u1", null);
    expect(res.success).toBe(true);
  });

  it("approval_decision rejects a cross-company approval before mutating", async () => {
    const c = ctx();
    c.services.approvals.getById.mockResolvedValue({ id: "a1", companyId: "other", status: "pending" });
    const res = await byName.approval_decision.execute({ approvalId: "a1", action: "approve" }, c);
    expect(res.error).toBe("NOT_FOUND");
    expect(c.services.approvals.approve).not.toHaveBeenCalled();
  });

  it("approval_decision logs activity + syncs the hub item on success", async () => {
    const c = ctx();
    await byName.approval_decision.execute({ approvalId: "a1", action: "approve" }, c);
    expect(mocks.logActivity).toHaveBeenCalledWith(
      c.db,
      expect.objectContaining({ companyId: "c1", actorId: "u1", action: "approval.approve", entityId: "a1" }),
    );
    // Resulting approval status is "approved" (not in OPEN_HUB_STATUSES) → reconcile path.
    expect(mocks.reconcile).toHaveBeenCalledWith("c1", { sourceType: "approval", sourceId: "a1" });
  });
});
