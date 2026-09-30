import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@armyofagents/db";
import { companies } from "@armyofagents/db";
import { eq } from "drizzle-orm";
import {
  COMPOSER_ATTACHMENT_CONTENT_TYPES,
  COMPOSER_MAX_ATTACHMENT_BYTES,
  createAssetImageMetadataSchema,
  createAssetFileMetadataSchema,
} from "@armyofagents/shared";
import type { StorageService } from "../storage/types.js";
import { assetService, logActivity } from "../services/index.js";
import { getSafeServingHeaders } from "../services/asset-serving-safety.js";
import { sniffAndVerifyContentType } from "../services/asset-content-guard.js";
import { DOCX_MIME, streamToBuffer, renderDocxBufferToSafeHtml } from "../services/docx-render.js";
import { XLSX_MIME, renderXlsxBufferToSafeHtml } from "../services/xlsx-render.js";
import {
  assertOfficeRenderSize,
  OfficeRenderTooLargeError,
} from "../services/office-render-limits.js";
import { officeRenderLimiter } from "../middleware/rate-limit.js";
import { HttpError } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { resolveStorageTenant } from "./authz-tenant.js";

const MAX_ASSET_IMAGE_BYTES = Number(process.env.AOA_ATTACHMENT_MAX_BYTES) || 10 * 1024 * 1024;
// General asset upload contract (artifacts, API consumers, uploadFileArtifact):
// all content types, documented AOA_FILE_MAX_BYTES default 50 MB. Composer
// restrictions must NOT narrow this shared route (PR #291 review) — they apply
// only to composer-namespaced uploads below.
const MAX_ASSET_FILE_BYTES = Number(process.env.AOA_FILE_MAX_BYTES) || 50 * 1024 * 1024;
const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
// Unified-composer contract, enforced server-side only for uploads bound for a
// composer surface. The thread composer uploads under "discussion-entries"
// (ThreadTab.handleUpload) and Commander under "commander/<conversationId>"
// (InternalAgentPanel) — both validate client-side too; this is the
// defense-in-depth for well-formed composer clients without breaking the
// general asset route for everything else.
const COMPOSER_ALLOWED_FILE_CONTENT_TYPES = new Set<string>(COMPOSER_ATTACHMENT_CONTENT_TYPES);
function isComposerUploadNamespace(namespace: string): boolean {
  return namespace === "discussion-entries" || namespace.startsWith("commander/");
}

