import path from "node:path";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@armyofagents/db";
import type { StorageService } from "../storage/types.js";
import { fileImportService, SUPPORTED_MIME_TYPES } from "../services/file-import.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertHumanRole } from "../middleware/rbac.js";

const SUPPORTED_MIME_TYPES_SET = new Set<string>(SUPPORTED_MIME_TYPES);

const MAX_FILE_SIZE_BYTES =
  Number(process.env.AOA_FILE_MAX_BYTES) || 50 * 1024 * 1024;

export function fileImportRoutes(db: Db, storageService: StorageService) {
  const router = Router();
  const svc = fileImportService(db);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  });

  async function runSingleFileUpload(req: Request, res: Response): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // POST /companies/:companyId/memory/import-file
  router.post(
    "/companies/:companyId/memory/import-file",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        await assertCompanyAccess(db, req, companyId);
        await assertHumanRole(db, req, companyId, "founder");

        try {
          await runSingleFileUpload(req, res);
        } catch (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
              res.status(422).json({ error: `File exceeds ${MAX_FILE_SIZE_BYTES} bytes` });
              return;
            }
            res.status(400).json({ error: err.message });
            return;
          }
          throw err;
        }

        const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string; size: number } }).file;

        if (!file) {
          res.status(400).json({ error: "No file uploaded" });
          return;
        }

        if (!SUPPORTED_MIME_TYPES_SET.has(file.mimetype)) {
          res.status(400).json({
            error: `Unsupported file type: ${file.mimetype}. Supported: PDF, DOCX, TXT`,
          });
          return;
        }

        const { departmentId, projectId, defaultLayer, defaultCategory } =
          req.body as Record<string, string | undefined>;

        // Sanitize filename to prevent path traversal in the storage key
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_");

        // Upload file to StorageService; use the canonical objectKey it returns
        const namespace = `imports/${Date.now()}-${safeName}`;
        const stored = await storageService.putFile({
          companyId,
          namespace,
          originalFilename: file.originalname,
          contentType: file.mimetype,
          body: file.buffer,
        });

        const actor = getActorInfo(req);
        const job = await svc.createJob({
          companyId,
          fileName: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
          storageKey: stored.objectKey,  // use canonical key from storage provider
          createdBy: actor.actorId,
          departmentId: departmentId ?? null,
          projectId: projectId ?? null,
          defaultLayer: defaultLayer ?? "domain",
          defaultCategory: defaultCategory ?? "reference",
        });

        res.status(202).json({ jobId: job.id, fileName: job.fileName });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /companies/:companyId/memory/import-jobs/:jobId
  router.get(
    "/companies/:companyId/memory/import-jobs/:jobId",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        const jobId = req.params.jobId as string;
        await assertCompanyAccess(db, req, companyId);

        const job = await svc.getJob(companyId, jobId);
        if (!job) {
          res.status(404).json({ error: "Job not found" });
          return;
        }

        res.json({
          id: job.id,
          status: job.status,
          fileName: job.fileName,
          itemCount: job.itemCount,
          errorMessage: job.errorMessage,
          parserWarnings: job.parserWarnings,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
