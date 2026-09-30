import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import { updateNotificationPreferencesSchema } from "@armyofagents/shared";
import { unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  logActivity,
  notificationDigestService,
  notificationPreferencesService,
  permissionService,
} from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

function requireBoardUserId(req: Request): string {
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw unauthorized("Board authentication required");
  }
  return req.actor.userId;
}

function hasImplicitFounderAuthority(req: Request): boolean {
  return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
}

export function notificationPreferenceRoutes(db: Db) {
  const router = Router();
  const preferences = notificationPreferencesService(db);
  const digest = notificationDigestService(db);
  const perms = permissionService(db);

  async function resolveRole(req: Request, companyId: string, userId: string) {
    if (hasImplicitFounderAuthority(req)) return "founder" as const;
    return perms.getEffectiveRole(companyId, userId);
  }

  router.get("/companies/:companyId/notifications/preferences/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    res.json(await preferences.get(userId, companyId));
  });

  router.patch(
    "/companies/:companyId/notifications/preferences/me",
    validate(updateNotificationPreferencesSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req);
      const result = await preferences.upsert(userId, companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "notification_preferences.updated",
        entityType: "notification_preferences",
        entityId: userId,
      });
      res.json(result);
    },
  );

  router.post("/companies/:companyId/notifications/preferences/me/reset", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    const result = await preferences.reset(userId, companyId);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "notification_preferences.reset",
      entityType: "notification_preferences",
      entityId: userId,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/notifications/digest/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    const role = await resolveRole(req, companyId, userId);
    res.json(await digest.listForUser({ companyId, userId, role }));
  });

  router.post("/companies/:companyId/notifications/digest/me/ack", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    const result = await digest.ackForUser({ companyId, userId });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "notification_digest.acked",
      entityType: "notification_digest",
      entityId: userId,
      details: result,
    });
    res.json(result);
  });

  return router;
}
