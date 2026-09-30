import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { issues, taskOutputs } from "@armyofagents/db";
import { mutableTaskOutputSchema, upsertTaskOutputSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, taskOutputBackfillService, taskOutputService } from "../services/index.js";
import { notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { registerIssueParamNormalizer } from "./issue-param-normalizer.js";

async function getIssueCompanyId(db: Db, issueId: string) {
  return db
    .select({ companyId: issues.companyId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
}

async function getTaskOutputCompanyId(db: Db, id: string) {
  return db
    .select({ companyId: taskOutputs.companyId })
    .from(taskOutputs)
    .where(eq(taskOutputs.id, id))
    .then((rows) => rows[0] ?? null);
}

export function taskOutputRoutes(db: Db) {
  const router = Router();
  const svc = taskOutputService(db);
  const backfillSvc = taskOutputBackfillService(db);
  registerIssueParamNormalizer(router, db, ["issueId"]);

  router.get(["/issues/:issueId/outputs", "/issues/:issueId/task-outputs"], async (req, res) => {
    const issueId = req.params.issueId as string;
    const issue = await getIssueCompanyId(db, issueId);
    if (!issue) throw notFound("Task not found");
    await assertCompanyAccess(db, req, issue.companyId);

    await backfillSvc.backfillIssueIfEmpty(issue.companyId, issueId);
    const result = await svc.listForIssue(issue.companyId, issueId);
    res.json(result);
  });

  router.post(
    ["/issues/:issueId/outputs", "/issues/:issueId/task-outputs"],
    validate(upsertTaskOutputSchema),
    async (req, res) => {
      const issueId = req.params.issueId as string;
      const issue = await getIssueCompanyId(db, issueId);
      if (!issue) throw notFound("Task not found");
      await assertCompanyAccess(db, req, issue.companyId);

      const output = await svc.upsertForIssue(issue.companyId, issueId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "task_output.upserted",
        entityType: "task_output",
        entityId: output.id,
        details: {
          issueId,
          type: output.type,
          provider: output.provider,
          externalId: output.externalId,
        },
      });

      res.status(201).json(output);
    },
  );

  router.get("/task-outputs/:id", async (req, res) => {
    const id = req.params.id as string;
    const row = await getTaskOutputCompanyId(db, id);
    if (!row) throw notFound("Task output not found");
    await assertCompanyAccess(db, req, row.companyId);

    const output = await svc.getById(row.companyId, id);
    if (!output) throw notFound("Task output not found");
    res.json(output);
  });

  router.patch(
    "/task-outputs/:id",
    validate(mutableTaskOutputSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const row = await getTaskOutputCompanyId(db, id);
      if (!row) throw notFound("Task output not found");
      await assertCompanyAccess(db, req, row.companyId);

      const output = await svc.updateMutable(row.companyId, id, req.body);
      if (!output) throw notFound("Task output not found");

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: row.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "task_output.updated",
        entityType: "task_output",
        entityId: output.id,
        details: req.body,
      });

      res.json(output);
    },
  );

  return router;
}
