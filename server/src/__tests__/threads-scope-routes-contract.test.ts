import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  getPlanSteps: vi.fn(),
  updatePlanSteps: vi.fn(),
  getById: vi.fn(),
  createDraftFromThread: vi.fn(),
  updateDraft: vi.fn(),
  reviewItems: vi.fn(),
  updateItem: vi.fn(),
  createOutputItem: vi.fn(),
  applyAcceptedDraft: vi.fn(),
  acceptDraft: vi.fn(),
  rejectDraft: vi.fn(),
  completeVersion: vi.fn(),
  enqueueIssueAssigneeWakeup: vi.fn(),
  assertBoard: vi.fn((req: any) => {
    if (req.actor?.type !== "board") {
      const err = new Error("Board access required") as Error & { status?: number };
      err.status = 403;
      throw err;
    }
  }),
  assertMemoryApproval: vi.fn().mockResolvedValue(undefined),
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/index.js", () => ({
  discussionService: () => ({ getById: mocks.getById }),
  permissionService: () => ({ getEffectiveRole: vi.fn().mockResolvedValue("founder") }),
  logActivity: mocks.logActivity,
}));
vi.mock("../services/threads.js", () => ({
  threadService: () => ({ getPlanSteps: mocks.getPlanSteps, updatePlanSteps: mocks.updatePlanSteps, advancePhase: vi.fn(), claim: vi.fn(), assignScopeItems: vi.fn(), transferOwnership: vi.fn(), addParticipant: vi.fn(), promoteToGoal: vi.fn() }),
  parseMentions: vi.fn(() => []),
  processMentions: vi.fn(),
}));
vi.mock("./authz.js", () => ({
  assertBoard: mocks.assertBoard,
  assertCompanyAccess: vi.fn(),
  getActorInfo: () => ({ actorId: "u1", actorType: "user", agentId: null }),
}));
vi.mock("../middleware/rbac.js", () => ({
  assertRole: vi.fn().mockResolvedValue(undefined),
  assertMemoryApproval: mocks.assertMemoryApproval,
}));
vi.mock("../services/internal-agent/aoa-agents/router-recommendation.js", () => ({
  recommendDepartment: vi.fn(() => ({ departmentId: "eng", departmentName: "Engineering", itemCount: 1 })),
}));
vi.mock("../services/thread-scope-versions.js", () => ({
  threadScopeVersionService: () => ({
    reviewItems: mocks.reviewItems,
    updateItem: mocks.updateItem,
    createOutputItem: mocks.createOutputItem,
    applyAcceptedDraft: mocks.applyAcceptedDraft,
    listVersions: vi.fn(),
    createDraftFromThread: mocks.createDraftFromThread,
    getVersion: vi.fn(),
    updateDraft: mocks.updateDraft,
    acceptDraft: mocks.acceptDraft,
    rejectDraft: mocks.rejectDraft,
    completeVersion: mocks.completeVersion,
  }),
}));
vi.mock("../services/issue-assignee-wakeup.js", () => ({
  enqueueIssueAssigneeWakeup: mocks.enqueueIssueAssigneeWakeup,
}));
vi.mock("../routes/issues-planning-mode-dispatch.js", () => ({
  shouldDispatchIssueWakeup: vi.fn(() => true),
}));
vi.mock("@armyofagents/db", () => {
  const explicit: Record<string, any> = {
    projects: { id: "p_id", name: "p_name", type: "p_type", companyId: "p_co" },
  };
  const colProxy = () => new Proxy({} as any, { get: (_t, col) => col });
  return new Proxy(explicit, {
    get: (target, name: string | symbol) => {
      if (typeof name !== "string") return undefined;
      return name in target ? target[name] : colProxy();
    },
    has: (_t, _name) => true,
    ownKeys: (target) => Object.keys(target),
    getOwnPropertyDescriptor: (target, name) => {
      if (typeof name !== "string") return undefined;
      return {
        value: name in target ? target[name] : colProxy(),
        writable: true,
        enumerable: true,
        configurable: true,
      };
    },
  });
});
vi.mock("drizzle-orm", () => {
  const SQL_STUB: any = { as: () => SQL_STUB, join: () => SQL_STUB, raw: () => SQL_STUB, toString: () => "sql" };
  const sqlFn = Object.assign((..._a: any[]) => SQL_STUB, { join: () => SQL_STUB, raw: () => SQL_STUB });
  const sql = new Proxy(sqlFn, { get: (t: any, p: any) => (p in t ? t[p] : () => SQL_STUB), apply: () => SQL_STUB });
  return {
    eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
    and: vi.fn((...a: any[]) => a),
    sql,
  };
});

