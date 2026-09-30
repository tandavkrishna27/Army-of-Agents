import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { contextPackagingService } from "../services/context-packaging.js";
import { assertCompanyAccess } from "./authz.js";

export function contextPackagingRoutes(db: Db) {
  const router = Router();
  const svc = contextPackagingService(db);

  router.get(
    "/companies/:companyId/issues/:issueId/context-package",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);

      const issueId = req.params.issueId as string;

      try {
        const result = await svc.assembleContext(companyId, issueId);
        res.json(result);
      } catch (err: unknown) {
        if (err instanceof Error && err.message === "Task not found") {
          res.status(404).json({ error: "Task not found" });
          return;
        }
        throw err;
      }
    },
  );

  return router;
}
