import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import { universePreferencePatchSchema, universePreferenceResetSchema } from "@armyofagents/shared";
import { unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { UniversePreferencesConflictError, universePreferencesService } from "../services/universe-preferences.js";
import { assertCompanyAccess } from "./authz.js";

function userId(req: Request) {
  if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Board authentication required");
  return req.actor.userId;
}

export function universePreferenceRoutes(db: Db) {
  const router = Router();
  const preferences = universePreferencesService(db);
  const owner = async (req: Request) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    return { companyId, userId: userId(req) };
  };
  router.get("/companies/:companyId/universe/preferences/me", async (req, res) => {
    const scope = await owner(req);
    res.setHeader("Cache-Control", "no-store");
    res.json(await preferences.get(scope.companyId, scope.userId));
  });
  const conflictAware = (action: (companyId: string, uid: string, body: unknown) => Promise<unknown>) =>
    async (req: Request, res: import("express").Response) => {
      const scope = await owner(req);
      try { res.json(await action(scope.companyId, scope.userId, req.body)); }
      catch (cause) {
        if (cause instanceof UniversePreferencesConflictError)
          return res.status(409).json({ error: cause.message, latest: cause.latest });
        throw cause;
      }
    };
  router.patch("/companies/:companyId/universe/preferences/me", validate(universePreferencePatchSchema), conflictAware((c, u, b) => preferences.patch(c, u, b as never)));
  router.post("/companies/:companyId/universe/preferences/me/reset", validate(universePreferenceResetSchema), conflictAware((c, u, b) => preferences.reset(c, u, b as never)));
  return router;
}
