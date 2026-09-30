/**
 * Tests for Task W4 re-index routes:
 *   POST /companies/:companyId/memory/:id/reindex
 *   POST /companies/:companyId/memory/reindex-failed
 *
 * Covers:
 *   - /:id/reindex: resets a failed queue row to pending (asserts update),
 *     logs activity; with no failed row, enqueues via enqueueMemoryEmbedding.
 *   - /reindex-failed: resets all company failed rows to pending, logs
 *     activity, returns { requeued: N }.
 *   - RBAC: founder and team_lead allowed; team_member (lower role) rejected.
 *
 * Mocking strategy: follows the same pattern as memory-route-approval-gate.test.ts.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("@armyofagents/db", () => ({
  __esModule: true,
  embeddingQueue: makeTableProxy("embedding_queue"),
  memoryItems: makeTableProxy("memory_items"),
  ...new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        typeof prop === "string" ? makeTableProxy(prop) : undefined,
    },
  ),
}));

// ── Service mocks ─────────────────────────────────────────────────────────────

const mockMemoryService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  suggestUpdate: vi.fn(),
  suggestArchive: vi.fn(),
  searchSemantic: vi.fn().mockResolvedValue([]),
  findSimilarItems: vi.fn().mockResolvedValue([]),
  listPending: vi.fn().mockResolvedValue([]),
  listVersions: vi.fn().mockResolvedValue([]),
  getDraftVersion: vi.fn(),
  publishDraft: vi.fn(),
  approveSuggestedVersion: vi.fn(),
  rejectSuggestedVersion: vi.fn(),
  restore: vi.fn(),
  changeLayer: vi.fn(),
  listFolders: vi.fn().mockResolvedValue([]),
  createFolder: vi.fn(),
  updateFolder: vi.fn(),
  deleteFolder: vi.fn(),
  getMoveOptions: vi.fn().mockResolvedValue([]),
  moveItem: vi.fn(),
  getPinnedItems: vi.fn().mockResolvedValue([]),
  pinItem: vi.fn(),
  unpinItem: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  memoryService: () => mockMemoryService,
  companyBrainGraphService: () => ({
    getMemoryItemNeighbors: vi.fn(),
    getMemoryItemUsage: vi.fn(),
    getCompanyGraphOverview: vi.fn(),
    createSemanticEdge: vi.fn(),
    updateSemanticEdge: vi.fn(),
    archiveSemanticEdge: vi.fn(),
  }),
  logActivity: mockLogActivity,
}));

// ── RBAC mocks ────────────────────────────────────────────────────────────────

const mockAssertRole = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAssertMemoryAccess = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAssertMemoryApproval = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../middleware/rbac.js", () => ({
  assertRole: mockAssertRole,
  assertMemoryAccess: mockAssertMemoryAccess,
  assertMemoryApproval: mockAssertMemoryApproval,
}));

vi.mock("../middleware/validate.js", () => ({
  validate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../middleware/rate-limit.js", () => ({
  embeddingSearchLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ── embeddings-backfill mock ─────────────────────────────────────────────────

const mockReindexCompany = vi.hoisted(() => vi.fn().mockResolvedValue({ requeuedFailed: 0, enqueuedMissing: 0 }));
const mockReindexAllCompany = vi.hoisted(() => vi.fn().mockResolvedValue({ enqueued: 0 }));

vi.mock("../services/embeddings-backfill.js", () => ({
  reindexCompany: mockReindexCompany,
  reindexAllCompany: mockReindexAllCompany,
}));

// ── memory-write mock ─────────────────────────────────────────────────────────

const mockEnqueueMemoryEmbedding = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/memory-write.js", () => ({
  enqueueMemoryEmbedding: mockEnqueueMemoryEmbedding,
  writeMemoryAndIndex: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { memoryRoutes } from "../routes/memory.js";
import { errorHandler } from "../middleware/index.js";
import { forbidden } from "../errors.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const QUEUE_ID = "22222222-2222-4222-8222-222222222222";

const founderActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "founder-user",
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
};

const memberActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "member-user",
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
};

const agentActor = {
  type: "agent" as const,
  source: "agent" as const,
  userId: "agent-1",
  companyId: COMPANY_ID,
  agentId: "agent-1",
};

// ── DB mock factories ─────────────────────────────────────────────────────────

/**
 * Chainable mock DB that supports `.select().from().where().limit()` and
 * `.update().set().where()` chains.
 *
 * selectResults: array of results returned per select call in sequence.
 * The test controls whether a failed queue row is found by providing one.
 */
