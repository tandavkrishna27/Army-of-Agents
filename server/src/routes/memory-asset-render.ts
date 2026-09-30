import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { memoryAssetsService } from "../services/memory-assets.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess } from "./authz.js";
import { DOCX_MIME, streamToBuffer, renderDocxBufferToSafeHtml } from "../services/docx-render.js";
import { XLSX_MIME, renderXlsxBufferToSafeHtml } from "../services/xlsx-render.js";
import {
  assertOfficeRenderSize,
  OfficeRenderTooLargeError,
} from "../services/office-render-limits.js";
import { officeRenderLimiter } from "../middleware/rate-limit.js";

interface RoutesOptions {
  db?: Db;
  svc?: ReturnType<typeof memoryAssetsService>;
  storage?: { getObject: (companyId: string, key: string) => Promise<{ stream: NodeJS.ReadableStream; contentLength: number }> };
  storageService?: StorageService;
}

export function memoryAssetRenderRoutes(opts: RoutesOptions) {
  const router = Router();
  const db = opts.db!;
  const svc = opts.svc ?? memoryAssetsService(opts.db!);
  const storage = opts.storage ?? opts.storageService;

  router.get(
    "/companies/:companyId/memory/assets/:id/render",
    officeRenderLimiter,
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

        const mimeType = asset.mimeType;
        if (mimeType !== DOCX_MIME && mimeType !== XLSX_MIME) {
          res.status(415).json({
            error: `Render not supported for ${mimeType}. Try /content for the raw bytes.`,
          });
          return;
        }

        if (!storage) {
          res.status(500).json({ error: "Storage not configured" });
          return;
        }

        // Cheap pre-check on the recorded size before fetching bytes; the render
        // helper re-checks the actual buffer length as the authoritative guard.
        assertOfficeRenderSize(asset.fileSize ?? 0);

        const obj = await storage.getObject(companyId, asset.storageKey);
        const buffer = await streamToBuffer(obj.stream);
        // Shared convert+sanitize+wrap (docx-render.ts / xlsx-render.ts), both
        // sanitizing through the SAME allow-list-by-default config
        // (office-html-sanitize.ts) — single source with the generic
        // /assets/:id/render route so the surfaces never drift in security
        // posture. Dispatch DOCX vs XLSX by the asset's own mimeType.
        const html =
          mimeType === XLSX_MIME
            ? await renderXlsxBufferToSafeHtml(buffer)
            : await renderDocxBufferToSafeHtml(buffer);

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("X-Content-Type-Options", "nosniff");
        // Pure function of the immutable asset bytes — safe to browser-cache
        // briefly so a re-viewed document renders once (mirrors /assets/:id/render).
        res.setHeader("Cache-Control", "private, max-age=300");
        res.send(html);
      } catch (err) {
        if (err instanceof OfficeRenderTooLargeError) {
          res.status(413).json({ error: err.message });
          return;
        }
        next(err);
      }
    },
  );

  return router;
}
