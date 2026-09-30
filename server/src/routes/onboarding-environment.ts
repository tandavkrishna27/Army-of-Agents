import { Router, type Request, type Response } from "express";
import path from "node:path";
import type { Db } from "@armyofagents/db";
import { setupOnboardingEnvironment } from "../services/onboarding-environment.js";
import { safeLogActivity } from "../utils/safe-log-activity.js";
import { assertCanManageInstanceSettings, assertCompanyAccess, getActorInfo } from "./authz.js";

export function isAbsoluteFilesystemPath(
  value: string,
  pathApi: Pick<typeof path, "isAbsolute"> = path,
): boolean {
  return pathApi.isAbsolute(value);
}

/**
 * Onboarding environment setup (Stage C / C5, revA R13). Board-scoped,
 * instance-admin, and company-access checked. BLOCKING: the service runs the local
 * write-probe first and, on failure, persists nothing and we return 422 so the
 * founder stays on the step and can pick another folder.
 */
export function onboardingEnvironmentRoutes(db: Db): Router {
  const router = Router();

  router.post("/companies/:companyId/onboarding/environment", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    assertCanManageInstanceSettings(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const body = (req.body ?? {}) as { rootFolder?: unknown };
    const rootFolder = typeof body.rootFolder === "string" ? body.rootFolder.trim() : "";
    if (!rootFolder) {
      res.status(400).json({ error: "rootFolder is required" });
      return;
    }
    if (!isAbsoluteFilesystemPath(rootFolder)) {
      res.status(400).json({ error: "rootFolder must be an absolute path" });
      return;
    }
    const result = await setupOnboardingEnvironment(db, { companyId, rootFolder });
    if (result.ok) {
      await safeLogActivity(db, {
        companyId,
        ...getActorInfo(req),
        action: result.created ? "environment.created" : "environment.updated",
        entityType: "environment",
        entityId: result.environmentId,
        // Do not copy the local filesystem path into the audit payload.
        details: {
          name: "Local machine",
          driver: "local",
          source: "onboarding",
        },
      });
    }
    // Blocking: 422 on probe failure so the UI stays on the step.
    res.status(result.ok ? 200 : 422).json(result);
  });

  return router;
}
