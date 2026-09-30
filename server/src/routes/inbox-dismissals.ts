import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { createInboxDismissalSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { inboxDismissalService } from "../services/index.js";
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

export function inboxDismissalRoutes(db: Db) {
  const router = Router();
  const svc = inboxDismissalService(db);

  router.get("/companies/:companyId/inbox-dismissals", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req, res);
    const dismissals = await svc.list(userId, companyId);
    res.json(dismissals);
  });

  router.post(
    "/companies/:companyId/inbox-dismissals",
    validate(createInboxDismissalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req, res);
      const dismissal = await svc.dismiss(userId, companyId, req.body.itemKey);
      res.status(201).json(dismissal);
    },
  );

  router.delete(
    "/companies/:companyId/inbox-dismissals/:itemKey",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req, res);
      const itemKey = decodeURIComponent(req.params.itemKey as string);
      await svc.undismiss(userId, companyId, itemKey);
      res.status(204).end();
    },
  );

  return router;
}
