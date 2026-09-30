import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { createUserNoteSchema, updateUserNoteSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { userNotesService } from "../services/index.js";
import { unauthorized } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function requireBoardUserId(req: Request, _res: Response): string {
  // rbac: paired-via-helper
  assertBoard(req);
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw unauthorized("Board authentication required");
  }
  return req.actor.userId;
}

export function userNoteRoutes(db: Db) {
  const router = Router();
  const svc = userNotesService(db);

  router.get("/companies/:companyId/user-notes", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req, res);
    res.json(await svc.list(companyId, userId));
  });

  router.post(
    "/companies/:companyId/user-notes",
    validate(createUserNoteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req, res);
      const note = await svc.create(companyId, userId, req.body);
      res.status(201).json(note);
    },
  );

  router.patch(
    "/companies/:companyId/user-notes/:noteId",
    validate(updateUserNoteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req, res);
      const noteId = req.params.noteId as string;
      const note = await svc.update(companyId, userId, noteId, req.body);
      res.json(note);
    },
  );

  router.delete("/companies/:companyId/user-notes/:noteId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req, res);
    const noteId = req.params.noteId as string;
    await svc.archive(companyId, userId, noteId);
    res.status(204).end();
  });

  return router;
}
