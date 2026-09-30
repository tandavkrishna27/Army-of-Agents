import { Router } from "express";
import { z } from "zod";
import type { Db } from "@armyofagents/db";
import { validate } from "../middleware/validate.js";
import { activityService } from "../services/activity.js";
import { accessibleCompanyIdsForActor, assertBoard, assertCompanyAccess } from "./authz.js";
import { issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";
import {
  MARKETPLACE_RECONCILIATION_ACTION_PREFIX,
  MARKETPLACE_RECONCILIATION_ENTITY_TYPE,
} from "../services/activity-namespace.js";

const createActivitySchema = z
  .object({
    actorType: z.enum(["agent", "user", "system", "autonomy"]).optional().default("system"),
    actorId: z.string().min(1),
    action: z.string().min(1),
    entityType: z.string().min(1),
    entityId: z.string().min(1),
    agentId: z.string().uuid().optional().nullable(),
    details: z.record(z.unknown()).optional().nullable(),
  })
  .superRefine((event, ctx) => {
    if (
      event.entityType === MARKETPLACE_RECONCILIATION_ENTITY_TYPE ||
      event.action.startsWith(MARKETPLACE_RECONCILIATION_ACTION_PREFIX)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Marketplace reconciliation audit events are reserved for the reconciliation service",
      });
    }
  });

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const issueSvc = issueService(db);

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      actorType: req.query.actorType as "agent" | "user" | "system" | "autonomy" | undefined,
      actorId: req.query.actorId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
    };
    const result = await svc.list(filters);
    res.json(result);
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const event = await svc.create({
      companyId,
      ...req.body,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs
  router.param("id", async (req, res, next, rawId) => {
    try {
      if (/^[A-Z]+-\d+$/i.test(rawId)) {
        const issue = await issueSvc.getByIdentifier(rawId, accessibleCompanyIdsForActor(req.actor));
        if (issue) {
          req.params.id = issue.id;
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/issues/:id/activity", async (req, res) => {
    const id = req.params.id as string;
    const issue = await issueSvc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    const result = await svc.forIssue(id);
    res.json(result);
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const id = req.params.id as string;
    const issue = await issueSvc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await assertCompanyAccess(db, req, issue.companyId);
    const result = await svc.runsForIssue(issue.companyId, id);
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    const runId = req.params.runId as string;
    const companyId = await svc.companyIdForRun(runId);
    if (!companyId) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    await assertCompanyAccess(db, req, companyId);
    const result = await svc.issuesForRun(runId);
    res.json(result);
  });

  return router;
}