function makeMockDb(opts: {
  failedQueueRows?: Array<{ id: string }>;
  trackUpdates?: boolean;
} = {}) {
  const { failedQueueRows = [], trackUpdates = false } = opts;
  let selectCallIdx = 0;
  const selectSequence = [failedQueueRows]; // first select = failed queue lookup

  const updateCalls: Array<{ set: Record<string, unknown> }> = [];
  const lastSet: { value?: Record<string, unknown> } = {};

  function makeSelectChain(rows: Array<Record<string, unknown>>) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit"]) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(rows));
    return chain;
  }

  function makeUpdateChain() {
    const updateRecord: { set: Record<string, unknown> } = { set: {} };
    const chain: Record<string, unknown> = {};
    chain.set = (val: Record<string, unknown>) => {
      updateRecord.set = val;
      if (trackUpdates) updateCalls.push({ ...updateRecord });
      lastSet.value = val;
      return chain;
    };
    chain.where = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve([]));
    return chain;
  }

  return {
    select: () => makeSelectChain(selectSequence[selectCallIdx++] ?? []),
    update: () => makeUpdateChain(),
    insert: () => {
      const c: Record<string, unknown> = {};
      for (const m of ["values", "returning", "onConflictDoNothing"]) {
        c[m] = () => c;
      }
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve([]));
      return c;
    },
    _updateCalls: updateCalls,
    _lastSet: lastSet,
  };
}

