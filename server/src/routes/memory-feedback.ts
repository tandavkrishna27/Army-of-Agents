import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { memoryFeedbackService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertHumanRole } from "../middleware/rbac.js";

export function memoryFeedbackRoutes(db: Db) {
  const router = Router();
  const svc = memoryFeedbackService(db);

  // POST /companies/:companyId/memory-feedback/detect — trigger detection run
  router.post(
    "/companies/:companyId/memory-feedback/detect",
    async (req, res) => {
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
        action: "memory_feedback.detection_run",
        entityType: "memory_feedback_pattern",
        entityId: companyId,
        details: result,
      });

      res.json(result);
    },
  );

  // GET /companies/:companyId/memory-feedback/patterns — list detected patterns
  router.get(
    "/companies/:companyId/memory-feedback/patterns",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const { status, patternType } = req.query as Record<
        string,
        string | undefined
      >;
      const patterns = await svc.list(companyId, { status, patternType });
      res.json(patterns);
    },
  );

  return router;
}
