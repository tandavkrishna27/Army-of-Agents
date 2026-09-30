import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import { createWorkflowTemplateSchema, updateWorkflowTemplateSchema } from "@armyofagents/shared";
import { accessService, workflowTemplateService, logActivity } from "../services/index.js";
import { forbidden, HttpError } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertHumanRole } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";

export function workflowTemplateRoutes(db: Db) {
  const router = Router();
  const svc = workflowTemplateService(db);
  const access = accessService(db);

  async function assertCanOverrideCompletionPolicy(req: Request, companyId: string) {
    if (!("agentCompletionPolicyOverride" in req.body)) return;
    if (req.actor.type !== "board") {
      throw forbidden("Only human operators may override task completion policy");
    }
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
    if (!allowed) throw forbidden("Missing permission: tasks:assign");
  }

  // GET /companies/:companyId/workflow-templates
  router.get("/companies/:companyId/workflow-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  // GET /companies/:companyId/workflow-templates/:templateId
  router.get("/companies/:companyId/workflow-templates/:templateId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const templateId = req.params.templateId as string;
    await assertCompanyAccess(db, req, companyId);
    const template = await svc.getById(companyId, templateId);
    if (!template) {
      res.status(404).json({ error: "Workflow template not found" });
      return;
    }
    res.json(template);
  });

  // POST /companies/:companyId/workflow-templates
  router.post("/companies/:companyId/workflow-templates", validate(createWorkflowTemplateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertCanOverrideCompletionPolicy(req, companyId);
    await assertHumanRole(db, req, companyId, "founder", "team_lead");

    const { name, steps } = req.body;
    if (!name || !steps || !Array.isArray(steps) || steps.length === 0) {
      res.status(400).json({ error: "name and steps (non-empty array) are required" });
      return;
    }

    const actor = getActorInfo(req);
    const template = await svc.create(companyId, req.body, actor.actorId);

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow_template.created",
      entityType: "workflow_template",
      entityId: template.id,
      details: { name: template.name },
    });

    res.status(201).json(template);
  });

  // PATCH /companies/:companyId/workflow-templates/:templateId
  router.patch("/companies/:companyId/workflow-templates/:templateId", validate(updateWorkflowTemplateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const templateId = req.params.templateId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertCanOverrideCompletionPolicy(req, companyId);
    await assertHumanRole(db, req, companyId, "founder", "team_lead");

    let template;
    try {
      template = await svc.update(companyId, templateId, req.body);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    if (!template) {
      res.status(404).json({ error: "Workflow template not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow_template.updated",
      entityType: "workflow_template",
      entityId: template.id,
      details: req.body,
    });

    res.json(template);
  });

  // POST /companies/:companyId/workflow-templates/:templateId/instantiate
  router.post("/companies/:companyId/workflow-templates/:templateId/instantiate", async (req, res) => {
    const companyId = req.params.companyId as string;
    const templateId = req.params.templateId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertHumanRole(db, req, companyId, "founder", "team_lead");

    const { goalId, projectId } = req.body;
    if (!goalId || !projectId) {
      res.status(400).json({ error: "goalId and projectId are required" });
      return;
    }

    let result;
    try {
      result = await svc.instantiate(companyId, templateId, goalId, projectId);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow_template.instantiated",
      entityType: "workflow_template",
      entityId: templateId,
      details: {
        goalId,
        projectId,
        tasksCreated: result.tasksCreated.length,
        dependenciesCreated: result.dependenciesCreated,
      },
    });

    res.status(201).json(result);
  });

  // DELETE /companies/:companyId/workflow-templates/:templateId
  router.delete("/companies/:companyId/workflow-templates/:templateId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const templateId = req.params.templateId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertHumanRole(db, req, companyId, "founder", "team_lead");

    const template = await svc.delete(companyId, templateId);
    if (!template) {
      res.status(404).json({ error: "Workflow template not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "workflow_template.deleted",
      entityType: "workflow_template",
      entityId: template.id,
    });

    res.json(template);
  });

  return router;
}
