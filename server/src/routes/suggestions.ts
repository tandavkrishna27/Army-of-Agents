import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { logActivity, suggestionService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertHumanRole } from "../middleware/rbac.js";

export function suggestionRoutes(db: Db) {
  const router = Router();
  const svc = suggestionService(db);

  router.get("/companies/:companyId/suggestions", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const result = await svc.list(companyId, { category, status });
    res.json(result);
  });

  router.get("/companies/:companyId/suggestions/pending", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const result = await svc.listPending(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/suggestions/detect", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertHumanRole(db, req, companyId, "founder");

    const result = await svc.runAllDetectors(companyId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "suggestion.detection_run",
      entityType: "suggestion",
      entityId: companyId,
      details: result,
    });

    res.json(result);
  });

  router.post("/companies/:companyId/suggestions/:id/accept", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    await assertHumanRole(db, req, companyId, "founder");

    const result = await svc.accept(companyId, id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "suggestion.accepted",
      entityType: "suggestion",
      entityId: id,
      details: {
        actionType: result.execution.actionType,
        entityType: result.execution.entityType ?? null,
        entityId: result.execution.entityId ?? null,
        note: result.execution.note ?? null,
      },
    });

    res.json(result);
  });

  router.post("/companies/:companyId/suggestions/:id/dismiss", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    await assertHumanRole(db, req, companyId, "founder");

    const result = await svc.dismiss(companyId, id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "suggestion.dismissed",
      entityType: "suggestion",
      entityId: id,
    });

    res.json(result);
  });

  return router;
}
