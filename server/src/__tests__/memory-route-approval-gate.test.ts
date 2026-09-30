/**
 * Memory route — approval-decision authority gate (Codex #201 P1 / R5).
 *
 * PR #199 made `canApproveMemory` founder-only for `domain` (leads → active_context
 * only). The create/update routes accept a client-supplied `status`/`layer` and gate
 * only on `canAccessMemory` (which lets a lead write `domain` in their dept), so an
 * approval decision could be reached without founder authority via several paths:
 *   1. explicit `status: "approved"` on create/update;
 *   2. `source: "founder"` on create with no status — memoryService.create defaults
 *      founder-source items to "approved" (Codex P1 #3);
 *   3. PATCHing the layer/department of an already-approved item into a scope the
 *      actor cannot approve (Codex P1 #4).
 * The fix routes any such EFFECTIVE approval decision through `assertMemoryApproval`.
 *
 * These tests assert the WIRING (the gate fires with the right layer/dept iff the
 * operation asserts/relocates an approval decision, and a denial → 403). The approval
 * DECISION itself (lead cannot approve domain) is unit-tested in permissions.test.ts;
 * here `assertMemoryApproval` is a controllable spy.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  __esModule: true,
  default: {},
  embeddingQueue: makeTableProxy("embedding_queue"),
  memoryItems: makeTableProxy("memory_items"),
  ...new Proxy(
    {},
    {
      get: (_t, prop: string) => (typeof prop === "string" ? makeTableProxy(prop) : undefined),
    },
  ),
}));

const mockMemoryService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  restore: vi.fn(),
  publishDraft: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  approveSuggestedVersion: vi.fn(),
  rejectSuggestedVersion: vi.fn(),
  changeLayer: vi.fn(),
}));
const mockAssertMemoryApproval = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAssertMemoryAccess = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  memoryService: () => mockMemoryService,
  companyBrainGraphService: () => ({}),
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

// memory.ts (Task W4) imports these — mock to avoid pulling in unregistered db exports.
vi.mock("../services/embeddings-backfill.js", () => ({
  reindexCompany: vi.fn().mockResolvedValue({ requeuedFailed: 0, enqueuedMissing: 0 }),
}));

vi.mock("../services/memory-write.js", () => ({
  enqueueMemoryEmbedding: vi.fn().mockResolvedValue(undefined),
  writeMemoryAndIndex: vi.fn(),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertMemoryAccess: mockAssertMemoryAccess,
  assertMemoryApproval: mockAssertMemoryApproval,
  assertRole: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../middleware/validate.js", () => ({
  validate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("./authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn(() => ({ actorType: "board", actorId: "u-lead", agentId: null, runId: null })),
}));

import { memoryRoutes } from "../routes/memory.js";
import { errorHandler } from "../middleware/index.js";
import { forbidden } from "../errors.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_ID = "11111111-1111-4111-8111-111111111111";

const boardActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "u-lead",
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = boardActor;
    next();
  });
  app.use("/api", memoryRoutes({} as never));
  app.use(errorHandler);
  return app;
}

// Non-founder, non-agent source → memoryService.create defaults status to "pending".
const basePost = {
  title: "t",
  content: "c",
  category: "coding",
  source: "external",
  layer: "domain",
  departmentId: "dep-a",
};

const post = (body: Record<string, unknown>) =>
  request(makeApp()).post(`/api/companies/${COMPANY_ID}/memory`).send(body);
const patch = (body: Record<string, unknown>) =>
  request(makeApp()).patch(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}`).send(body);

describe("memory routes — approval-decision authority gate (Codex #201 P1 / R5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertMemoryApproval.mockResolvedValue(undefined);
    mockAssertMemoryAccess.mockResolvedValue(undefined);
    mockMemoryService.create.mockResolvedValue({
      id: ITEM_ID,
      title: "t",
      category: "coding",
      source: "external",
      status: "pending",
    });
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "domain",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "pending",
    });
    mockMemoryService.update.mockResolvedValue({ id: ITEM_ID, title: "t" });
    mockMemoryService.restore.mockResolvedValue({ id: ITEM_ID, title: "t", status: "approved" });
    mockMemoryService.publishDraft.mockResolvedValue({ id: "ver-1", status: "approved" });
    mockMemoryService.approve.mockResolvedValue({ id: ITEM_ID, title: "t", status: "approved" });
    mockMemoryService.reject.mockResolvedValue({ id: ITEM_ID, title: "t", status: "rejected" });
    mockMemoryService.approveSuggestedVersion.mockResolvedValue({ id: "ver-1", status: "approved" });
    mockMemoryService.rejectSuggestedVersion.mockResolvedValue({ id: "ver-1", status: "rejected" });
    mockMemoryService.changeLayer.mockResolvedValue({ id: ITEM_ID, layer: "working" });
  });

  const restore = () =>
    request(makeApp()).post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/restore`).send({});
  const publish = () =>
    request(makeApp()).post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/publish`).send({});
  const approve = () =>
    request(makeApp()).post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/approve`).send({});
  const reject = () =>
    request(makeApp()).post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/reject`).send({});
  const versionApprove = () =>
    request(makeApp()).post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/versions/ver-1/approve`).send({});
  const versionReject = () =>
    request(makeApp()).post(`/api/companies/${COMPANY_ID}/memory/${ITEM_ID}/versions/ver-1/reject`).send({});
  const changeLayer = (newLayer: string) =>
    request(makeApp()).post(`/api/companies/${COMPANY_ID}/memory/items/${ITEM_ID}/change-layer`).send({ newLayer });

  // ── POST /memory ──────────────────────────────────────────────────────────
  it("POST explicit status=approved → gate fires with the requested layer/dept", async () => {
    await post({ ...basePost, status: "approved" }).expect(201);
    expect(mockAssertMemoryApproval).toHaveBeenCalledTimes(1);
    expect(mockAssertMemoryApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      { layer: "domain", departmentId: "dep-a" },
    );
  });

  it("POST explicit status=approved → 403 when the gate throws; create not called", async () => {
    mockAssertMemoryApproval.mockRejectedValue(forbidden("nope"));
    await post({ ...basePost, status: "approved" }).expect(403);
    expect(mockMemoryService.create).not.toHaveBeenCalled();
  });

  it("POST explicit status=rejected → gate fires (rejection is an approval decision)", async () => {
    await post({ ...basePost, status: "rejected" }).expect(201);
    expect(mockAssertMemoryApproval).toHaveBeenCalledTimes(1);
  });

  it("POST source=founder with NO status → gate fires (effective status defaults to approved) (Codex #3)", async () => {
    await post({ ...basePost, source: "founder" }).expect(201);
    expect(mockAssertMemoryApproval).toHaveBeenCalledTimes(1);
    expect(mockAssertMemoryApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      { layer: "domain", departmentId: "dep-a" },
    );
  });

  it("POST non-founder source, no status → gate NOT fired (effective pending)", async () => {
    await post({ ...basePost }).expect(201);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
  });

  it("POST non-founder source, status=pending → gate NOT fired", async () => {
    await post({ ...basePost, status: "pending" }).expect(201);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
  });

  // ── PATCH /memory/:id ─────────────────────────────────────────────────────
  it("PATCH status=approved → gate fires with the effective layer/dept", async () => {
    await patch({ status: "approved" }).expect(200);
    expect(mockAssertMemoryApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      { layer: "domain", departmentId: "dep-a" },
    );
  });

  it("PATCH status=approved → 403 when gate throws; update not called", async () => {
    mockAssertMemoryApproval.mockRejectedValue(forbidden("nope"));
    await patch({ status: "approved" }).expect(403);
    expect(mockMemoryService.update).not.toHaveBeenCalled();
  });

  it("PATCH status=approved + re-specified layer → gate uses the effective (patch) layer", async () => {
    await patch({ layer: "active_context", status: "approved" }).expect(200);
    expect(mockAssertMemoryApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      { layer: "active_context", departmentId: "dep-a" },
    );
  });

  it("PATCH layer:domain on an already-approved active_context item → gate fires for the TARGET scope (Codex #4)", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "active_context",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "approved",
    });
    await patch({ layer: "domain" }).expect(200);
    expect(mockAssertMemoryApproval).toHaveBeenCalledTimes(1);
    expect(mockAssertMemoryApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      { layer: "domain", departmentId: "dep-a" },
    );
  });

  it("PATCH content-only on an already-approved item → gate NOT fired (decision not moved)", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "domain",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "approved",
    });
    await patch({ content: "new content" }).expect(200);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
  });

  it("PATCH status=pending → gate NOT fired", async () => {
    await patch({ content: "x", status: "pending" }).expect(200);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
  });

  // ── POST /memory/:id/restore (restore → approved) ─────────────────────────
  it("POST /restore → gate fires with the item's layer/dept (restore yields approved) (Codex archived/restore P1)", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "domain",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "archived",
    });
    await restore().expect(200);
    expect(mockAssertMemoryApproval).toHaveBeenCalledTimes(1);
    expect(mockAssertMemoryApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      { layer: "domain", departmentId: "dep-a" },
    );
  });

  it("POST /restore → 403 when the actor cannot approve that layer; restore not called", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "domain",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "archived",
    });
    mockAssertMemoryApproval.mockRejectedValue(forbidden("nope"));
    await restore().expect(403);
    expect(mockMemoryService.restore).not.toHaveBeenCalled();
  });

  it("POST /restore → 404 when the item does not exist; gate not reached", async () => {
    mockMemoryService.getById.mockResolvedValue(null);
    await restore().expect(404);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
    expect(mockMemoryService.restore).not.toHaveBeenCalled();
  });

  // ── POST /memory/:id/publish (publishDraft → version approved) ─────────────
  it("POST /publish → gate fires with the item's layer/dept (publish approves a version edit) (Codex publish P1)", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "domain",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "approved",
    });
    await publish().expect(200);
    expect(mockAssertMemoryApproval).toHaveBeenCalledTimes(1);
    expect(mockAssertMemoryApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      { layer: "domain", departmentId: "dep-a" },
    );
  });

  it("POST /publish → 403 when the actor cannot approve that layer; publishDraft not called", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "domain",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "approved",
    });
    mockAssertMemoryApproval.mockRejectedValue(forbidden("nope"));
    await publish().expect(403);
    expect(mockMemoryService.publishDraft).not.toHaveBeenCalled();
  });

  // ── `working` layer is NOT approval-gated (Codex #201 P2) ──────────────────
  it("POST working-layer with status=approved → gate NOT fired (working is not approval-gated)", async () => {
    await post({ ...basePost, layer: "working", status: "approved" }).expect(201);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
  });

  it("PATCH status=approved on a working-layer item → gate NOT fired", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "working",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "pending",
    });
    await patch({ status: "approved" }).expect(200);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
  });

  it("POST /restore on a working-layer item → gate NOT fired", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "working",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "archived",
    });
    await restore().expect(200);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
    expect(mockMemoryService.restore).toHaveBeenCalled();
  });

  it("POST /publish on a working-layer item → gate NOT fired", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "working",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "approved",
    });
    await publish().expect(200);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
    expect(mockMemoryService.publishDraft).toHaveBeenCalled();
  });

  // ── /approve + /reject also skip working (Decision #52: working = no approval) ──
  it("POST /approve on a working-layer item → approval gate skipped but ACCESS check still enforced; approve proceeds", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "working",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "pending",
    });
    await approve().expect(200);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
    // working is not approval-gated, but must still be access-controlled (Codex P1):
    expect(mockAssertMemoryAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "update",
      { layer: "working", departmentId: "dep-a" },
    );
    expect(mockMemoryService.approve).toHaveBeenCalled();
  });

  it("POST /approve on a working-layer item → 403 when the access check denies; approve not called", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "working",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "pending",
    });
    mockAssertMemoryAccess.mockRejectedValue(forbidden("no access"));
    await approve().expect(403);
    expect(mockMemoryService.approve).not.toHaveBeenCalled();
  });

  it("POST /approve on a domain item → gate STILL fires (regression guard)", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "domain",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "pending",
    });
    await approve().expect(200);
    expect(mockAssertMemoryApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      { layer: "domain", departmentId: "dep-a" },
    );
  });

  it("POST /reject on a working-layer item → gate NOT fired; reject proceeds", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "working",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "pending",
    });
    await reject().expect(200);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
    expect(mockMemoryService.reject).toHaveBeenCalled();
  });

  it("POST /reject on a domain item → gate STILL fires (regression guard)", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "domain",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "pending",
    });
    await reject().expect(200);
    expect(mockAssertMemoryApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      { layer: "domain", departmentId: "dep-a" },
    );
  });

  // ── version approve/reject on a working item also skip (saveDraft has no layer guard) ──
  it("POST /versions/:id/approve on a working-layer item → gate NOT fired", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "working",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "approved",
    });
    await versionApprove().expect(200);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
    expect(mockMemoryService.approveSuggestedVersion).toHaveBeenCalled();
  });

  it("POST /versions/:id/approve on a domain item → gate STILL fires (regression guard)", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "domain",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "approved",
    });
    await versionApprove().expect(200);
    expect(mockAssertMemoryApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      { layer: "domain", departmentId: "dep-a" },
    );
  });

  it("POST /versions/:id/reject on a working-layer item → gate NOT fired", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "working",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "approved",
    });
    await versionReject().expect(200);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
    expect(mockMemoryService.rejectSuggestedVersion).toHaveBeenCalled();
  });

  // ── change-layer: a WORKING destination is access-checked, not approval-gated ──
  it("POST /change-layer to working → approval gate skipped, ACCESS check enforced", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "domain",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "approved",
    });
    await changeLayer("working").expect(200);
    expect(mockAssertMemoryApproval).not.toHaveBeenCalled();
    expect(mockAssertMemoryAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "update",
      { layer: "domain", departmentId: "dep-a" },
    );
  });

  it("POST /change-layer to a non-working destination (domain) → gate STILL fires on destination", async () => {
    mockMemoryService.getById.mockResolvedValue({
      id: ITEM_ID,
      layer: "active_context",
      departmentId: "dep-a",
      visibility: "scoped",
      status: "approved",
    });
    await changeLayer("domain").expect(200);
    expect(mockAssertMemoryApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      { layer: "domain", departmentId: "dep-a" },
    );
  });
});
