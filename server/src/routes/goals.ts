import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { createGoalSchema, updateGoalSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { goalService, memoryLifecycleService, logActivity } from "../services/index.js";
import { HttpError } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertHumanRole } from "../middleware/rbac.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ route: "goals" });

export function goalRoutes(db: Db) {
  const router = Router();
  const svc = goalService(db);
  const lifecycle = memoryLifecycleService(db);

  router.get("/companies/:companyId/goals", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const projectId = req.query.projectId as string | undefined;
    const result = await svc.list(companyId, projectId);
    res.json(result);
  });

  // Goals enriched with parentIds + rolled-up progress (Objectives tree).
  router.get("/companies/:companyId/goals/tree", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const result = await svc.listForTree(companyId);
    res.json(result);
  });

  router.get("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const goal = await svc.getById(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    await assertCompanyAccess(db, req, goal.companyId);
    res.json(goal);
  });

  router.post("/companies/:companyId/goals", validate(createGoalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertHumanRole(db, req, companyId, "founder", "team_lead");

    // Company-wide goals have no projects; scoped goals carry projectIds. The
    // goal service validates parent scope/cycles and throws HttpError on violation.
    let goal;
    try {
      goal = await svc.create(companyId, req.body);
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
      action: "goal.created",
      entityType: "goal",
      entityId: goal.id,
      details: { title: goal.title },
    });
    res.status(201).json(goal);
  });

  router.patch("/goals/:id", validate(updateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    await assertHumanRole(db, req, existing.companyId, "founder", "team_lead");
    let goal;
    try {
      goal = await svc.update(id, req.body);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.updated",
      entityType: "goal",
      entityId: goal.id,
      details: req.body,
    });

    // Auto-archive active_context memory when goal reaches terminal state.
    // Wrapped in try/catch so a memory-hook failure (e.g. pgvector absent,
    // transient DB error) doesn't 500 the goal update — the status transition
    // already committed and should be returned successfully. See Finding S.
    if (req.body.status === "achieved" || req.body.status === "cancelled") {
      try {
        await lifecycle.onGoalCompleted(goal.companyId, goal.id);
      } catch (err) {
        log.warn(
          {
            goalId: goal.id,
            companyId: goal.companyId,
            err: err instanceof Error ? err.message : String(err),
          },
          "memory archive hook failed after goal completion; continuing",
        );
      }
    }

    res.json(goal);
  });

  // Re-parent: replace a goal's parent edges (multi-parent DAG).
  router.put("/goals/:id/parents", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    await assertHumanRole(db, req, existing.companyId, "founder", "team_lead");
    const parentIds = Array.isArray(req.body?.parentIds)
      ? (req.body.parentIds as string[])
      : [];
    try {
      await svc.setGoalParents(id, parentIds);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.parents_updated",
      entityType: "goal",
      entityId: id,
      details: { parentIds },
    });
    const updated = await svc.getById(id);
    res.json(updated);
  });

  router.delete("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    await assertCompanyAccess(db, req, existing.companyId);
    await assertHumanRole(db, req, existing.companyId, "founder", "team_lead");
    const goal = await svc.remove(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.deleted",
      entityType: "goal",
      entityId: goal.id,
    });

    res.json(goal);
  });

  return router;
}
