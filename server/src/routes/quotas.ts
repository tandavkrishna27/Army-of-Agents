import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { quotaWindowsService } from "../services/quota-windows.js";
import { assertCompanyAccess } from "./authz.js";

export function quotaRoutes(db: Db) {
  const router = Router();
  const quotas = quotaWindowsService(db);

  router.get("/companies/:companyId/quotas", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const rows = await quotas.list(companyId);
    res.json(rows);
  });

  // Body { adapterType?: string }. Without adapterType, refresh all adapters
  // that expose getQuotaWindows(); with it, refresh that single adapter only.
  router.post("/companies/:companyId/quotas/refresh", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const adapterType =
      typeof req.body?.adapterType === "string" ? req.body.adapterType.trim() : "";
    const rows = adapterType
      ? await quotas.refresh(companyId, adapterType)
      : await quotas.refreshAll(companyId);
    res.json(rows);
  });

  return router;
}
