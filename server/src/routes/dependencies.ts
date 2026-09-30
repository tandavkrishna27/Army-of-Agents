import { Router } from "express";
import { z } from "zod";
import type { Db } from "@armyofagents/db";
import { validate } from "../middleware/validate.js";
import { dependencyService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { registerIssueParamNormalizer } from "./issue-param-normalizer.js";

const addDependencySchema = z.object({
  dependencyIssueId: z.string().uuid(),
});

export function dependencyRoutes(db: Db) {
  const router = Router();
  const deps = dependencyService(db);
  // Company-scoped route (`/companies/:companyId/issues/:issueId/…`): resolve
  // the identifier within :companyId so `ACM-1` never crosses to another org's
  // same-prefix task.
  registerIssueParamNormalizer(router, db, ["issueId"], "companyId");

  // GET /companies/:companyId/issues/:issueId/dependencies
  router.get("/companies/:companyId/issues/:issueId/dependencies", async (req, res) => {
    const { companyId, issueId } = req.params;
    await assertCompanyAccess(db, req, companyId);

    const [upstream, downstream] = await Promise.all([
      deps.getDependencies(companyId, issueId),
      deps.getDependents(companyId, issueId),
    ]);

    res.json({ upstream, downstream });
  });

  // POST /companies/:companyId/issues/:issueId/dependencies
  router.post("/companies/:companyId/issues/:issueId/dependencies", validate(addDependencySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    await assertCompanyAccess(db, req, companyId);

    const { dependencyIssueId } = req.body;

    const row = await deps.addDependency(companyId, issueId, dependencyIssueId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "dependency.added",
      entityType: "issue",
      entityId: issueId,
      details: { dependencyIssueId },
    });

    res.status(201).json(row);
  });

  // DELETE /companies/:companyId/issues/:issueId/dependencies/:dependencyIssueId
  router.delete("/companies/:companyId/issues/:issueId/dependencies/:dependencyIssueId", async (req, res) => {
    const { companyId, issueId, dependencyIssueId } = req.params;
    await assertCompanyAccess(db, req, companyId);

    const deleted = await deps.removeDependency(companyId, issueId, dependencyIssueId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "dependency.removed",
      entityType: "issue",
      entityId: issueId,
      details: { dependencyIssueId },
    });

    res.json(deleted);
  });

  return router;
}
