// server/src/routes/braindump.ts — WS6 braindump ingestion API.
import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { submitBraindumpSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { braindumpService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { notFound } from "../errors.js";

export function braindumpRoutes(db: Db) {
  const router = Router();
  const svc = braindumpService(db);

  // Submit (or idempotently resubmit) a braindump for a department. This
  // request returns promptly with a non-terminal status ("pending"/"running")
  // — the Librarian dispatch runs in the BACKGROUND (M1: fire-and-forget,
  // see braindumpService.submit/claimAndDispatch in braindump.ts), so the
  // response body never carries the dispatch outcome. Callers poll GET
  // .../braindumps/:id (or the Inbox hub signpost) to observe the eventual
  // terminal status ("proposed"/"failed") and, on failure, an actionable
  // failureReason.
  router.post(
    "/companies/:companyId/braindumps",
    validate(submitBraindumpSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = getActorInfo(req);

      const row = await svc.submit(companyId, req.body, actor.actorId ?? null);

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "braindump.submitted",
        entityType: "braindump_capture",
        entityId: row.id,
        details: { departmentId: row.departmentId, status: row.status },
      });

      res.status(201).json(row);
    },
  );

  router.get("/companies/:companyId/braindumps", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    // Phase 5e: `departmentId` is now OPTIONAL. Omitting it returns every
    // capture for the company across both scopes — which is what LibrarianStep
    // polls, since a per-department sweep would never see the company-wide
    // capture. The filtered form is unchanged for existing callers.
    const departmentId = req.query.departmentId as string | undefined;
    const rows = departmentId
      ? await svc.listByDepartment(companyId, departmentId)
      : await svc.listAll(companyId);
    res.json(rows);
  });

  router.get("/companies/:companyId/braindumps/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const row = await svc.getById(companyId, req.params.id as string);
    if (!row) {
      throw notFound("Braindump capture not found");
    }
    res.json(row);
  });

  // Retry a failed (or stuck-pending) capture. Idempotent — see braindump.ts.
  router.post("/companies/:companyId/braindumps/:id/retry", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const actor = getActorInfo(req);

    const row = await svc.retry(companyId, req.params.id as string);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "braindump.retried",
      entityType: "braindump_capture",
      entityId: row.id,
      details: { status: row.status },
    });

    res.json(row);
  });

  return router;
}
