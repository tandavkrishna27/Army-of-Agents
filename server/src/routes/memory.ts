import { Router } from "express";
import type { Db } from "@armyofagents/db";
import {
  createMemoryItemSchema,
  companyBrainNeighborQuerySchema,
  companyBrainOverviewQuerySchema,
  createCompanyBrainSemanticEdgeSchema,
  memoryFolderUpdateSchema,
  suggestMemoryArchiveSchema,
  suggestMemoryUpdateSchema,
  updateCompanyBrainSemanticEdgeSchema,
  updateMemoryItemSchema,
  type CompanyBrainEdgeKind,
} from "@armyofagents/shared";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";
import { companyBrainGraphService, memoryService, logActivity } from "../services/index.js";
import { resolveSemanticAvailable } from "../services/memory-index-status.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertMemoryAccess, assertMemoryApproval, assertRole } from "../middleware/rbac.js";
import { embeddingSearchLimiter } from "../middleware/rate-limit.js";
import { reindexCompany, reindexAllCompany } from "../services/embeddings-backfill.js";
import { enqueueMemoryEmbedding } from "../services/memory-write.js";
import { eq, and, inArray } from "drizzle-orm";
import { embeddingQueue } from "@armyofagents/db";

function resolveAgentRequestId(
  req: Parameters<typeof getActorInfo>[0],
  requestedAgentId?: string,
) {
  if (req.actor.type !== "agent") {
    return requestedAgentId ?? null;
  }

  const authenticatedAgentId = req.actor.agentId ?? null;
  if (!authenticatedAgentId) {
    throw forbidden("Authenticated agent is missing an agentId");
  }
  if (requestedAgentId && requestedAgentId !== authenticatedAgentId) {
    throw forbidden("Agents may only submit suggestions for themselves");
  }

  return authenticatedAgentId;
}

// Statuses whose assignment IS an approval decision. Setting one on create/update
// requires the SAME authority as the dedicated approve/reject routes (canApproveMemory)
// — otherwise a non-founder could POST/PATCH a `domain` item straight to "approved" and
// bypass the founder-only gate this PR enforces (R5, #199). (Codex #201 P1.)
const APPROVAL_DECISION_STATUSES = new Set(["approved", "rejected"]);

// `working` memory is auto-created and explicitly NOT approval-gated — canApproveMemory
// only gates identity/domain/active_context (permissions.ts), so a scoped lead manages
// working memory directly. An approved/rejected write to a working-layer item must
// therefore skip the founder/lead approval gate (it would wrongly 403); normal memory
// access checks still apply. (Codex #201 P2.)
const requiresApprovalGate = (
  status: string | null | undefined,
  layer: string | null | undefined,
) => typeof status === "string" && APPROVAL_DECISION_STATUSES.has(status) && layer !== "working";

