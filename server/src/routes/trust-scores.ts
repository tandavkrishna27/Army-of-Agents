import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { trustScoreService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function trustScoreRoutes(db: Db) {
  const router = Router();
  const svc = trustScoreService(db);

  // GET /companies/:companyId/trust-scores — list all agent scores for company
  router.get("/companies/:companyId/trust-scores", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const scores = await svc.listScores(companyId);
    res.json(scores);
  });

  // GET /companies/:companyId/agents/:agentId/trust-score — get single agent's score
  router.get("/companies/:companyId/agents/:agentId/trust-score", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await assertCompanyAccess(db, req, companyId);
    const score = await svc.getScore(companyId, agentId);
    if (!score) {
      res.json(null);
      return;
    }
    res.json(score);
  });

  return router;
}
