import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { dashboardService } from "../services/dashboard.js";
import { homeService } from "../services/home.js";
import { suggestionService } from "../services/suggestions.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const dashSvc = dashboardService(db);
  const homeSvc = homeService(db);
  const suggestionSvc = suggestionService(db);

  router.get("/companies/:companyId/dashboard", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const summary = await dashSvc.summary(companyId);
    res.json(summary);
  });

  router.get("/companies/:companyId/home", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    try {
      await suggestionSvc.runAllDetectors(companyId);
    } catch (err) {
      logger.warn({ err, companyId }, "suggestion detection on home load failed");
    }
    const userId = req.actor.type === "board" ? req.actor.userId ?? undefined : undefined;
    const summary = await homeSvc.summary(companyId, userId);
    res.json(summary);
  });

  return router;
}
