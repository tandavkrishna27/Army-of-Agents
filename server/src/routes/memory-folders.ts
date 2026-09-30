import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import {
  memoryFolderCreateSchema,
  memoryFolderUpdateSchema,
} from "@armyofagents/shared";
import { memoryFoldersService, type MemoryFoldersService } from "../services/memory-folders.js";
import { assertCompanyAccess } from "./authz.js";
import { assertHumanRole } from "../middleware/rbac.js";

interface RoutesOptions {
  // Test seam: callers can inject a pre-built service. Production uses `db`.
  db?: Db;
  svc?: MemoryFoldersService;
}

export function memoryFoldersRoutes(opts: RoutesOptions) {
  const router = Router();
  const db = opts.db!;
  const svc = opts.svc ?? memoryFoldersService(opts.db!);

  // GET list
  router.get(
    "/companies/:companyId/memory/folders",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        await assertCompanyAccess(db, req, companyId);
        const departmentId =
          typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;
        const list = await svc.list({ companyId, departmentId });
        res.json(list);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST create
  router.post(
    "/companies/:companyId/memory/folders",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        await assertCompanyAccess(db, req, companyId);
        if (opts.db) await assertHumanRole(opts.db, req, companyId, "team_lead");
        const parsed = memoryFolderCreateSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        const created = await svc.create({ companyId, ...parsed.data });
        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    },
  );

  // PATCH update
  router.patch(
    "/companies/:companyId/memory/folders/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        await assertCompanyAccess(db, req, companyId);
        if (opts.db) await assertHumanRole(opts.db, req, companyId, "team_lead");
        const parsed = memoryFolderUpdateSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        const updated = await svc.update(id, companyId, parsed.data);
        if (!updated) {
          res.status(404).json({ error: "Folder not found" });
          return;
        }
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE
  router.delete(
    "/companies/:companyId/memory/folders/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        await assertCompanyAccess(db, req, companyId);
        if (opts.db) await assertHumanRole(opts.db, req, companyId, "team_lead");
        await svc.remove(id, companyId);
        res.status(204).end();
      } catch (err) {
        if ((err as Error & { code?: string }).code === "FOLDER_IS_SEEDED") {
          return res.status(403).json({ error: "Cannot delete seeded folder" });
        }
        next(err);
      }
    },
  );

  return router;
}
