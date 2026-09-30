import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { updateBriefSchema, updateBriefItemSchema, approveBriefSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { briefService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertHumanRole } from "../middleware/rbac.js";

export function briefRoutes(db: Db) {
  const router = Router();
  const svc = briefService(db);

  router.get("/companies/:companyId/briefs", async (req, res) => {
    res.set("X-Deprecated", "Use /discussions instead");
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const { status, departmentId } = req.query as Record<string, string | undefined>;
    const result = await svc.list(companyId, { status, departmentId });
    res.json(result);
  });

  router.get("/companies/:companyId/briefs/:id", async (req, res) => {
    res.set("X-Deprecated", "Use /discussions instead");
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const brief = await svc.getById(companyId, id);
    if (!brief) {
      res.status(404).json({ error: "Brief not found" });
      return;
    }
    res.json(brief);
  });

  router.patch(
    "/companies/:companyId/briefs/:id",
    validate(updateBriefSchema),
    async (req, res) => {
      res.set("X-Deprecated", "Use /discussions instead");
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);

      const brief = await svc.updateBrief(companyId, id, req.body);
      if (!brief) {
        res.status(404).json({ error: "Brief not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "brief.updated",
        entityType: "brief",
        entityId: id,
        details: req.body,
      });

      res.json(brief);
    },
  );

  router.patch(
    "/companies/:companyId/briefs/:briefId/items/:itemId",
    validate(updateBriefItemSchema),
    async (req, res) => {
      res.set("X-Deprecated", "Use /discussions instead");
      const companyId = req.params.companyId as string;
      const briefId = req.params.briefId as string;
      const itemId = req.params.itemId as string;
      await assertCompanyAccess(db, req, companyId);

      const originalItem = await svc.getItemById(briefId, itemId);
      const item = await svc.updateItemStatus(companyId, briefId, itemId, req.body);

      if (!item) {
        res.status(404).json({ error: "Brief or item not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "brief_item.updated",
        entityType: "brief_item",
        entityId: itemId,
        details: {
          briefId,
          ...req.body,
          originalTitle: originalItem?.title,
          originalDescription: originalItem?.description,
        },
      });

      res.json(item);
    },
  );

  // POST /companies/:companyId/briefs/:id/approve — approve brief (founder only)
  router.post("/companies/:companyId/briefs/:id/approve", validate(approveBriefSchema), async (req, res) => {
    res.set("X-Deprecated", "Use /discussions instead");
    const companyId = req.params.companyId as string;
    const briefId = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    await assertHumanRole(db, req, companyId, "founder");
    const actor = getActorInfo(req);

    const { dependencies } = req.body;
    const result = await svc.approveBrief(companyId, briefId, actor.actorId, dependencies);
    if (!result) {
      res.status(404).json({ error: "Brief not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "brief.approved",
      entityType: "brief",
      entityId: briefId,
      details: {
        status: result.brief.status,
        taskCount: result.createdTaskIds.length,
        memoryCount: result.createdMemoryIds.length,
      },
    });

    res.json(result);
  });

  // Redirect: GET /briefs/redirect → 302 to /discussions?hasPendingItems=true
  // Using 302 (temporary) during transition — allows rollback without cached permanent redirects
  router.get("/companies/:companyId/briefs/redirect", async (req, res) => {
    res.set("X-Deprecated", "Use /discussions instead");
    res.redirect(302, `/api/companies/${req.params.companyId}/discussions?hasPendingItems=true`);
  });

  return router;
}