import { discussionRoutes } from "../routes/discussions.js";

function extractRoutes(router: any): Array<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];
  const layers: any[] = router.stack ?? [];
  for (const layer of layers) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods ?? {})) {
      routes.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return routes;
}

function hasRoute(method: string, suffix: string) {
  const routes = extractRoutes(discussionRoutes({} as any));
  return routes.some((route) => route.method === method && route.path.endsWith(suffix));
}

function makeApp(actor: Record<string, unknown> = { type: "board", source: "local_implicit", isInstanceAdmin: true }) {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => {
    req.actor = actor;
    next();
  });
  a.use(discussionRoutes({} as any));
  return a;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /companies/:companyId/discussions/:discussionId/scope", () => {
  it("returns summary + planSteps + items + recommendation", async () => {
    mocks.getById.mockResolvedValue({
      id: "t1",
      summaryText: "Summary here",
      summaryNext: "Next steps",
      entries: [
        {
          extractedItems: [
            { id: "i1", type: "task", title: "Build it", suggestedDepartmentId: "eng", departmentId: null, status: "approved" },
          ],
        },
      ],
    });
    mocks.getPlanSteps.mockResolvedValue([{ id: "p1", stepOrder: 0, title: "Spec" }]);

    const res = await request(makeApp()).get("/companies/co1/discussions/t1/scope");
    expect(res.status).toBe(200);
    expect(res.body.summaryText).toBe("Summary here");
    expect(res.body.planSteps[0].title).toBe("Spec");
    expect(res.body.items[0].type).toBe("task");
    expect(res.body.recommendation.departmentId).toBe("eng");
  });

  it("returns 404 when discussion not found", async () => {
    mocks.getById.mockResolvedValue(null);
    const res = await request(makeApp()).get("/companies/co1/discussions/missing/scope");
    expect(res.status).toBe(404);
  });
});

describe("PUT /companies/:companyId/discussions/:discussionId/scope/plan", () => {
  it("replaces the plan and returns the count", async () => {
    mocks.updatePlanSteps.mockResolvedValue({ count: 2 });
    const res = await request(makeApp())
      .put("/companies/co1/discussions/t1/scope/plan")
      .send({ steps: [{ title: "A" }, { title: "B" }] });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(mocks.updatePlanSteps).toHaveBeenCalledWith(
      "co1", "t1",
      [{ title: "A" }, { title: "B" }],
      expect.anything(),
    );
  });

  it("rejects malformed body (missing title) with 400", async () => {
    const res = await request(makeApp())
      .put("/companies/co1/discussions/t1/scope/plan")
      .send({ steps: [{ notTitle: 1 }] });
    expect(res.status).toBe(400);
  });
});

