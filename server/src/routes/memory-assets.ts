import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { memoryAssetUpdateSchema } from "@armyofagents/shared";
import { memoryAssetsService, type MemoryAssetsService } from "../services/memory-assets.js";
import { getSafeServingHeaders } from "../services/asset-serving-safety.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess } from "./authz.js";
import { resolveStorageTenant } from "./authz-tenant.js";
import { assertHumanRole } from "../middleware/rbac.js";

// Minimal storage interface for the test seam — callers can inject a partial { getObject }
// object rather than a full StorageService.
type StorageSeam = Pick<StorageService, "getObject">;

interface RoutesOptions {
  db?: Db;
  svc?: MemoryAssetsService;
  // Test seam: callers can inject a partial { getObject } object. Production passes a full StorageService.
  storage?: StorageSeam;
  storageService?: StorageService;
}

export function memoryAssetsRoutes(opts: RoutesOptions) {
  const router = Router();
  const db = opts.db!;
  const svc = opts.svc ?? memoryAssetsService(opts.db!);
  const storage: StorageSeam | undefined = opts.storage ?? opts.storageService;

  // GET list
  router.get(
    "/companies/:companyId/memory/assets",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        await assertCompanyAccess(db, req, companyId);
        const departmentId =
          typeof req.query.departmentId === "string" ? req.query.departmentId : undefined;
        const folderPath =
          typeof req.query.folderPath === "string" ? req.query.folderPath : undefined;
        const mimeType =
          typeof req.query.mimeType === "string" ? req.query.mimeType : undefined;
        const list = await svc.list({ companyId, departmentId, folderPath, mimeType });
        res.json(list);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET single asset
  router.get(
    "/companies/:companyId/memory/assets/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        await assertCompanyAccess(db, req, companyId);
        const asset = await svc.get(id, companyId);
        if (!asset) {
          res.status(404).json({ error: "Asset not found" });
          return;
        }
        res.json(asset);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET asset content — streams from StorageService
  router.get(
    "/companies/:companyId/memory/assets/:id/content",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        await assertCompanyAccess(db, req, companyId);
        const asset = await svc.get(id, companyId);
        if (!asset) {
          res.status(404).json({ error: "Asset not found" });
          return;
        }
        if (!storage) {
          res.status(500).json({ error: "Storage not configured" });
          return;
        }
        const obj = await storage.getObject(
          await resolveStorageTenant(db, companyId),
          companyId,
          asset.storageKey,
        );
        const safe = getSafeServingHeaders(asset.mimeType, asset.fileName);
        res.setHeader("Content-Type", safe.contentType);
        if (obj.contentLength !== undefined) {
          res.setHeader("Content-Length", String(obj.contentLength));
        }
        res.setHeader("Content-Disposition", safe.contentDisposition);
        res.setHeader("X-Content-Type-Options", safe.xContentTypeOptions);
        obj.stream.pipe(res);
      } catch (err) {
        next(err);
      }
    },
  );

  // PATCH update
  router.patch(
    "/companies/:companyId/memory/assets/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        await assertCompanyAccess(db, req, companyId);
        if (opts.db) await assertHumanRole(opts.db, req, companyId, "team_lead");
        const parsed = memoryAssetUpdateSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.flatten() });
          return;
        }
        const updated = await svc.update(id, companyId, parsed.data);
        if (!updated) {
          res.status(404).json({ error: "Asset not found" });
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
    "/companies/:companyId/memory/assets/:id",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        await assertCompanyAccess(db, req, companyId);
        if (opts.db) await assertHumanRole(opts.db, req, companyId, "team_lead");
        await svc.remove(id, companyId);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
