import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { updateHomeBoardLayoutSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { homeBoardLayoutService } from "../services/home-board-layout.js";
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

/**
 * Owner-scoped `/me` routes for the Home widget-board layout — mirrors
 * sidebar-preferences.ts exactly: no role gate (team-visible feature), no
 * activity-log entry (a personal display preference, same as
 * sidebar-preferences). The server is the sole owner of schemaVersion
 * (stamped in the service) — the validator's .strict() already rejects a
 * client-supplied schemaVersion or userId before this ever runs.
 */
export function homeBoardLayoutRoutes(db: Db) {
  const router = Router();
  const svc = homeBoardLayoutService(db);

  router.get("/companies/:companyId/home-board-layout/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req, res);
    res.json(await svc.get(userId, companyId));
  });

  router.patch(
    "/companies/:companyId/home-board-layout/me",
    validate(updateHomeBoardLayoutSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req, res);
      res.json(await svc.upsert(userId, companyId, req.body.layout));
    },
  );

  router.post("/companies/:companyId/home-board-layout/me/reset", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req, res);
    await svc.reset(userId, companyId);
    res.json({ ok: true });
  });

  return router;
}
