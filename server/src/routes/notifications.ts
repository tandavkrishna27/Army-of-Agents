import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { notificationService } from "../services/index.js";
import { HttpError } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function notificationRoutes(db: Db) {
  const router = Router();
  const svc = notificationService(db);

  // List notifications for current user
  router.get("/companies/:companyId/notifications", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    const actor = getActorInfo(req);
    const unreadOnly = req.query.unreadOnly === "true";

    const result = await svc.list(companyId, actor.actorId, { unreadOnly });
    res.json(result);
  });

  // Get unread count for badge
  router.get(
    "/companies/:companyId/notifications/unread-count",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);

      const actor = getActorInfo(req);
      const count = await svc.getUnreadCount(companyId, actor.actorId);
      res.json({ count });
    },
  );

  // Mark notification as read
  router.patch(
    "/companies/:companyId/notifications/:id/read",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);

      const actor = getActorInfo(req);
      try {
        const notification = await svc.markRead(companyId, actor.actorId, id);
        res.json(notification);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  // Dismiss notification
  router.patch(
    "/companies/:companyId/notifications/:id/dismiss",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);

      const actor = getActorInfo(req);
      try {
        const notification = await svc.dismiss(companyId, actor.actorId, id);
        res.json(notification);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  return router;
}
