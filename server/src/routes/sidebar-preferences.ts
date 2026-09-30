import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { updateSidebarPreferencesSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { sidebarPreferencesService } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { unauthorized } from "../errors.js";

function requireBoardUserId(req: Request, _res: Response): string {
  // rbac: paired-via-helper — every caller below pairs assertCompanyAccess with this helper; the assertBoard here is the helper's own actor-type guard.
  assertBoard(req);
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw unauthorized("Board authentication required");
  }
  return req.actor.userId;
}

export function sidebarPreferencesRoutes(db: Db) {
  const router = Router();
  const svc = sidebarPreferencesService(db);

  router.get("/companies/:companyId/sidebar-preferences/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req, res);
    res.json(await svc.get(userId, companyId));
  });

  router.patch(
    "/companies/:companyId/sidebar-preferences/me",
    validate(updateSidebarPreferencesSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req, res);
      res.json(await svc.upsert(userId, companyId, req.body));
    },
  );

  router.post("/companies/:companyId/sidebar-preferences/me/reset", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req, res);
    res.json(await svc.reset(userId, companyId));
  });

  return router;
}
