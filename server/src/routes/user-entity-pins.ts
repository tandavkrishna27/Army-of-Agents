import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { createUserEntityPinSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { userEntityPinService } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { unauthorized, notFound } from "../errors.js";

function requireBoardUserId(req: Request, _res: Response): string {
  // rbac: paired-via-helper — every caller below pairs assertCompanyAccess with this helper; the assertBoard here is the helper's own actor-type guard.
  assertBoard(req);
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw unauthorized("Board authentication required");
  }
  return req.actor.userId;
}

export function userEntityPinRoutes(db: Db) {
  const router = Router();
  const svc = userEntityPinService(db);

  router.get("/companies/:companyId/pins", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req, res);
    const pins = await svc.list(userId, companyId);
    res.json(pins);
  });

  router.post(
    "/companies/:companyId/pins",
    validate(createUserEntityPinSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req, res);
      const { entityType, entityId } = req.body as { entityType: string; entityId: string };
      const exists = await svc.entityExistsInCompany(companyId, entityType, entityId);
      if (!exists) {
        throw notFound(`${entityType} not found in this company`);
      }
      const pin = await svc.pin(userId, companyId, entityType, entityId);
      res.status(201).json(pin);
    },
  );

  router.delete(
    "/companies/:companyId/pins/:entityType/:entityId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req, res);
      const entityType = req.params.entityType as string;
      const entityId = req.params.entityId as string;
      await svc.unpin(userId, companyId, entityType, entityId);
      res.status(204).end();
    },
  );

  return router;
}
