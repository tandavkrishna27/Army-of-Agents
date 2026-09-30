import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";
import { hubItemRoutes } from "../routes/hub-items.js";

// Service + permission mocks (mirror routes-finance.test.ts / routes-inbox-dismissals.test.ts).
const mockSvc = vi.hoisted(() => ({
  query: vi.fn(),
  counts: vi.fn(),
  getVisible: vi.fn(),
  applyPersonalState: vi.fn(),
  recordLifecycleAction: vi.fn(),
  undoAction: vi.fn(),
  bulkAction: vi.fn(),
  getAudit: vi.fn(),
  reconcile: vi.fn(),
}));

const mockHubPreferences = vi.hoisted(() => ({
  get: vi.fn(),
  upsert: vi.fn(),
  reset: vi.fn(),
}));

const mockHubCounterSnapshots = vi.hoisted(() => ({
  getOrRefresh: vi.fn(),
}));

const mockAutopilot = vi.hoisted(() => ({
  evaluateOpenItems: vi.fn(),
}));

const mockPerms = vi.hoisted(() => ({
  getEffectiveRole: vi.fn(),
  isFounder: vi.fn(),
  getTeamLeadDepartments: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockEmitOpenApprovalHubItems = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockEmitStaleWorkHubItems = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock("../services/index.js", () => ({
  hubItemsService: () => mockSvc,
  hubPreferencesService: () => mockHubPreferences,
  hubCounterSnapshotsService: () => mockHubCounterSnapshots,
  hubAutopilotService: () => mockAutopilot,
  permissionService: () => mockPerms,
  logActivity: mockLogActivity,
}));

vi.mock("../services/hub-approval-requests.js", () => ({
  emitOpenApprovalHubItems: mockEmitOpenApprovalHubItems,
}));

vi.mock("../services/hub-stale-work.js", () => ({
  emitStaleWorkHubItems: mockEmitStaleWorkHubItems,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "55555555-5555-5555-5555-555555555555";
const ITEM_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// A minimal `db` stub: the route only touches `db` directly in the PATCH
// (insert→onConflictDoUpdate→returning) path. Everything else goes via the
// mocked service. We build a chainable stub whose `returning()` resolves to the
// upserted row, and record the values passed to `insert(...).values(...)`.
function makeDbStub() {
  const db = { insert: vi.fn() };
  return { db };
}

function createApp(actor: unknown, db: unknown = makeDbStub().db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", hubItemRoutes(db as never));
  app.use(errorHandler);
  return app;
}

function boardActor(
  overrides: Partial<{
    userId: string;
    companyIds: string[];
    isInstanceAdmin: boolean;
    source: string;
  }> = {},
) {
  return {
    type: "board" as const,
    userId: overrides.userId ?? "user-1",
    source: overrides.source ?? "session",
    companyIds: overrides.companyIds ?? [COMPANY_A],
    isInstanceAdmin: overrides.isInstanceAdmin ?? false,
  };
}

describe("hub-items routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHubCounterSnapshots.getOrRefresh.mockResolvedValue({ open: 0, unread: 0 });
    mockAutopilot.evaluateOpenItems.mockResolvedValue({ evaluated: 0, handled: 0, escalated: 0 });
  });

  it("GET preferences/me returns user company-scoped preferences", async () => {
    mockHubPreferences.get.mockResolvedValue({
      defaultLanding: "home",
      visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
      groupMode: "auto",
      density: "comfortable",
      showAutopilotEntry: true,
      updatedAt: null,
    });
    const app = createApp(boardActor());

    const res = await request(app).get(`/api/companies/${COMPANY_A}/hub-items/preferences/me`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.defaultLanding).toBe("home");
    expect(mockHubPreferences.get).toHaveBeenCalledWith("user-1", COMPANY_A);
  });

  it("PATCH preferences/me rejects duplicate visible lanes", async () => {
    const app = createApp(boardActor());

    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/hub-items/preferences/me`)
      .send({ visibleLanes: ["notifications", "notifications"] });

    expect(res.status).toBe(400);
    expect(mockHubPreferences.upsert).not.toHaveBeenCalled();
  });

  it("PATCH preferences/me normalizes a hidden default landing", async () => {
    mockHubPreferences.upsert.mockResolvedValue({
      defaultLanding: "home",
      visibleLanes: ["notifications"],
      groupMode: "auto",
      density: "comfortable",
      showAutopilotEntry: true,
      updatedAt: "2026-06-30T00:00:00.000Z",
    });
    const app = createApp(boardActor());

    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/hub-items/preferences/me`)
      .send({ defaultLanding: "waiting_on_you", visibleLanes: ["notifications"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.defaultLanding).toBe("home");
    expect(mockHubPreferences.upsert).toHaveBeenCalledWith("user-1", COMPANY_A, {
      defaultLanding: "waiting_on_you",
      visibleLanes: ["notifications"],
    });
  });

  it("POST preferences/me/reset restores defaults", async () => {
    mockHubPreferences.reset.mockResolvedValue({
      defaultLanding: "home",
      visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
      groupMode: "auto",
      density: "comfortable",
      showAutopilotEntry: true,
      updatedAt: "2026-06-30T00:00:00.000Z",
    });
    const app = createApp(boardActor());

    const res = await request(app).post(`/api/companies/${COMPANY_A}/hub-items/preferences/me/reset`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.visibleLanes).toEqual(["waiting_on_you", "notifications", "suggestions"]);
    expect(mockHubPreferences.reset).toHaveBeenCalledWith("user-1", COMPANY_A);
  });

  it("(a) GET list asserts company access and returns the RBAC-scoped service result", async () => {
    mockPerms.getEffectiveRole.mockResolvedValue("team_member");
    mockSvc.query.mockResolvedValue({
      items: [{ id: ITEM_ID, title: "owned", lane: "waiting_on_you" }],
      nextCursor: null,
      totalKnown: null,
    });
    const app = createApp(boardActor());

    const res = await request(app).get(`/api/companies/${COMPANY_A}/hub-items`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe("owned");
    expect(mockEmitOpenApprovalHubItems).toHaveBeenCalledWith(expect.anything(), COMPANY_A, expect.any(Number));
    expect(mockEmitStaleWorkHubItems).toHaveBeenCalledWith(expect.anything(), COMPANY_A, expect.any(Number));
    expect(mockSvc.reconcile).toHaveBeenCalledWith(COMPANY_A, { sourceType: "runtime_decision" });
    expect(mockAutopilot.evaluateOpenItems).toHaveBeenCalledWith({ companyId: COMPANY_A, limit: 50 });
    // RBAC scope (resolved role) is threaded into the service.
    expect(mockSvc.query).toHaveBeenCalledWith(
      COMPANY_A,
      expect.objectContaining({ actorUserId: "user-1", role: "team_member" }),
    );
  });

  it("GET list passes W1d search, cursor, and group mode options to the service", async () => {
    mockPerms.getEffectiveRole.mockResolvedValue("founder");
    mockSvc.query.mockResolvedValue({
      items: [],
      nextCursor: "next-cursor",
      totalKnown: null,
    });
    const app = createApp(boardActor());

    const res = await request(app)
      .get(`/api/companies/${COMPANY_A}/hub-items`)
      .query({
        lane: "waiting_on_you",
        q: "deploy",
        cursor: "cursor-1",
        groupMode: "source",
        limit: "25",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: "next-cursor", totalKnown: null });
    expect(mockAutopilot.evaluateOpenItems).toHaveBeenCalledWith({ companyId: COMPANY_A, limit: 25 });
    expect(mockSvc.reconcile).toHaveBeenCalledWith(COMPANY_A, { sourceType: "runtime_decision" });
    expect(mockSvc.query).toHaveBeenCalledWith(
      COMPANY_A,
      expect.objectContaining({
        actorUserId: "user-1",
        role: "founder",
        lane: "waiting_on_you",
        q: "deploy",
        cursor: "cursor-1",
        groupMode: "source",
        limit: 25,
      }),
    );
  });

  it("GET list rejects unauthenticated actors with 401", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).get(`/api/companies/${COMPANY_A}/hub-items`);
    expect(res.status).toBe(401);
    expect(mockSvc.query).not.toHaveBeenCalled();
  });

  it("GET list forbids a company the user does not belong to (403)", async () => {
    const app = createApp(boardActor({ companyIds: [COMPANY_B] }));
    const res = await request(app).get(`/api/companies/${COMPANY_A}/hub-items`);
    expect(res.status).toBe(403);
    expect(mockSvc.query).not.toHaveBeenCalled();
  });

  it("GET item hydrates one RBAC-visible hub item", async () => {
    mockPerms.getEffectiveRole.mockResolvedValue("team_member");
    mockSvc.getVisible.mockResolvedValue({
      id: ITEM_ID,
      companyId: COMPANY_A,
      title: "Visible item",
      status: "open",
      lane: "waiting",
    });
    const app = createApp(boardActor());

    const res = await request(app).get(`/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Visible item");
    expect(res.body.lane).toBe("waiting");
    expect(mockSvc.getVisible).toHaveBeenCalledWith(COMPANY_A, {
      hubItemId: ITEM_ID,
      actorUserId: "user-1",
      role: "team_member",
      status: "any",
    });
  });

  it("GET item returns 404 when the item is hidden by RBAC", async () => {
    mockPerms.getEffectiveRole.mockResolvedValue("team_member");
    mockSvc.getVisible.mockResolvedValue(null);
    const app = createApp(boardActor());

    const res = await request(app).get(`/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(mockSvc.getVisible).toHaveBeenCalledWith(COMPANY_A, {
      hubItemId: ITEM_ID,
      actorUserId: "user-1",
      role: "team_member",
      status: "any",
    });
  });

  it("(b) POST action with a stale expectedVersion → 409", async () => {
    mockPerms.isFounder.mockResolvedValue(true);
    mockSvc.recordLifecycleAction.mockRejectedValue(
      new HttpError(409, "This item was changed by someone else. Reload and retry.", {
        currentVersion: 3,
      }),
    );
    const app = createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}/action`)
      .send({ action: "resolve", expectedVersion: 1 });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toEqual({ currentVersion: 3 });
  });

  it("(b') POST archive on a still-pending mirrored item surfaces the mirror-guard 409", async () => {
    // Mirror model (R3 + H1): the service rejects resolve/archive while the
    // source is undecided; the route must forward that 409 + details verbatim.
    mockPerms.isFounder.mockResolvedValue(true);
    mockSvc.recordLifecycleAction.mockRejectedValue(
      new HttpError(409, "Decide it at the source — approve/reject the approval or answer the runtime prompt.", {
        sourceStillPending: true,
        sourceType: "approval",
        sourceId: "approval-1",
      }),
    );
    const app = createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}/action`)
      .send({ action: "archive", expectedVersion: 1 });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details).toEqual({
      sourceStillPending: true,
      sourceType: "approval",
      sourceId: "approval-1",
    });
    expect(mockSvc.recordLifecycleAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "archive" }),
    );
  });

  it("(c) POST action on a founder-authority item by a non-founder → 403", async () => {
    // The route computes actorIsFounder=false (non-founder, non-implicit); the
    // service's Authority gate rejects with forbidden → 403.
    mockPerms.isFounder.mockResolvedValue(false);
    mockSvc.recordLifecycleAction.mockRejectedValue(
      new HttpError(403, "This decision requires founder/board authority — route or escalate it."),
    );
    const app = createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}/action`)
      .send({ action: "resolve", expectedVersion: 0 });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // The route resolved actorIsFounder=false and handed it to the service.
    expect(mockSvc.recordLifecycleAction).toHaveBeenCalledWith(
      expect.objectContaining({ actorIsFounder: false, actorId: "user-1" }),
    );
  });

  it("POST action succeeds for a founder and returns audit-backed lifecycle metadata", async () => {
    mockPerms.isFounder.mockResolvedValue(true);
    mockSvc.recordLifecycleAction.mockResolvedValue({
      item: { id: ITEM_ID, status: "resolved", version: 2 },
      auditId: "audit-1",
      undoDeadline: "2026-06-29T00:00:08.000Z",
    });
    const app = createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}/action`)
      .send({ action: "resolve", expectedVersion: 1 });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.item.status).toBe("resolved");
    expect(res.body.auditId).toBe("audit-1");
    expect(res.body.undoDeadline).toBe("2026-06-29T00:00:08.000Z");
    expect(mockAutopilot.evaluateOpenItems).not.toHaveBeenCalled();
    expect(mockSvc.recordLifecycleAction).toHaveBeenCalledWith(
      expect.objectContaining({ actorIsFounder: true, action: "resolve" }),
    );
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("POST action accepts claim without client-chosen status", async () => {
    mockPerms.isFounder.mockResolvedValue(true);
    mockSvc.recordLifecycleAction.mockResolvedValue({
      item: { id: ITEM_ID, status: "open", claimedByUserId: "user-1", version: 2 },
      auditId: "audit-claim",
      undoDeadline: "2026-06-29T00:00:08.000Z",
    });
    const app = createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}/action`)
      .send({ action: "claim", expectedVersion: 1 });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSvc.recordLifecycleAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "claim", expectedVersion: 1 }),
    );
  });

  it("POST action rejects a forbidden client-chosen nextStatus with 400", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}/action`)
      .send({ action: "resolve", expectedVersion: 1, nextStatus: "bogus" });
    expect(res.status).toBe(400);
    expect(mockSvc.recordLifecycleAction).not.toHaveBeenCalled();
  });

  it("POST undo restores an audit-backed lifecycle action", async () => {
    mockSvc.undoAction.mockResolvedValue({
      item: { id: ITEM_ID, status: "open", version: 1 },
      auditId: "undo-audit-1",
    });
    const app = createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}/undo`)
      .send({ auditId: "audit-1", expectedVersion: 2 });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSvc.undoAction).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      hubItemId: ITEM_ID,
      auditId: "audit-1",
      expectedVersion: 2,
      actorType: "user",
      actorId: "user-1",
    });
    expect(res.body.auditId).toBe("undo-audit-1");
  });

  it("GET audit returns the selected item's audit timeline", async () => {
    mockPerms.getEffectiveRole.mockResolvedValue("founder");
    mockSvc.getAudit.mockResolvedValue([
      {
        id: "audit-1",
        companyId: COMPANY_A,
        hubItemId: ITEM_ID,
        actorType: "user",
        actorId: "user-1",
        action: "archive",
        authorityBasis: "founder",
        reason: "No longer needed",
        undoDeadline: null,
        createdAt: "2026-06-29T10:03:00.000Z",
      },
    ]);
    const app = createApp(boardActor());

    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}/audit`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSvc.getAudit).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      hubItemId: ITEM_ID,
      actorUserId: "user-1",
      role: "founder",
    });
    expect(res.body[0]).toMatchObject({
      id: "audit-1",
      action: "archive",
      actorId: "user-1",
      reason: "No longer needed",
    });
  });

  it("POST bulk-action returns ordered mixed personal and shared results", async () => {
    mockPerms.isFounder.mockResolvedValue(true);
    mockPerms.getEffectiveRole.mockResolvedValue("founder");
    mockSvc.bulkAction.mockResolvedValue({
      bulkId: "bulk-1",
      summary: { succeeded: 3, failed: 0, skipped: 0 },
      results: [
        { id: ITEM_ID, status: "success", item: { id: ITEM_ID, status: "resolved" }, auditId: "audit-1", undoDeadline: "2026-06-29T00:00:08.000Z" },
        { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", status: "success", state: { id: "state-1" } },
        { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", status: "success", state: { id: "state-2" } },
      ],
    });
    const app = createApp(boardActor());

    const payload = {
      bulkId: "bulk-1",
      items: [
        { id: ITEM_ID, action: "resolve", expectedVersion: 1 },
        { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", action: "dismiss" },
        { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", action: "snooze", until: "2026-07-01T00:00:00.000Z" },
      ],
    };
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/hub-items/bulk-action`)
      .send(payload);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary).toEqual({ succeeded: 3, failed: 0, skipped: 0 });
    expect(res.body.results.map((r: { id: string }) => r.id)).toEqual(payload.items.map((i) => i.id));
    expect(mockSvc.bulkAction).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      actorUserId: "user-1",
      actorIsFounder: true,
      role: "founder",
      actorType: "user",
      bulkId: "bulk-1",
      items: payload.items,
    });
  });

  it("POST bulk-action preserves ordered partial failures", async () => {
    mockPerms.isFounder.mockResolvedValue(true);
    mockPerms.getEffectiveRole.mockResolvedValue("founder");
    mockSvc.bulkAction.mockResolvedValue({
      bulkId: "bulk-partial",
      summary: { succeeded: 1, failed: 1, skipped: 0 },
      results: [
        { id: ITEM_ID, status: "failed", error: { status: 409, message: "Changed elsewhere" } },
        { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", status: "success", state: { id: "state-1" } },
      ],
    });
    const app = createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/hub-items/bulk-action`)
      .send({
        bulkId: "bulk-partial",
        items: [
          { id: ITEM_ID, action: "archive", expectedVersion: 1 },
          { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", action: "dismiss" },
        ],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary).toEqual({ succeeded: 1, failed: 1, skipped: 0 });
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[1].status).toBe("success");
  });

  it("POST bulk-action rejects invalid item shapes before service execution", async () => {
    const app = createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/hub-items/bulk-action`)
      .send({
        items: [
          { id: ITEM_ID, action: "resolve" },
        ],
      });

    expect(res.status).toBe(400);
    expect(mockSvc.bulkAction).not.toHaveBeenCalled();
  });

  it.each([
    ["read", { kind: "read" }],
    ["unread", { kind: "unread" }],
    ["snooze", { kind: "snooze", until: "2026-07-01T00:00:00.000Z" }],
    ["unsnooze", { kind: "unsnooze" }],
    ["dismiss", { kind: "dismiss" }],
    ["undismiss", { kind: "undismiss" }],
  ] as const)("PATCH state applies %s through the personal-state service", async (_label, body) => {
    mockPerms.getEffectiveRole.mockResolvedValue("team_member");
    mockSvc.applyPersonalState.mockResolvedValue({
      id: "state-1",
      companyId: COMPANY_A,
      hubItemId: ITEM_ID,
      principalId: "user-1",
      readAt: null,
      snoozedUntil: null,
      dismissedAt: null,
      updatedAt: "2026-06-29T00:00:00.000Z",
    });
    const { db } = makeDbStub();
    const app = createApp(boardActor(), db);

    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}/state`)
      .send(body);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSvc.applyPersonalState).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      hubItemId: ITEM_ID,
      actorUserId: "user-1",
      role: "team_member",
      state: body,
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("PATCH state rejects hub item ids that are not visible in the URL company", async () => {
    mockPerms.getEffectiveRole.mockResolvedValue("team_member");
    mockSvc.applyPersonalState.mockRejectedValue(new HttpError(404, "Hub item not found"));
    const { db } = makeDbStub();
    const app = createApp(boardActor(), db);

    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}/state`)
      .send({ kind: "read" });

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("PATCH state rejects an unknown kind with 400", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/hub-items/${ITEM_ID}/state`)
      .send({ kind: "bogus" });
    expect(res.status).toBe(400);
  });

  it("(e) GET counts returns { open, unread }", async () => {
    mockPerms.getEffectiveRole.mockResolvedValue("founder");
    mockHubCounterSnapshots.getOrRefresh.mockResolvedValue({ open: 5, unread: 3 });
    const app = createApp(boardActor());

    const res = await request(app).get(`/api/companies/${COMPANY_A}/hub-items/counts`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ open: 5, unread: 3 });
    expect(mockHubCounterSnapshots.getOrRefresh).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      userId: "user-1",
      role: "founder",
    });
    expect(mockAutopilot.evaluateOpenItems).toHaveBeenCalledWith({ companyId: COMPANY_A, limit: 25 });
    expect(mockSvc.counts).not.toHaveBeenCalled();
  });

  it("GET counts materializes all stale work before reading snapshots", async () => {
    mockPerms.getEffectiveRole.mockResolvedValue("founder");
    const app = createApp(boardActor());

    const res = await request(app).get(`/api/companies/${COMPANY_A}/hub-items/counts`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockEmitOpenApprovalHubItems).toHaveBeenCalledWith(expect.anything(), COMPANY_A);
    expect(mockEmitStaleWorkHubItems).toHaveBeenCalledWith(expect.anything(), COMPANY_A, null);
    expect(mockSvc.reconcile).toHaveBeenCalledWith(COMPANY_A, { sourceType: "runtime_decision" });
    expect(mockHubCounterSnapshots.getOrRefresh).toHaveBeenCalled();
  });
});
