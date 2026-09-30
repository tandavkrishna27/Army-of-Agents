import { Router } from "express";
import type { Db } from "@armyofagents/db";
import type { DeploymentExposure, DeploymentMode } from "@armyofagents/shared";
import { assertCanManageInstanceSettings, assertCompanyAccess } from "./authz.js";
import { buildCompanyHealthReport } from "../services/health/company-health.js";
import { buildInstanceHealthReport } from "../services/health/instance-health.js";

interface OperationsHealthRouteOptions {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  authReady: boolean;
  companyDeletionEnabled: boolean;
  bindHost?: string;
  allowedHostnames?: string[];
}

export function operationsHealthRoutes(db: Db, opts: OperationsHealthRouteOptions) {
  const router = Router();

  router.get("/companies/:companyId/health", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    res.json(await buildCompanyHealthReport(db, companyId, opts));
  });

  router.get("/instance/health", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.json(await buildInstanceHealthReport(db, opts));
  });

  return router;
}
