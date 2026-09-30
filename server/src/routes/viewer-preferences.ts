import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@armyofagents/db";
import { validate } from "../middleware/validate.js";
import {
  getViewerPreference,
  resolveViewerControl,
  upsertViewerPreference,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { unauthorized } from "../errors.js";

const updateViewerPreferenceSchema = z
  .object({
    viewerControlLevel: z.enum(["manual", "own_output", "full"]).nullable(),
  })
  .strict();

function requireBoardUserId(req: Request, _res: Response): string {
  // rbac: paired-via-helper — every caller below pairs assertCompanyAccess with this helper; the assertBoard here is the helper's own actor-type guard.
  assertBoard(req);
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw unauthorized("Board authentication required");
  }
  return req.actor.userId;
}

export function viewerPreferencesRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/viewer-preferences/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req, res);
    const row = await getViewerPreference(db, userId, companyId);
    const resolved = await resolveViewerControl(db, companyId, userId);
    res.json({
      viewerControlLevel: row?.viewerControlLevel ?? null,
      effectiveLevel: resolved.level,
      source: resolved.source,
    });
  });

  router.patch(
    "/companies/:companyId/viewer-preferences/me",
    validate(updateViewerPreferenceSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req, res);
      await upsertViewerPreference(db, userId, companyId, req.body.viewerControlLevel);
      const resolved = await resolveViewerControl(db, companyId, userId);
      res.json({
        viewerControlLevel: req.body.viewerControlLevel,
        effectiveLevel: resolved.level,
        source: resolved.source,
      });
    },
  );

  return router;
}