export function memoryRoutes(db: Db) {
  const router = Router();
  const svc = memoryService(db);
  const graphSvc = companyBrainGraphService(db);

  // Semantic search — must be before /:id route
  router.get("/companies/:companyId/memory/search", embeddingSearchLimiter, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const q = req.query.q as string | undefined;
    if (!q || !q.trim()) {
      res.status(400).json({ error: "Query parameter 'q' is required" });
      return;
    }
    const filters = {
      layer: req.query.layer as string | undefined,
      departmentId: req.query.departmentId as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };
    const results = await svc.searchSemantic(companyId, q.trim(), filters);
    res.json(results);
  });

  // Find similar items — must be before /:id route
  router.get("/companies/:companyId/memory/find-similar", embeddingSearchLimiter, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const content = req.query.content as string | undefined;
    if (!content || !content.trim()) {
      res.status(400).json({ error: "Query parameter 'content' is required" });
      return;
    }
    const scope = {
      companyId,
      departmentId: req.query.departmentId as string | undefined,
      layer: req.query.layer as string | undefined,
    };
    const results = await svc.findSimilarItems(content.trim(), scope);
    res.json(results);
  });

  router.get("/companies/:companyId/memory", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertMemoryAccess(db, req, companyId, "read");
    const filters = {
      category: req.query.category as string | undefined,
      status: req.query.status as string | undefined,
      source: req.query.source as string | undefined,
      departmentId: req.query.departmentId as string | undefined,
      projectId: req.query.projectId as string | undefined,
      layer: req.query.layer as string | undefined,
      tags: req.query.tags ? (req.query.tags as string).split(",") : undefined,
      search: req.query.search as string | undefined,
    };
    const [items, semanticAvailable] = await Promise.all([
      svc.list(companyId, filters),
      resolveSemanticAvailable(db, companyId),
    ]);
    res.json({ items, semanticAvailable });
  });

  router.get("/companies/:companyId/memory-pending", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertMemoryAccess(db, req, companyId, "read");
    const result = await svc.listPending(companyId);
    res.json(result);
  });

  router.get("/companies/:companyId/memory/items/:id/neighbors", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    await assertMemoryAccess(db, req, companyId, "read");

    const parsed = companyBrainNeighborQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const principalId =
      req.actor.type === "agent"
        ? req.actor.agentId ?? "unknown-agent"
        : req.actor.type === "mcp"
          ? req.actor.userId ?? "mcp-user"
          : req.actor.userId ?? "local-board";

    const graph = await graphSvc.getMemoryItemNeighbors(companyId, id, {
      type: req.actor.type === "agent" ? "agent" : "user",
      principalId,
    });

    const kinds = parsed.data.kinds as CompanyBrainEdgeKind[] | undefined;
    if (!kinds || kinds.length === 0) {
      res.json(graph);
      return;
    }

    const visibleNodeKeys = new Set([
      `${graph.center.type}:${graph.center.id}`,
    ]);
    const edges = graph.edges.filter((edge) => {
      if (!kinds.includes(edge.kind)) return false;
      visibleNodeKeys.add(`${edge.from.type}:${edge.from.id}`);
      visibleNodeKeys.add(`${edge.to.type}:${edge.to.id}`);
      return true;
    });
    const nodes = graph.nodes.filter((node) => visibleNodeKeys.has(`${node.type}:${node.id}`));

    res.json({ ...graph, nodes, edges });
  });

  router.get("/companies/:companyId/memory/items/:id/usage", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    await assertMemoryAccess(db, req, companyId, "read");

    const principalId =
      req.actor.type === "agent"
        ? req.actor.agentId ?? "unknown-agent"
        : req.actor.type === "mcp"
          ? req.actor.userId ?? "mcp-user"
          : req.actor.userId ?? "local-board";

    const usage = await graphSvc.getMemoryItemUsage(companyId, id, {
      type: req.actor.type === "agent" ? "agent" : "user",
      principalId,
    });

    res.json(usage);
  });

  router.post("/companies/:companyId/memory/graph/edges", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertMemoryAccess(db, req, companyId, "update");

    const parsed = createCompanyBrainSemanticEdgeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const actor = getActorInfo(req);
    const edge = await graphSvc.createSemanticEdge(companyId, parsed.data, {
      type: actor.actorType === "agent" ? "agent" : "user",
      principalId: actor.actorId,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company_brain_edge.created",
      entityType: "company_brain_edge",
      entityId: edge.id,
      details: {
        kind: edge.kind,
        fromType: edge.fromType,
        fromId: edge.fromId,
        toType: edge.toType,
        toId: edge.toId,
      },
    });

    res.status(201).json(edge);
  });

  router.patch("/companies/:companyId/memory/graph/edges/:edgeId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const edgeId = req.params.edgeId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertMemoryAccess(db, req, companyId, "update");

    const parsed = updateCompanyBrainSemanticEdgeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const actor = getActorInfo(req);
    const edge = await graphSvc.updateSemanticEdge(companyId, edgeId, parsed.data);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company_brain_edge.updated",
      entityType: "company_brain_edge",
      entityId: edge.id,
      details: { kind: edge.kind },
    });

    res.json(edge);
  });

  router.delete("/companies/:companyId/memory/graph/edges/:edgeId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const edgeId = req.params.edgeId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertMemoryAccess(db, req, companyId, "update");

    const actor = getActorInfo(req);
    const edge = await graphSvc.archiveSemanticEdge(companyId, edgeId);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company_brain_edge.archived",
      entityType: "company_brain_edge",
      entityId: edge.id,
      details: { kind: edge.kind },
    });

    res.json(edge);
  });

  router.get("/companies/:companyId/memory/graph", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertMemoryAccess(db, req, companyId, "read");

    const parsed = companyBrainOverviewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const principalId =
      req.actor.type === "agent"
        ? req.actor.agentId ?? "unknown-agent"
        : req.actor.type === "mcp"
          ? req.actor.userId ?? "mcp-user"
          : req.actor.userId ?? "local-board";

    const graph = await graphSvc.getCompanyGraphOverview(companyId, {
      type: req.actor.type === "agent" ? "agent" : "user",
      principalId,
    }, parsed.data);

    res.json(graph);
  });

  router.get("/companies/:companyId/memory/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    await assertMemoryAccess(db, req, companyId, "read");
    const item = await svc.getById(companyId, id);
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    res.json(item);
  });

  router.post("/companies/:companyId/memory", validate(createMemoryItemSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertMemoryAccess(db, req, companyId, "create", {
      layer: req.body.layer,
      departmentId: req.body.departmentId,
    });
    // R5 (#199): a create that RESULTS in an approval-decision status (approved/
    // rejected) requires approval authority for the target layer. This MUST use the
    // EFFECTIVE status, not just an explicit `status` field: memoryService.create
    // defaults founder-source items to "approved" even when the request omits
    // `status`, so a non-founder posting source:"founder" would otherwise mint
    // approved memory (Codex #201 P1). The computation mirrors memoryService.create.
    // Founders pass for all layers; team leads only for active_context.
    const source = req.actor.type === "agent" ? "agent" : req.body.source;
    const effectiveCreateStatus =
      source === "agent"
        ? "pending"
        : (req.body.status ?? (source === "founder" ? "approved" : "pending"));
    if (requiresApprovalGate(effectiveCreateStatus, req.body.layer)) {
      await assertMemoryApproval(db, req, companyId, {
        layer: req.body.layer,
        departmentId: req.body.departmentId,
      });
    }
    const actor = getActorInfo(req);
    const item = await svc.create(companyId, {
      ...req.body,
      source,
      createdBy: actor.actorId,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.created",
      entityType: "memory_item",
      entityId: item.id,
      details: { title: item.title, category: item.category, source: item.source, status: item.status },
    });
    res.status(201).json(item);
  });

  router.patch("/companies/:companyId/memory/:id", validate(updateMemoryItemSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const existing = await svc.getById(companyId, id);
    if (!existing) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    await assertMemoryAccess(db, req, companyId, "update", {
      layer: existing.layer,
      departmentId: existing.departmentId,
      visibility: existing.visibility,
    });
    // R5 (#199): re-check approval authority when the patch ASSERTS or RELOCATES an
    // approval decision, against the EFFECTIVE (post-patch) layer/dept. Fires when
    // (a) the patch sets status to approved/rejected, or (b) the item is already
    // approved/rejected and the patch moves its layer or department — otherwise a lead
    // could PATCH only layer:"domain" on an approved active_context item and leave it
    // approved in a layer they cannot approve (Codex #201 P1). A plain content edit of
    // an already-approved item does not move the decision and is not gated here.
    const effectiveLayer = req.body.layer !== undefined ? req.body.layer : existing.layer;
    const effectiveDepartmentId =
      req.body.departmentId !== undefined ? req.body.departmentId : existing.departmentId;
    const effectiveStatus =
      typeof req.body.status === "string" ? req.body.status : existing.status;
    const settingDecisionStatus =
      typeof req.body.status === "string" && APPROVAL_DECISION_STATUSES.has(req.body.status);
    const relocatingDecisionItem =
      APPROVAL_DECISION_STATUSES.has(effectiveStatus ?? "") &&
      ((req.body.layer !== undefined && req.body.layer !== existing.layer) ||
        (req.body.departmentId !== undefined && req.body.departmentId !== existing.departmentId));
    if ((settingDecisionStatus || relocatingDecisionItem) && effectiveLayer !== "working") {
      await assertMemoryApproval(db, req, companyId, {
        layer: effectiveLayer,
        departmentId: effectiveDepartmentId,
      });
    }
    const item = await svc.update(companyId, id, req.body);
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.updated",
      entityType: "memory_item",
      entityId: item.id,
      details: req.body,
    });
    res.json(item);
  });

  router.delete("/companies/:companyId/memory/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const existing = await svc.getById(companyId, id);
    if (!existing) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    await assertMemoryAccess(db, req, companyId, "delete", {
      layer: existing.layer,
      departmentId: existing.departmentId,
      visibility: existing.visibility,
    });
    const item = await svc.remove(companyId, id);
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.deleted",
      entityType: "memory_item",
      entityId: item.id,
      details: { title: item.title },
    });
    res.json(item);
  });

  router.post("/companies/:companyId/memory/:id/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const existing = await svc.getById(companyId, id);
    if (!existing) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    // Decision #52: working memory is auto-created and needs no approval, so the
    // approve action is not founder/lead-gated for working items (a scoped lead can
    // clear a pending working suggestion). identity/domain/active_context still gate.
    if (requiresApprovalGate("approved", existing.layer)) {
      await assertMemoryApproval(db, req, companyId, {
        layer: existing.layer,
        departmentId: existing.departmentId,
      });
    } else {
      // working is not approval-gated (Decision #52), but it must still be access-
      // controlled — these routes have only assertCompanyAccess, so skipping the gate
      // outright would let any company member/agent approve a working row. Require
      // manage-access to the item instead. (Codex #201 P1.)
      await assertMemoryAccess(db, req, companyId, "update", {
        layer: existing.layer,
        departmentId: existing.departmentId,
      });
    }
    const item = await svc.approve(companyId, id);
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.approved",
      entityType: "memory_item",
      entityId: item.id,
      details: { title: item.title },
    });
    res.json(item);
  });

  router.post("/companies/:companyId/memory/:id/reject", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const existing = await svc.getById(companyId, id);
    if (!existing) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    // Decision #52: working memory needs no approval — reject is not founder/lead-gated
    // for working items (parallels /approve). identity/domain/active_context still gate.
    if (requiresApprovalGate("rejected", existing.layer)) {
      await assertMemoryApproval(db, req, companyId, {
        layer: existing.layer,
        departmentId: existing.departmentId,
      });
    } else {
      // working is not approval-gated (Decision #52), but it must still be access-
      // controlled — these routes have only assertCompanyAccess, so skipping the gate
      // outright would let any company member/agent approve a working row. Require
      // manage-access to the item instead. (Codex #201 P1.)
      await assertMemoryAccess(db, req, companyId, "update", {
        layer: existing.layer,
        departmentId: existing.departmentId,
      });
    }
    const item = await svc.reject(companyId, id);
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.rejected",
      entityType: "memory_item",
      entityId: item.id,
      details: { title: item.title },
    });
    res.json(item);
  });

  router.post(
    "/companies/:companyId/memory/:id/suggest-update",
    validate(suggestMemoryUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);
      const existing = await svc.getById(companyId, id);
      if (!existing) {
        res.status(404).json({ error: "Memory item not found" });
        return;
      }
      await assertMemoryAccess(db, req, companyId, "create", {
        layer: existing.layer,
        departmentId: existing.departmentId,
        visibility: existing.visibility,
      });
      const actor = getActorInfo(req);
      const agentId = resolveAgentRequestId(req, req.body.agentId);
      if (!agentId) {
        throw forbidden("agentId is required");
      }
      const version = await svc.suggestUpdate(
        companyId,
        id,
        req.body.content,
        req.body.sourceContext,
        agentId,
      );
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "memory.update_suggested",
        entityType: "memory_item",
        entityId: id,
        details: {
          versionId: version.id,
          versionNumber: version.versionNumber,
          agentId,
          sourceContext: req.body.sourceContext,
        },
      });
      res.status(201).json(version);
    },
  );

  router.post(
    "/companies/:companyId/memory/:id/suggest-archive",
    validate(suggestMemoryArchiveSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);
      const existing = await svc.getById(companyId, id);
      if (!existing) {
        res.status(404).json({ error: "Memory item not found" });
        return;
      }
      await assertMemoryAccess(db, req, companyId, "create", {
        layer: existing.layer,
        departmentId: existing.departmentId,
        visibility: existing.visibility,
      });
      const actor = getActorInfo(req);
      const agentId = resolveAgentRequestId(req, req.body.agentId);
      if (!agentId) {
        throw forbidden("agentId is required");
      }
      const suggestion = await svc.suggestArchive(
        companyId,
        id,
        req.body.sourceContext,
        agentId,
      );
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "memory.archive_suggested",
        entityType: "memory_item",
        entityId: id,
        details: {
          suggestionId: suggestion.id,
          agentId,
          sourceContext: req.body.sourceContext,
        },
      });
      res.status(201).json(suggestion);
    },
  );

  // ── Version management ──────────────────────────────────────────────

  router.get("/companies/:companyId/memory/:id/versions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const item = await svc.getById(companyId, id);
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    const versions = await svc.getVersionHistory(id);
    res.json(versions);
  });

  router.post("/companies/:companyId/memory/:id/draft", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const actor = getActorInfo(req);
    const { content } = req.body;
    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "content is required" });
      return;
    }
    const version = await svc.saveDraft(companyId, id, content, actor.actorId);
    if (!version) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.draft_saved",
      entityType: "memory_item",
      entityId: id,
      details: { versionNumber: version.versionNumber },
    });
    res.json(version);
  });

  router.post("/companies/:companyId/memory/:id/publish", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    // R5 (#199): publishing a draft marks a version `approved` and swaps the item's
    // current content — an approval decision on this memory item — so it needs the same
    // authority as the version-approve route, for the item's layer/dept (Codex #201 P1).
    const existing = await svc.getById(companyId, id);
    if (!existing) {
      res.status(404).json({ error: "Memory item or draft not found" });
      return;
    }
    if (requiresApprovalGate("approved", existing.layer)) {
      await assertMemoryApproval(db, req, companyId, {
        layer: existing.layer,
        departmentId: existing.departmentId,
      });
    } else {
      // working is not approval-gated (Decision #52), but it must still be access-
      // controlled — these routes have only assertCompanyAccess, so skipping the gate
      // outright would let any company member/agent approve a working row. Require
      // manage-access to the item instead. (Codex #201 P1.)
      await assertMemoryAccess(db, req, companyId, "update", {
        layer: existing.layer,
        departmentId: existing.departmentId,
      });
    }
    const actor = getActorInfo(req);
    const version = await svc.publishDraft(companyId, id, actor.actorId);
    if (!version) {
      res.status(404).json({ error: "Memory item or draft not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.draft_published",
      entityType: "memory_item",
      entityId: id,
      details: { versionNumber: version.versionNumber },
    });
    res.json(version);
  });

  router.post("/companies/:companyId/memory/:id/versions/:versionId/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    const versionId = req.params.versionId as string;
    await assertCompanyAccess(db, req, companyId);
    const existing = await svc.getById(companyId, id);
    if (!existing) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    // Decision #52: working memory needs no approval — version approve/reject of a
    // working item (saveDraft has no layer guard) is not founder/lead-gated. Other
    // layers gate as before.
    if (requiresApprovalGate("approved", existing.layer)) {
      await assertMemoryApproval(db, req, companyId, {
        layer: existing.layer,
        departmentId: existing.departmentId,
      });
    } else {
      // working is not approval-gated (Decision #52), but it must still be access-
      // controlled — these routes have only assertCompanyAccess, so skipping the gate
      // outright would let any company member/agent approve a working row. Require
      // manage-access to the item instead. (Codex #201 P1.)
      await assertMemoryAccess(db, req, companyId, "update", {
        layer: existing.layer,
        departmentId: existing.departmentId,
      });
    }
    const actor = getActorInfo(req);
    const version = await svc.approveSuggestedVersion(companyId, id, versionId);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.version_approved",
      entityType: "memory_item",
      entityId: id,
      details: {
        versionId: version.id,
        versionNumber: version.versionNumber,
      },
    });
    res.json(version);
  });

  router.post("/companies/:companyId/memory/:id/versions/:versionId/reject", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    const versionId = req.params.versionId as string;
    await assertCompanyAccess(db, req, companyId);
    const existing = await svc.getById(companyId, id);
    if (!existing) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    // Decision #52: working memory needs no approval — version reject of a working
    // item is not founder/lead-gated (parallels version approve). Other layers gate.
    if (requiresApprovalGate("rejected", existing.layer)) {
      await assertMemoryApproval(db, req, companyId, {
        layer: existing.layer,
        departmentId: existing.departmentId,
      });
    } else {
      // working is not approval-gated (Decision #52), but it must still be access-
      // controlled — these routes have only assertCompanyAccess, so skipping the gate
      // outright would let any company member/agent approve a working row. Require
      // manage-access to the item instead. (Codex #201 P1.)
      await assertMemoryAccess(db, req, companyId, "update", {
        layer: existing.layer,
        departmentId: existing.departmentId,
      });
    }
    const actor = getActorInfo(req);
    const version = await svc.rejectSuggestedVersion(companyId, id, versionId);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.version_rejected",
      entityType: "memory_item",
      entityId: id,
      details: {
        versionId: version.id,
        versionNumber: version.versionNumber,
      },
    });
    res.json(version);
  });

  router.post("/companies/:companyId/memory/:id/restore", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    // R5 (#199): restore sets the item's status → "approved", so it requires the same
    // approval authority as the approve route, for the item's layer/dept. Without this
    // a non-founder could write a domain item as `status:"archived"` (which the create
    // gate does not treat as an approval decision) and then restore it to approved,
    // bypassing the founder-only domain gate (Codex #201 P1).
    const existing = await svc.getById(companyId, id);
    if (!existing) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    if (requiresApprovalGate("approved", existing.layer)) {
      await assertMemoryApproval(db, req, companyId, {
        layer: existing.layer,
        departmentId: existing.departmentId,
      });
    } else {
      // working is not approval-gated (Decision #52), but it must still be access-
      // controlled — these routes have only assertCompanyAccess, so skipping the gate
      // outright would let any company member/agent approve a working row. Require
      // manage-access to the item instead. (Codex #201 P1.)
      await assertMemoryAccess(db, req, companyId, "update", {
        layer: existing.layer,
        departmentId: existing.departmentId,
      });
    }
    const item = await svc.restore(companyId, id);
    if (!item) {
      res.status(404).json({ error: "Memory item not found or not archived" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.restored",
      entityType: "memory_item",
      entityId: item.id,
      details: { title: item.title },
    });
    res.json(item);
  });

  router.post("/companies/:companyId/memory/:id/touch", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const item = await svc.touchAccessedAt(companyId, id);
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    res.json(item);
  });

  // Phase 6: tree move + pin-to-top
  router.patch(
    "/companies/:companyId/memory/items/:id/move",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        await assertCompanyAccess(db, req, companyId);
        const moveBodySchema = z.object({
          folderPath: z.string().min(1).max(512),
        });
        const parsed = moveBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        // Validate path shape via the shared validator.
        const pathCheck = memoryFolderUpdateSchema.pick({ path: true }).safeParse({ path: parsed.data.folderPath });
        if (!pathCheck.success) {
          res.status(400).json({ error: pathCheck.error.flatten() });
          return;
        }
        const updated = await svc.moveItem(id, companyId, parsed.data.folderPath);
        if (!updated) {
          res.status(404).json({ error: "Memory item not found" });
          return;
        }
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/companies/:companyId/memory/items/:id/pin-to-top",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        await assertCompanyAccess(db, req, companyId);
        const parsed = z.object({ pinned: z.boolean() }).safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        const updated = await svc.setPinnedToTop(id, companyId, parsed.data.pinned);
        if (!updated) {
          res.status(404).json({ error: "Memory item not found" });
          return;
        }
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/companies/:companyId/memory/items/:id/change-layer",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        await assertCompanyAccess(db, req, companyId);
        const bodySchema = z.object({
          newLayer: z.enum(["identity", "domain", "active_context", "working"]),
          departmentId: z.string().nullable().optional(),
          goalId: z.string().nullable().optional(),
          taskId: z.string().nullable().optional(),
          expiresAt: z
            .union([z.string().datetime(), z.date(), z.null()])
            .optional()
            .transform((v) => (typeof v === "string" ? new Date(v) : v ?? null)),
        });
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        // Phase 6.2c follow-up: a layer change is effectively a re-classification
        // / re-approval at a different layer (e.g. promoting a working note to a
        // domain policy). Match the approve/reject pattern and gate on the
        // SAME role check (founder, or team_lead for the destination dept).
        const existing = await svc.getById(companyId, id);
        if (!existing) {
          res.status(404).json({ error: "Memory item not found" });
          return;
        }
        // Decision #52: a `working` DESTINATION needs no approval (working is
        // auto-created/ungated), so a move TO working is gated by manage-access to the
        // item rather than approval authority — consistent with the approve/reject/etc.
        // working bypasses. Other destinations still require approval for that layer.
        // (change-layer gates on DESTINATION by existing design; the source's prior
        // governance is not re-checked here — same as the existing domain→active_context
        // path, which a lead can already perform.)
        if (parsed.data.newLayer !== "working") {
          await assertMemoryApproval(db, req, companyId, {
            layer: parsed.data.newLayer,
            departmentId:
              parsed.data.departmentId !== undefined
                ? parsed.data.departmentId
                : existing.departmentId,
          });
        } else {
          await assertMemoryAccess(db, req, companyId, "update", {
            layer: existing.layer,
            departmentId: existing.departmentId,
          });
        }
        const actor = getActorInfo(req);
        const updated = await svc.changeLayer(id, companyId, {
          ...parsed.data,
          actorId: actor.actorId ?? null,
        });
        if (!updated) {
          res.status(404).json({ error: "Memory item not found" });
          return;
        }
        // Phase 6.2c follow-up: record the layer change in the activity log so
        // it surfaces on the Activity page alongside approve/reject.
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "memory.layer_changed",
          entityType: "memory_item",
          entityId: updated.id,
          details: {
            title: updated.title,
            fromLayer: existing.layer,
            toLayer: parsed.data.newLayer,
          },
        });
        res.json(updated);
      } catch (err) {
        const e = err as Error;
        if (/required/i.test(e.message) || /invalid layer/i.test(e.message)) {
          res.status(400).json({ error: e.message });
          return;
        }
        next(err);
      }
    },
  );

  // ── Embedding re-index routes (Task W4, keyless-except-embeddings) ─────────

  /**
   * POST /companies/:companyId/memory/:id/reindex
   *
   * Re-index one memory item:
   *   - If the item has a `failed` queue row, reset it to `pending` (clears
   *     next_retry_at, attempts, error) so the worker will retry it.
   *   - Otherwise, enqueue the item via the standard dedup-guarded path.
   *
   * RBAC: founder or team_lead only.
   */
  router.post("/companies/:companyId/memory/:id/reindex", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    // Board-only (P2, Codex): assertRole is a no-op for agent actors (rbac.ts
    // returns early for type==="agent"), so without assertBoard any company agent
    // key could drive re-index. This is a founder/team_lead UI action.
    assertBoard(req);
    await assertRole(db, req, companyId, "founder", "team_lead");

    const item = await svc.getById(companyId, id);
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }

    // Department-scope (audit follow-up): assertRole above is company-wide, so a
    // team_lead of department A could otherwise re-index department B's item.
    // Re-index mutates the embedding (an "update"), so gate on the FETCHED item's
    // department/layer/visibility — the same department-aware check the sibling
    // update/delete routes use.
    await assertMemoryAccess(db, req, companyId, "update", {
      layer: item.layer,
      departmentId: item.departmentId,
      visibility: item.visibility,
    });

    // Check for an existing failed queue row for this item.
    const failedRows = await (db as any)
      .select({ id: embeddingQueue.id })
      .from(embeddingQueue)
      .where(
        and(
          eq(embeddingQueue.companyId, companyId),
          eq(embeddingQueue.targetTable, "memory_items"),
          eq(embeddingQueue.targetId, id),
          eq(embeddingQueue.targetColumn, "embedding"),
          eq(embeddingQueue.status, "failed"),
        ),
      )
      .limit(1);

    // Re-index the item's CURRENT content (P2, Codex). We deliberately do NOT
    // reset the stale failed row in place: if the item was edited and re-indexed
    // after the earlier failure, that failed row carries pre-edit inputText and
    // requeuing it would overwrite the current vector with obsolete content.
    // enqueueMemoryEmbedding composes inputText from the item's current
    // title+content and dedups against any live pending row, so the latest
    // content is always what gets embedded (matches the bulk reindex path's
    // superseding-row protection). The old failed row is left as harmless history.
    await enqueueMemoryEmbedding(db, companyId, item);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.reindex",
      entityType: "memory_item",
      entityId: id,
      details: { title: item.title, hadFailedRow: failedRows.length > 0 },
    });

    res.json({ reindexed: true });
  });

  /**
   * POST /companies/:companyId/memory/reindex-failed
   *
   * Reset ALL `failed` embedding_queue rows for this company back to `pending`,
   * clearing next_retry_at, attempts, and error so the worker drains the backlog.
   *
   * Returns { requeued: N } where N is the number of rows reset.
   *
   * RBAC: FOUNDER only (P2, Codex re-review). This is a company-wide bulk
   * operation that re-embeds failed rows across ALL departments + the identity
   * layer; a team_lead (scoped to one department) would otherwise mutate other
   * departments' memory. Department-scoped re-index is available per-item via
   * POST /memory/:id/reindex (which gates on the item's department).
   */
  router.post("/companies/:companyId/memory/reindex-failed", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    // Board-only (P2, Codex): block agent keys — assertRole no-ops for agents.
    assertBoard(req);
    await assertRole(db, req, companyId, "founder");

    // Only requeue NON-STALE failed rows (P2, Codex): skip any failed row whose
    // target already has a completed/live (pending|processing) sibling — that
    // means a NEWER row re-indexed the (possibly edited) item, so this failed
    // row's inputText is stale and requeuing it would clobber the current vector.
    // Same predicate as embeddings-backfill.reindexCompany.
    const failedRows = await (db as any)
      .select({
        id: embeddingQueue.id,
        targetTable: embeddingQueue.targetTable,
        targetId: embeddingQueue.targetId,
        targetColumn: embeddingQueue.targetColumn,
        createdAt: embeddingQueue.createdAt,
      })
      .from(embeddingQueue)
      .where(
        and(
          eq(embeddingQueue.companyId, companyId),
          eq(embeddingQueue.status, "failed"),
        ),
      );

    const supersedingRows = await (db as any)
      .select({
        targetTable: embeddingQueue.targetTable,
        targetId: embeddingQueue.targetId,
        targetColumn: embeddingQueue.targetColumn,
        createdAt: embeddingQueue.createdAt,
      })
      .from(embeddingQueue)
      .where(
        and(
          eq(embeddingQueue.companyId, companyId),
          inArray(embeddingQueue.status, ["completed", "pending", "processing"]),
        ),
      );

    // Recency-aware suppression (P2, Codex): a failed row is stale only if a
    // completed/live sibling is NEWER than it. The newest failed attempt for a
    // target must still be requeued even if an OLDER completed row exists.
    const tkey = (r: { targetTable: string; targetId: string; targetColumn: string }) =>
      `${r.targetTable} ${r.targetId} ${r.targetColumn}`;
    const tms = (v: unknown) => (v ? new Date(v as string | Date).getTime() : 0);
    const newestSibling = new Map<string, number>();
    for (const s of supersedingRows as Array<{
      targetTable: string;
      targetId: string;
      targetColumn: string;
      createdAt: unknown;
    }>) {
      const k = tkey(s);
      const t = tms(s.createdAt);
      const prev = newestSibling.get(k);
      if (prev === undefined || t > prev) newestSibling.set(k, t);
    }
    const requeueableIds = (
      failedRows as Array<{
        id: string;
        targetTable: string;
        targetId: string;
        targetColumn: string;
        createdAt: unknown;
      }>
    )
      .filter((r) => {
        const sib = newestSibling.get(tkey(r));
        return sib === undefined || tms(r.createdAt) >= sib;
      })
      .map((r) => r.id);

    const requeued = requeueableIds.length;

    if (requeued > 0) {
      await (db as any)
        .update(embeddingQueue)
        .set({ status: "pending", nextRetryAt: null, attempts: 0, error: null })
        .where(inArray(embeddingQueue.id, requeueableIds));
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.reindex_failed",
      entityType: "company",
      entityId: companyId,
      details: { requeued },
    });

    res.json({ requeued });
  });

  /**
   * POST /companies/:companyId/memory/reindex-all
   *
   * Re-embed the company's ENTIRE memory: enqueue a fresh `pending` row for
   * every memory_item that does not already have a live (pending|processing)
   * queue row (dedup-safe). The "Re-index all" button in Settings → Memory.
   *
   * Returns { reindexed: N } where N is the number of items newly enqueued.
   *
   * RBAC: FOUNDER only. This is a company-wide bulk re-embed across ALL
   * departments + the identity layer, so (like /reindex-failed) a department-
   * scoped team_lead must not drive it. Department-scoped re-index is available
   * per-item via POST /memory/:id/reindex (which gates on the item's department).
   */
  router.post("/companies/:companyId/memory/reindex-all", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    // Board-only (P2, Codex): block agent keys — assertRole no-ops for agents.
    assertBoard(req);
    await assertRole(db, req, companyId, "founder");

    const { enqueued } = await reindexAllCompany(db, companyId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "memory.reindex_all",
      entityType: "company",
      entityId: companyId,
      details: { reindexed: enqueued },
    });

    res.json({ reindexed: enqueued });
  });

  return router;
}
