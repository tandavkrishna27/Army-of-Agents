import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { memoryLifecycleService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import { assertHumanRole } from "../middleware/rbac.js";

export function memoryLifecycleRoutes(db: Db) {
  const router = Router();
  const svc = memoryLifecycleService(db);

  router.post("/companies/:companyId/memory/lifecycle/archive-expired", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertHumanRole(db, req, companyId, "founder");
    const count = await svc.archiveExpiredItems(companyId);
    res.json({ archived: count });
  });

  router.post("/companies/:companyId/memory/lifecycle/archive-working", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertHumanRole(db, req, companyId, "founder");
    const count = await svc.archiveExpiredWorkingMemory(companyId);
    res.json({ archived: count });
  });

  router.post("/companies/:companyId/memory/lifecycle/flag-stale", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertHumanRole(db, req, companyId, "founder");
    const count = await svc.flagStaleItems(companyId);
    res.json({ flagged: count });
  });

  return router;
}
