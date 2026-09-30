import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { Db } from "@armyofagents/db";
import { teamImportService } from "../services/index.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertHumanRole, assertDepartmentAccess } from "../middleware/rbac.js";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { safeLogActivity } from "../utils/safe-log-activity.js";

const log = logger.child({ route: "team-imports" });

/**
 * HTTP routes for team import (Slice 8 / Task 8.3).
 *
 * Mounted under the same global API prefix as the rest of the company-scoped
 * routes; final paths are:
 *
 *   POST /companies/:companyId/teams/_imports/preview
 *   POST /companies/:companyId/teams/_imports/install
 *
 * The `_imports` segment is intentional: it can never collide with a real
 * team UUID, so there's no path-ambiguity with `/teams/:tid` routes
 * elsewhere in `routes/teams.ts`.
 *
 * Conventions followed (canonical pattern from `routes/teams.ts`):
 *  - Factory exports `teamImportsRoutes(db)` returning an Express Router.
 *  - No try/catch in handlers — `HttpError` propagates to the global
 *    error middleware.
 *  - Auth: `await assertCompanyAccess(db, req, companyId)` for tenant scope plus
 *    `assertRole(db, req, companyId, "team_lead")` for company-level write
 *    permission, plus `assertDepartmentAccess(db, req, companyId,
 *    parentProjectId)` so a team_lead can only import into their own
 *    department. Founder + local_trusted + instance_admin short-circuit
 *    inside both helpers (`rbac.ts`). Gated identically to
 *    `POST /companies/:companyId/teams`.
 *  - JSON body validation via the `validate(zodSchema)` middleware.
 *  - Activity logging on install via `safeLogActivity` (Convention C-7) —
 *    the install transaction has already committed by this point, so a
 *    transient activity-log INSERT failure must not surface as a 500
 *    that would prompt the founder to retry the import.
 */
export function teamImportsRoutes(db: Db) {
  const router = Router();
  const importSvc = teamImportService(db);

  // Multer for the preview endpoint. 5 MB cap is generous for a YAML
  // manifest (typical is well under 50 KB) but small enough to reject
  // accidental uploads of unrelated bundles. Memory storage avoids any
  // disk-write side effect — we only need the bytes for parsing.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
  });

  const importInstallSchema = z.object({
    yamlContent: z.string().min(1),
    collisions: z.record(z.enum(["rename", "replace", "skip"])),
    parentProjectId: z.string().uuid(),
    renames: z.record(z.string()).optional(),
  });

  // POST /companies/:companyId/teams/_imports/preview
  //
  // Accepts EITHER a `multipart/form-data` upload with field `file`
  // containing the manifest YAML, OR a JSON body `{ yamlContent: string }`
  // for direct paste from the UI. The forgiving multer middleware below
  // does not 4xx when there is no file — that case falls through to the
  // JSON-body branch.
  router.post(
    "/companies/:companyId/teams/_imports/preview",
    (req, res, next) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError) {
          return next(badRequest(`upload error: ${err.message}`));
        }
        if (err) return next(err);
        next();
      });
    },
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "team_lead");

      // Task 4 (P1-A): preview is read-only but still discloses
      // existing-agent name collisions across the company. Gate by the
      // intended target department so a team_lead in dept A can't probe
      // dept B's agent roster by uploading any manifest. The manifest
      // itself does not carry a target dept — the founder/lead picks
      // it. We accept it via `parentProjectId` (multipart form field or
      // JSON field). The install route already requires it.
      const body = (req.body ?? {}) as {
        yamlContent?: unknown;
        parentProjectId?: unknown;
      };
      const parentProjectId =
        typeof body.parentProjectId === "string" ? body.parentProjectId : null;
      if (!parentProjectId) {
        throw badRequest("missing 'parentProjectId' field");
      }
      await assertDepartmentAccess(db, req, companyId, parentProjectId);

      const fileBuf = req.file?.buffer;
      const bodyYaml = body.yamlContent;
      const yaml = fileBuf
        ? fileBuf.toString("utf8")
        : typeof bodyYaml === "string"
          ? bodyYaml
          : null;

      if (!yaml) {
        throw badRequest(
          "missing 'file' upload or 'yamlContent' body field",
        );
      }

      const result = await importSvc.preview(companyId, yaml);
      res.json(result);
    },
  );

  // POST /companies/:companyId/teams/_imports/install
  //
  // JSON-only. Body shape: { yamlContent, collisions, parentProjectId,
  // renames? }. The service runs `preview` internally first to surface
  // missing-skill / >1-lead / slug-collision errors with clean messages
  // before entering the transactional cascade.
  router.post(
    "/companies/:companyId/teams/_imports/install",
    validate(importInstallSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "team_lead");
      await assertDepartmentAccess(db, req, companyId, req.body.parentProjectId);

      const team = await importSvc.install(companyId, req.body.yamlContent, {
        collisions: req.body.collisions,
        parentProjectId: req.body.parentProjectId,
        renames: req.body.renames,
      });

      const actor = getActorInfo(req);
      await safeLogActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "team.imported",
        entityType: "team",
        entityId: team.id,
        details: {
          slug: team.slug,
          name: team.name,
          parentProjectId: team.parentProjectId,
        },
      });

      log.info(
        {
          companyId,
          teamId: team.id,
          slug: team.slug,
          // Task 11 / P3-D: log the count so operators can correlate UI
          // toasts with server logs without leaking the human-readable
          // body (which embeds agent names + ids).
          // L12 (comprehensive-review fixup): match the response body's
          // `?? []` defense (line 186). If the service ever returns an
          // unmodelled shape (test mock drift, future regression), this
          // log line shouldn't be the thing that throws TypeError -> 500
          // before the response is sent.
          warningCount: team.warnings?.length ?? 0,
        },
        "imported team",
      );

      // Explicit response shape (Task 11 / P3-D): include `warnings`
      // alongside the team metadata so the founder sees side effects
      // like the silent dept-grant on 'replace'. Always present (empty
      // array on no-side-effects path) so the UI can iterate without
      // null-checks.
      res.status(201).json({
        id: team.id,
        slug: team.slug,
        name: team.name,
        parentProjectId: team.parentProjectId,
        warnings: team.warnings ?? [],
      });
    },
  );

  return router;
}