export function assetRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = assetService(db);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ASSET_IMAGE_BYTES, files: 1 },
  });

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  router.post("/companies/:companyId/assets/images", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Image exceeds ${MAX_ASSET_IMAGE_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }

    const contentType = (file.mimetype || "").toLowerCase();
    if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
      res.status(422).json({ error: `Unsupported image type: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Image is empty" });
      return;
    }

    const parsedMeta = createAssetImageMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid image metadata", details: parsedMeta.error.issues });
      return;
    }

    const namespaceSuffix = parsedMeta.data.namespace ?? "general";
    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      organizationId: await resolveStorageTenant(db, companyId),
      namespace: `assets/${namespaceSuffix}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const asset = await svc.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "asset.created",
      entityType: "asset",
      entityId: asset.id,
      details: {
        originalFilename: asset.originalFilename,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
      },
    });

    res.status(201).json({
      assetId: asset.id,
      companyId: asset.companyId,
      provider: asset.provider,
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      originalFilename: asset.originalFilename,
      createdByAgentId: asset.createdByAgentId,
      createdByUserId: asset.createdByUserId,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      contentPath: `/api/assets/${asset.id}/content`,
    });
  });

  // ── General file upload (all types, 50MB) ─────────────────────────────
  const fileUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ASSET_FILE_BYTES, files: 1 },
  });

  async function runSingleFileUploadLarge(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      fileUpload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  router.post("/companies/:companyId/assets/files", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    try {
      await runSingleFileUploadLarge(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `File exceeds ${MAX_ASSET_FILE_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "File is empty" });
      return;
    }

    const parsedMeta = createAssetFileMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid file metadata", details: parsedMeta.error.issues });
      return;
    }

    const namespaceSuffix = parsedMeta.data.namespace ?? "files";
    const contentType = (file.mimetype || "application/octet-stream").toLowerCase();
    // Trusted provenance (PR #291 round-6 #2 security): only an upload that came
    // through a composer namespace AND passed the allowlist + size + byte-sniff
    // guard below earns composer_validated. Attachment-binding and runtime
    // delivery require it, so uploading via namespace=files can no longer be
    // laundered into a composer attachment.
    const isComposer = isComposerUploadNamespace(namespaceSuffix);
    if (isComposer) {
      if (!COMPOSER_ALLOWED_FILE_CONTENT_TYPES.has(contentType)) {
        res.status(415).json({ error: `Unsupported attachment type: ${contentType}` });
        return;
      }
      if (file.buffer.length > COMPOSER_MAX_ATTACHMENT_BYTES) {
        res.status(422).json({ error: `Attachment exceeds ${COMPOSER_MAX_ATTACHMENT_BYTES} bytes` });
        return;
      }
      // P2 (PR #291 review): never trust the client's declared MIME type for a
      // composer attachment. Sniff the real bytes (magic numbers / UTF-8
      // decodability) so a caller cannot label arbitrary bytes as an allowed
      // image or text file and bypass the allowlist for runtime delivery.
      try {
        sniffAndVerifyContentType(file.buffer, contentType);
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    }
    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      organizationId: await resolveStorageTenant(db, companyId),
      namespace: `assets/${namespaceSuffix}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const asset = await svc.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      uploadNamespace: namespaceSuffix,
      // Only a validated composer upload is bindable as a composer attachment.
      composerValidated: isComposer,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "asset.created",
      entityType: "asset",
      entityId: asset.id,
      details: {
        originalFilename: asset.originalFilename,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
      },
    });

    res.status(201).json({
      assetId: asset.id,
      companyId: asset.companyId,
      provider: asset.provider,
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      originalFilename: asset.originalFilename,
      createdByAgentId: asset.createdByAgentId,
      createdByUserId: asset.createdByUserId,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      contentPath: `/api/assets/${asset.id}/content`,
    });
  });

  // ── Logo upload ─────────────────────────────────────────────────────
  router.post("/companies/:companyId/logo", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Logo exceeds ${MAX_ASSET_IMAGE_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }

    const contentType = (file.mimetype || "").toLowerCase();
    if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
      res.status(422).json({ error: `Unsupported image type: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Image is empty" });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      organizationId: await resolveStorageTenant(db, companyId),
      namespace: "assets/logos",
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const asset = await svc.create(companyId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await db.update(companies).set({ logoAssetId: asset.id }).where(eq(companies.id, companyId));

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.logo_updated",
      entityType: "company",
      entityId: companyId,
      details: { assetId: asset.id, originalFilename: asset.originalFilename },
    });

    res.status(200).json({
      logoAssetId: asset.id,
      logoUrl: `/api/assets/${asset.id}/content`,
    });
  });

  router.delete("/companies/:companyId/logo", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    await db.update(companies).set({ logoAssetId: null }).where(eq(companies.id, companyId));

    res.status(200).json({ ok: true });
  });

  // Lightweight asset metadata (Commander viewer asset/output tab bodies).
  // Mirrors the content route's path shape + access assertion but returns ONLY
  // presentation-safe fields — never objectKey/sha256/storage internals.
  router.get("/assets/:assetId/meta", async (req, res) => {
    const assetId = req.params.assetId as string;
    const asset = await svc.getById(assetId);
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    await assertCompanyAccess(db, req, asset.companyId);

    res.json({
      id: asset.id,
      originalFilename: asset.originalFilename,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      createdAt: asset.createdAt,
    });
  });

  router.get("/assets/:assetId/content", async (req, res, next) => {
    const assetId = req.params.assetId as string;
    const asset = await svc.getById(assetId);
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    await assertCompanyAccess(db, req, asset.companyId);

    const object = await storage.getObject(
      await resolveStorageTenant(db, asset.companyId),
      asset.companyId,
      asset.objectKey,
    );
    const safe = getSafeServingHeaders(
      asset.contentType || object.contentType,
      asset.originalFilename,
    );
    res.setHeader("Content-Type", safe.contentType);
    res.setHeader("Content-Length", String(asset.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("Content-Disposition", safe.contentDisposition);
    res.setHeader("X-Content-Type-Options", safe.xContentTypeOptions);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  // Generic server-rendered HTML preview for office documents (DOCX + XLSX).
  // The convert+sanitize+wrap lives in the shared render helpers
  // (server/src/services/docx-render.ts / xlsx-render.ts), which both sanitize
  // through the SAME allow-list-by-default config (office-html-sanitize.ts) so
  // DOCX and XLSX cannot drift in security posture; DOCX additionally shares its
  // helper with the memory-scoped render route. This route differs only in asset
  // lookup + authorization: it takes the /content route's auth (the asset's own
  // companyId gates access via assertCompanyAccess), so it is exactly as
  // authorized as /content and no wider. Non-office types still 415. Sanitization
  // is server-side; the client injects already-sanitized HTML.
  router.get("/assets/:assetId/render", officeRenderLimiter, async (req, res, next) => {
    try {
      const assetId = req.params.assetId as string;
      const asset = await svc.getById(assetId);
      if (!asset) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }
      await assertCompanyAccess(db, req, asset.companyId);

      const contentType = (asset.contentType || "").toLowerCase();
      if (contentType !== DOCX_MIME && contentType !== XLSX_MIME) {
        res.status(415).json({
          error: `Render not supported for ${asset.contentType}. Try /content for the raw bytes.`,
        });
        return;
      }

      // Cheap pre-check on the recorded size: reject an oversized file BEFORE
      // fetching + buffering its bytes. The render helper re-checks the actual
      // buffer length as the authoritative guard (in case byteSize is stale/0).
      assertOfficeRenderSize(asset.byteSize ?? 0);

      const object = await storage.getObject(
      await resolveStorageTenant(db, asset.companyId),
      asset.companyId,
      asset.objectKey,
    );
      const buffer = await streamToBuffer(object.stream);
      const html =
        contentType === XLSX_MIME
          ? await renderXlsxBufferToSafeHtml(buffer)
          : await renderDocxBufferToSafeHtml(buffer);

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      // The render is a pure function of the immutable asset bytes (a new upload
      // gets a new assetId), so the browser may cache it briefly — this is what
      // makes a re-viewed document render once instead of re-parsing every open.
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(html);
    } catch (err) {
      if (err instanceof OfficeRenderTooLargeError) {
        res.status(413).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}