describe("thread scope version routes", () => {
  const discussionId = "11111111-1111-4111-8111-111111111111";
  const scopeVersionId = "22222222-2222-4222-8222-222222222222";
  const itemId = "33333333-3333-4333-8333-333333333333";

  it("exposes scope-version lifecycle endpoints", () => {
    expect(hasRoute("GET", "/discussions/:discussionId/scope-versions")).toBe(true);
    expect(hasRoute("POST", "/discussions/:discussionId/scope-versions/draft")).toBe(true);
    expect(hasRoute("GET", "/discussions/:discussionId/scope-versions/:scopeVersionId")).toBe(true);
    expect(hasRoute("PATCH", "/discussions/:discussionId/scope-versions/:scopeVersionId")).toBe(true);
    expect(hasRoute("POST", "/discussions/:discussionId/scope-versions/:scopeVersionId/accept")).toBe(true);
    expect(hasRoute("POST", "/discussions/:discussionId/scope-versions/:scopeVersionId/reject")).toBe(true);
    expect(hasRoute("POST", "/discussions/:discussionId/scope-versions/:scopeVersionId/complete")).toBe(true);
  });

  it("exposes item review and apply endpoints", () => {
    expect(hasRoute("POST", "/discussions/:discussionId/scope-versions/:scopeVersionId/items/review")).toBe(true);
    expect(hasRoute("PATCH", "/discussions/:discussionId/scope-versions/:scopeVersionId/items/:itemId")).toBe(true);
    expect(hasRoute("POST", "/discussions/:discussionId/scope-versions/:scopeVersionId/items/:itemId/create")).toBe(true);
    expect(hasRoute("POST", "/discussions/:discussionId/scope-versions/:scopeVersionId/apply")).toBe(true);
  });

  it.each([
    ["POST", `/companies/co1/discussions/${discussionId}/scope-versions/draft`, {}],
    ["PATCH", `/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}`, { summary: "Edited scope" }],
    ["POST", `/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/review`, { items: [{ itemId, status: "accepted" }] }],
    ["PATCH", `/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/${itemId}`, { title: "Edited item" }],
    ["POST", `/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/${itemId}/create`, {}],
    ["POST", `/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/apply`, {}],
    ["POST", `/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/accept`, {}],
    ["POST", `/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/reject`, {}],
    ["POST", `/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/complete`, {}],
    ["POST", `/companies/co1/discussions/${discussionId}/scope-deps`, { blockerItemId: itemId, blockedItemId: scopeVersionId }],
    ["POST", `/companies/co1/discussions/${discussionId}/scope-deps/graduate`, {}],
  ])("rejects agent actors for manual scope mutation %s %s", async (method, path, body) => {
    mocks.createDraftFromThread.mockResolvedValue({ status: "created" });
    mocks.updateDraft.mockResolvedValue({ id: scopeVersionId, title: "Edited scope" });
    mocks.reviewItems.mockResolvedValue({ ok: true, updatedItems: [] });
    mocks.updateItem.mockResolvedValue({ ok: true, item: { id: itemId } });
    mocks.createOutputItem.mockResolvedValue({ ok: true, item: { id: itemId } });
    mocks.applyAcceptedDraft.mockResolvedValue({ ok: true, createdTasks: [], appliedItems: [] });
    mocks.acceptDraft.mockResolvedValue({ ok: true, createdTasks: [], appliedItems: [] });
    mocks.rejectDraft.mockResolvedValue({ ok: true, version: { id: scopeVersionId, status: "rejected" } });
    mocks.completeVersion.mockResolvedValue({ ok: true, version: { id: scopeVersionId, status: "completed" } });

    const agentActor = { type: "agent", companyId: "co1", agentId: "agent-1" };
    const agentApp = makeApp(agentActor);
    const res = method === "PATCH"
      ? await request(agentApp).patch(path).send(body)
      : await request(agentApp).post(path).send(body);

    expect(res.status).toBe(403);
    expect(res.body.error ?? res.text).toContain("Board access required");
  });

  it("reviews scope items through the scope version service", async () => {
    mocks.reviewItems.mockResolvedValue({
      ok: true,
      updatedItems: [{ id: itemId, status: "accepted" }],
    });

    const res = await request(makeApp())
      .post(`/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/review`)
      .send({ items: [{ itemId, status: "accepted" }] });

    expect(res.status).toBe(200);
    expect(mocks.reviewItems).toHaveBeenCalledWith(
      "co1",
      discussionId,
      scopeVersionId,
      { items: [{ itemId, status: "accepted" }] },
      { userId: "board", agentId: undefined, isHuman: true },
    );
  });

  it("updates a scope item through the scope version service", async () => {
    mocks.updateItem.mockResolvedValue({
      ok: true,
      item: { id: itemId, title: "Edited", description: null, status: "accepted" },
    });

    const res = await request(makeApp())
      .patch(`/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/${itemId}`)
      .send({ title: "Edited", description: null, status: "accepted" });

    expect(res.status).toBe(200);
    expect(mocks.updateItem).toHaveBeenCalledWith(
      "co1",
      discussionId,
      scopeVersionId,
      itemId,
      { title: "Edited", description: null, status: "accepted" },
      { userId: "board", agentId: undefined, isHuman: true },
    );
  });

  it("applies accepted scope items and wakes created task assignees", async () => {
    mocks.applyAcceptedDraft.mockResolvedValue({
      ok: true,
      createdTasks: [{ id: "task-1", assigneeAgentId: "agent-1", workMode: "standard" }],
      appliedItems: [{ id: itemId, status: "applied" }],
    });

    const res = await request(makeApp())
      .post(`/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/apply`)
      .send({});

    expect(res.status).toBe(200);
    expect(mocks.applyAcceptedDraft).toHaveBeenCalledWith(
      "co1",
      discussionId,
      scopeVersionId,
      { userId: "board", agentId: undefined, isHuman: true },
    );
    expect(mocks.enqueueIssueAssigneeWakeup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "co1",
        issueId: "task-1",
        agentId: "agent-1",
        reason: "scope_version_apply",
      }),
    );
  });

  it("creates one scope output item and wakes the assigned task agent", async () => {
    mocks.createOutputItem.mockResolvedValue({
      ok: true,
      item: { id: itemId, title: "Created task", status: "applied" },
      createdTask: { id: "task-1", assigneeAgentId: "agent-1", workMode: "standard" },
    });

    const res = await request(makeApp())
      .post(`/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/${itemId}/create`)
      .send({});

    expect(res.status).toBe(200);
    expect(mocks.createOutputItem).toHaveBeenCalledWith(
      "co1",
      discussionId,
      scopeVersionId,
      itemId,
      { userId: "board", agentId: undefined, isHuman: true },
    );
    expect(mocks.enqueueIssueAssigneeWakeup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "co1",
        issueId: "task-1",
        agentId: "agent-1",
        reason: "scope_item_create",
      }),
    );
  });

  it("passes requested memory status to scope output creation", async () => {
    mocks.createOutputItem.mockResolvedValue({
      ok: true,
      item: { id: itemId, title: "Created memory", status: "applied" },
      createdMemoryId: "memory-1",
    });

    const res = await request(makeApp())
      .post(`/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/${itemId}/create`)
      .send({ memoryStatus: "approved" });

    expect(res.status).toBe(200);
    expect(mocks.createOutputItem).toHaveBeenCalledWith(
      "co1",
      discussionId,
      scopeVersionId,
      itemId,
      { userId: "board", agentId: undefined, isHuman: true },
      expect.objectContaining({ memoryStatus: "approved", approveMemory: expect.any(Function) }),
    );
  });

  it("passes an approval guard when approved memory is requested from scope", async () => {
    mocks.createOutputItem.mockResolvedValue({
      ok: true,
      item: { id: itemId, title: "Created memory", status: "applied" },
      createdMemoryId: "memory-1",
    });

    const res = await request(makeApp())
      .post(`/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/${itemId}/create`)
      .send({ memoryStatus: "approved" });

    expect(res.status).toBe(200);
    const options = mocks.createOutputItem.mock.calls.at(-1)?.[5];
    expect(options).toEqual(expect.objectContaining({
      memoryStatus: "approved",
      approveMemory: expect.any(Function),
    }));

    await options.approveMemory({ layer: "domain", departmentId: "dept-1" });
    expect(mocks.assertMemoryApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "co1",
      { layer: "domain", departmentId: "dept-1" },
    );
  });

  it("returns 403 when approved scope memory fails the memory approval guard", async () => {
    const denied = new Error("Insufficient permissions to approve/reject memory items") as Error & { status?: number };
    denied.status = 403;
    mocks.assertMemoryApproval.mockRejectedValueOnce(denied);
    mocks.createOutputItem.mockImplementationOnce(async (
      _companyId,
      _discussionId,
      _scopeVersionId,
      _itemId,
      _actor,
      options,
    ) => {
      await options.approveMemory({ layer: "domain", departmentId: "dept-1" });
      return {
        ok: true,
        item: { id: itemId, title: "Created memory", status: "applied" },
        createdMemoryId: "memory-1",
      };
    });

    const res = await request(makeApp())
      .post(`/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/${itemId}/create`)
      .send({ memoryStatus: "approved" });

    expect(res.status).toBe(403);
    expect(res.body.error ?? res.text).toContain("Insufficient permissions");
  });

  it("logs activity when scope items are reviewed", async () => {
    mocks.reviewItems.mockResolvedValue({
      ok: true,
      updatedItems: [{ id: itemId, status: "accepted" }],
    });

    const res = await request(makeApp())
      .post(`/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/review`)
      .send({ items: [{ itemId, status: "accepted" }] });

    expect(res.status).toBe(200);
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "co1",
        action: "discussion.scope_items_reviewed",
        entityType: "discussion",
        entityId: discussionId,
        details: expect.objectContaining({
          scopeVersionId,
          itemCount: 1,
        }),
      }),
    );
  });

  it("maps nothing accepted to 422 on apply", async () => {
    mocks.applyAcceptedDraft.mockResolvedValue({
      ok: false,
      reason: "nothing_accepted",
      message: "No accepted cards to apply",
    });

    const res = await request(makeApp())
      .post(`/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/apply`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "No accepted cards to apply" });
  });

  it("maps rejected scope versions to 409 on apply", async () => {
    mocks.applyAcceptedDraft.mockResolvedValue({
      ok: false,
      reason: "rejected",
      message: "Scope version has been rejected",
    });

    const res = await request(makeApp())
      .post(`/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/apply`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Scope version has been rejected" });
  });

  it.each([
    ["nothing_accepted", 422],
    ["rejected", 409],
  ])("maps %s through shared failure status on legacy accept", async (reason, status) => {
    mocks.acceptDraft.mockResolvedValue({
      ok: false,
      reason,
      message: `Scope failure: ${reason}`,
    });

    const res = await request(makeApp())
      .post(`/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/accept`)
      .send({});

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: `Scope failure: ${reason}` });
  });

  it("returns the mutation result even when activity logging throws", async () => {
    mocks.reviewItems.mockResolvedValue({ ok: true, updatedItems: [] });
    mocks.logActivity.mockRejectedValueOnce(new Error("activity log DB down"));
    const res = await request(makeApp())
      .post(`/companies/co1/discussions/${discussionId}/scope-versions/${scopeVersionId}/items/review`)
      .send({ items: [{ itemId, status: "accepted" }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mocks.logActivity).toHaveBeenCalled();
  });

  it("logs an activity action on every scope mutation route", () => {
    const src = readFileSync(new URL("../routes/discussions.ts", import.meta.url), "utf8");
    const actions = [...src.matchAll(/logScopeActivity\(\s*db,\s*req,\s*companyId,\s*"(discussion\.[a-z_]+)"/g)].map((m) => m[1]);
    const unique = new Set(actions);
    expect(unique).toEqual(new Set([
      "discussion.scope_version_draft_created",
      "discussion.scope_version_updated",
      "discussion.scope_items_reviewed",
      "discussion.scope_item_updated",
      "discussion.scope_item_output_created",
      "discussion.scope_version_applied",
      "discussion.scope_version_accepted",
      "discussion.scope_version_rejected",
      "discussion.scope_version_completed",
    ]));
    expect(unique.size).toBe(9);
  });
});
