import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { createDebriefSchema, mcpDebriefSchema, updateDebriefSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { debriefService, discussionService, extractionService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function debriefRoutes(db: Db) {
  const router = Router();
  const svc = debriefService(db);
  const extraction = extractionService(db);
  const discussions = discussionService(db);

  router.get("/companies/:companyId/debriefs", async (req, res) => {
    res.set("X-Deprecated", "Use /discussions instead");
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const { status, departmentId, inputType } = req.query as Record<string, string | undefined>;
    const result = await svc.list(companyId, { status, departmentId, inputType });
    res.json(result);
  });

  router.get("/companies/:companyId/debriefs/:id", async (req, res) => {
    res.set("X-Deprecated", "Use /discussions instead");
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const debrief = await svc.getById(companyId, id);
    if (!debrief) {
      res.status(404).json({ error: "Debrief not found" });
      return;
    }
    res.json(debrief);
  });

  router.post("/companies/:companyId/debriefs", validate(createDebriefSchema), async (req, res) => {
    res.set("X-Deprecated", "Use /discussions instead");
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const actor = getActorInfo(req);
    const debrief = await svc.create(companyId, {
      ...req.body,
      createdBy: actor.actorId,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "debrief.created",
      entityType: "debrief",
      entityId: debrief.id,
      details: { title: debrief.title, inputType: debrief.inputType },
    });

    // Fire-and-forget: trigger LLM extraction in background
    extraction.extractFromDebrief(companyId, debrief.id).catch(() => {
      // Error already logged and status updated inside extractFromDebrief
    });

    res.status(201).json(debrief);
  });

  // MCP inbound: external content now enters via the Discussion pipeline.
  // Keeps old endpoint path for backward compatibility; creates discussion + entry instead of debrief
  router.post("/companies/:companyId/debriefs/mcp", validate(mcpDebriefSchema), async (req, res) => {
    res.set("X-Deprecated", "Use /discussions instead");
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const actor = getActorInfo(req);

    const { content, title, departmentId, projectId, source } = req.body;

    // Map old debrief fields to discussion shape
    // departmentId → scopeType: 'department', scopeId
    // projectId → scopeType: 'project', scopeId (departmentId takes priority)
    const scopeType = departmentId ? "department" : projectId ? "project" : null;
    const scopeId = departmentId ?? projectId ?? null;

    const discussion = await discussions.create(
      companyId,
      {
        title: title ?? null,
        scopeType,
        scopeId,
        entry: {
          inputType: "mcp",
          rawContent: content,
          departmentId: departmentId ?? null,
          projectId: projectId ?? null,
          sourceInfo: source ?? null,
        },
      },
      actor.actorId,
    );

    // Note: discussionService.create() already logs activity as 'discussion.created'
    // and publishes LiveEvent for the entry, so no duplicate logging needed here.
    // Extraction is not triggered here — entry is created with extractionStatus: 'pending'
    // and will be picked up by the discussion extraction worker (future session).

    res.status(201).json({
      discussionId: discussion.id,
      entryId: discussion.entry?.id ?? null,
      status: "pending",
      message: "Discussion created. Entry queued for extraction.",
    });
  });

  router.patch("/companies/:companyId/debriefs/:id", validate(updateDebriefSchema), async (req, res) => {
    res.set("X-Deprecated", "Use /discussions instead");
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const existing = await svc.getById(companyId, id);
    if (!existing) {
      res.status(404).json({ error: "Debrief not found" });
      return;
    }
    const debrief = await svc.update(companyId, id, req.body);
    if (!debrief) {
      res.status(404).json({ error: "Debrief not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "debrief.updated",
      entityType: "debrief",
      entityId: debrief.id,
      details: req.body,
    });
    res.json(debrief);
  });

  // Redirect: POST /debriefs/redirect → 307 to /discussions (preserves POST method + body)
  router.post("/companies/:companyId/debriefs/redirect", async (req, res) => {
    res.set("X-Deprecated", "Use /discussions instead");
    res.redirect(307, `/api/companies/${req.params.companyId}/discussions`);
  });

  return router;
}