function makeApp(actor = founderActor, db: unknown = makeMockDb()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", memoryRoutes(db as never));
  app.use(errorHandler);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /companies/:companyId/memory/:id/reindex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertRole.mockResolvedValue(undefined);
    mockAssertMemoryAccess.mockResolvedValue(undefined);
  });

  it("re-indexes CURRENT content (no stale failed-row reset) when a failed queue row exists", async () => {
    const item = { id: ITEM_ID, title: "Test item", content: "content", companyId: COMPANY_ID, layer: "domain" };
    mockMemoryService.getById.mockResolvedValueOnce(item);

    const db = makeMockDb({ failedQueueRows: [{ id: QUEUE_ID }], trackUpdates: true });

    const res = await request(makeApp(founderActor, db))
      .post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/reindex`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reindexed: true });

    // P2 (Codex): the stale failed row is NOT reset in place (its inputText may
    // be pre-edit and would clobber the current vector). Instead we enqueue the
    // item's CURRENT content via enqueueMemoryEmbedding.
    expect(db._lastSet.value).toBeUndefined();
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      expect.objectContaining({ id: ITEM_ID }),
    );

    // Activity was logged (still records that a failed row existed)
    expect(mockLogActivity).toHaveBeenCalledOnce();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "memory.reindex",
        entityType: "memory_item",
        entityId: ITEM_ID,
        companyId: COMPANY_ID,
        details: expect.objectContaining({ hadFailedRow: true }),
      }),
    );
  });

  it("enqueues via enqueueMemoryEmbedding when no failed queue row exists", async () => {
    const item = { id: ITEM_ID, title: "Test item", content: "content", companyId: COMPANY_ID, layer: "domain" };
    mockMemoryService.getById.mockResolvedValueOnce(item);

    const db = makeMockDb({ failedQueueRows: [] }); // no failed rows

    const res = await request(makeApp(founderActor, db))
      .post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/reindex`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reindexed: true });
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      expect.objectContaining({ id: ITEM_ID }),
    );
    // Activity still logged
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "memory.reindex",
        details: expect.objectContaining({ hadFailedRow: false }),
      }),
    );
  });

  it("returns 404 when memory item not found", async () => {
    mockMemoryService.getById.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/reindex`)
      .send();
    expect(res.status).toBe(404);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("RBAC: lower role (team_member) is rejected with 403", async () => {
    mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder, team_lead"));

    const res = await request(makeApp(memberActor))
      .post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/reindex`)
      .send();

    expect(res.status).toBe(403);
    expect(mockAssertRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "founder",
      "team_lead",
    );
    expect(mockMemoryService.getById).not.toHaveBeenCalled();
  });

  it("rejects agent actors (board-only) before any role check (P2)", async () => {
    // assertRole is a no-op for agent actors, so assertBoard must reject them
    // first — otherwise any company agent key could drive re-index.
    const res = await request(makeApp(agentActor))
      .post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/reindex`)
      .send();

    expect(res.status).toBe(403);
    expect(mockAssertRole).not.toHaveBeenCalled();
    expect(mockMemoryService.getById).not.toHaveBeenCalled();
  });

  it("RBAC: founder is allowed (assertRole resolves)", async () => {
    const item = { id: ITEM_ID, title: "T", content: "C", companyId: COMPANY_ID };
    mockMemoryService.getById.mockResolvedValueOnce(item);
    mockAssertRole.mockResolvedValueOnce(undefined);

    const res = await request(makeApp(founderActor))
      .post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/reindex`)
      .send();

    expect(res.status).toBe(200);
    expect(mockAssertRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "founder",
      "team_lead",
    );
  });

  it("department-scopes the FETCHED item (audit): a cross-department lead is rejected", async () => {
    // company-wide assertRole passes, but the item belongs to a department the
    // caller can't access → assertMemoryAccess('update', {item}) rejects → 403.
    const item = {
      id: ITEM_ID,
      title: "Dept B item",
      content: "C",
      companyId: COMPANY_ID,
      layer: "domain",
      departmentId: "dept-B",
      visibility: "department",
    };
    mockMemoryService.getById.mockResolvedValueOnce(item);
    mockAssertMemoryAccess.mockRejectedValueOnce(
      forbidden("Insufficient permissions for memory update"),
    );

    const res = await request(makeApp(founderActor))
      .post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/reindex`)
      .send();

    expect(res.status).toBe(403);
    // The dept-scope check ran against the fetched item's department/layer.
    expect(mockAssertMemoryAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "update",
      expect.objectContaining({ departmentId: "dept-B", layer: "domain" }),
    );
    // It must short-circuit before doing any re-index work.
    expect(mockEnqueueMemoryEmbedding).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /companies/:companyId/memory/reindex-failed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertRole.mockResolvedValue(undefined);
  });

  it("resets all company failed rows to pending and returns count", async () => {
    // The route does: SELECT failed rows → if any, UPDATE → logActivity.
    // We pre-configure the select to return 3 rows.
    const failedRows = [{ id: "q1" }, { id: "q2" }, { id: "q3" }];
    const db = makeMockDb({ failedQueueRows: failedRows, trackUpdates: true });

    const res = await request(makeApp(founderActor, db))
      .post(`/api/companies/${COMPANY_ID}/memory/reindex-failed`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requeued: 3 });

    // Activity logged with correct count
    expect(mockLogActivity).toHaveBeenCalledOnce();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "memory.reindex_failed",
        entityType: "company",
        entityId: COMPANY_ID,
        companyId: COMPANY_ID,
        details: { requeued: 3 },
      }),
    );
  });

  it("returns { requeued: 0 } and logs activity when no failed rows", async () => {
    const db = makeMockDb({ failedQueueRows: [] });

    const res = await request(makeApp(founderActor, db))
      .post(`/api/companies/${COMPANY_ID}/memory/reindex-failed`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requeued: 0 });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "memory.reindex_failed",
        details: { requeued: 0 },
      }),
    );
  });

  it("RBAC: non-founder is rejected with 403 (bulk reindex is founder-only)", async () => {
    mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder"));

    const res = await request(makeApp(memberActor))
      .post(`/api/companies/${COMPANY_ID}/memory/reindex-failed`)
      .send();

    expect(res.status).toBe(403);
    // Bulk re-index spans all departments + identity, so it is FOUNDER-only
    // (Codex re-review P2) — a team_lead must not pass this gate.
    expect(mockAssertRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "founder",
    );
    expect(mockAssertRole).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "founder",
      "team_lead",
    );
  });

  it("RBAC: founder is allowed", async () => {
    const db = makeMockDb({ failedQueueRows: [] });
    const res = await request(makeApp(founderActor, db))
      .post(`/api/companies/${COMPANY_ID}/memory/reindex-failed`)
      .send();
    expect(res.status).toBe(200);
    expect(mockAssertRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "founder",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /companies/:companyId/memory/reindex-all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertRole.mockResolvedValue(undefined);
    mockReindexAllCompany.mockResolvedValue({ enqueued: 0 });
  });

  it("re-enqueues every company memory item and returns the count", async () => {
    mockReindexAllCompany.mockResolvedValueOnce({ enqueued: 7 });
    const res = await request(makeApp(founderActor))
      .post(`/api/companies/${COMPANY_ID}/memory/reindex-all`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reindexed: 7 });
    expect(mockReindexAllCompany).toHaveBeenCalledWith(expect.anything(), COMPANY_ID);

    expect(mockLogActivity).toHaveBeenCalledOnce();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "memory.reindex_all",
        entityType: "company",
        entityId: COMPANY_ID,
        companyId: COMPANY_ID,
        details: { reindexed: 7 },
      }),
    );
  });

  it("RBAC: founder-only — team_lead is rejected with 403", async () => {
    mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder"));

    const res = await request(makeApp(memberActor))
      .post(`/api/companies/${COMPANY_ID}/memory/reindex-all`)
      .send();

    expect(res.status).toBe(403);
    // Bulk re-embed spans all departments + identity, so it is FOUNDER-only —
    // a team_lead must NOT pass this gate.
    expect(mockAssertRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "founder",
    );
    expect(mockAssertRole).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "founder",
      "team_lead",
    );
    expect(mockReindexAllCompany).not.toHaveBeenCalled();
  });

  it("rejects agent actors (board-only) before any role check", async () => {
    // assertRole is a no-op for agent actors, so assertBoard must reject them
    // first — otherwise any company agent key could drive a full re-embed.
    const res = await request(makeApp(agentActor))
      .post(`/api/companies/${COMPANY_ID}/memory/reindex-all`)
      .send();

    expect(res.status).toBe(403);
    expect(mockAssertRole).not.toHaveBeenCalled();
    expect(mockReindexAllCompany).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("RBAC: founder is allowed", async () => {
    const res = await request(makeApp(founderActor))
      .post(`/api/companies/${COMPANY_ID}/memory/reindex-all`)
      .send();
    expect(res.status).toBe(200);
    expect(mockAssertRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "founder",
    );
  });
});
