import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import { updateHubAutopilotPolicySchema } from "@armyofagents/shared";
import { forbidden, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { hubAutopilotService, logActivity, permissionService } from "../services/index.js";
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

function boundedLimit(value: unknown): number {
  if (value == null) return 10;
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(Math.max(Math.trunc(parsed), 1), 50);
}

export function hubAutopilotRoutes(db: Db) {
  const router = Router();
  const autopilot = hubAutopilotService(db);
  const perms = permissionService(db);

  async function requireFounder(req: Request, companyId: string, userId: string) {
    if (hasImplicitFounderAuthority(req)) return;
    if (!(await perms.isFounder(companyId, userId))) {
      throw forbidden("Autopilot policy changes require founder authority.");
    }
  }

  router.get("/companies/:companyId/hub-autopilot/policy", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    requireBoardUserId(req);
    res.json(await autopilot.get(companyId));
  });

  router.get("/companies/:companyId/hub-autopilot/actions", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    requireBoardUserId(req);
    res.json(await autopilot.listRecentActions(companyId, { limit: boundedLimit(req.query.limit) }));
  });

  router.patch(
    "/companies/:companyId/hub-autopilot/policy",
    validate(updateHubAutopilotPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req);
      await requireFounder(req, companyId, userId);
      const result = await autopilot.upsert(companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "hub_autopilot_policy.updated",
        entityType: "hub_autopilot_policy",
        entityId: companyId,
        details: req.body,
      });
      res.json(result);
    },
  );

  router.post("/companies/:companyId/hub-autopilot/policy/reset", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    await requireFounder(req, companyId, userId);
    const result = await autopilot.reset(companyId);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "hub_autopilot_policy.reset",
      entityType: "hub_autopilot_policy",
      entityId: companyId,
    });
    res.json(result);
  });

  return router;
}
