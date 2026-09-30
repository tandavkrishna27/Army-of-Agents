import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { createCostEventSchema, updateBudgetSchema, upsertBudgetPolicySchema, resolveBudgetIncidentSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { costService, companyService, agentService, logActivity } from "../services/index.js";
import { budgetService } from "../services/budgets.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function costRoutes(db: Db) {
  const router = Router();
  const costs = costService(db);
  const companies = companyService(db);
  const agents = agentService(db);
  const budgets = budgetService(db);

  router.post("/companies/:companyId/cost-events", validate(createCostEventSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only report its own costs" });
      return;
    }

    const event = await costs.createEvent(companyId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "cost.reported",
      entityType: "cost_event",
      entityId: event.id,
      details: { costCents: event.costCents, model: event.model },
    });

    res.status(201).json(event);
  });

  function parseDateRange(query: Record<string, unknown>) {
    const from = query.from ? new Date(query.from as string) : undefined;
    const to = query.to ? new Date(query.to as string) : undefined;
    return (from || to) ? { from, to } : undefined;
  }

  router.get("/companies/:companyId/costs/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const range = parseDateRange(req.query);
    const summary = await costs.summary(companyId, range);
    res.json(summary);
  });

  router.get("/companies/:companyId/costs/by-agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const range = parseDateRange(req.query);
    const rows = await costs.byAgent(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-project", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const range = parseDateRange(req.query);
    const rows = await costs.byProject(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const range = parseDateRange(req.query);
    const rows = await costs.byModel(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/costs/by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const range = parseDateRange(req.query);
    const rows = await costs.byBiller(companyId, range);
    res.json(rows);
  });

  router.patch("/companies/:companyId/budgets", validate(updateBudgetSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const company = await companies.update(companyId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    await budgets.upsertPolicy(companyId, {
      scopeType: "company",
      scopeId: companyId,
      amountCents: req.body.budgetMonthlyCents,
      warnPercent: 80,
      hardStopEnabled: true,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.budget_updated",
      entityType: "company",
      entityId: companyId,
      details: { budgetMonthlyCents: req.body.budgetMonthlyCents },
    });

    res.json(company);
  });

  router.patch("/agents/:agentId/budgets", validate(updateBudgetSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await agents.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    if (req.actor.type === "agent") {
      // An agent may set only its own budget (self-reporting).
      if (req.actor.agentId !== agentId) {
        res.status(403).json({ error: "Agent can only change its own budget" });
        return;
      }
    } else {
      // Human / MCP governance write: must be an interactive board session in the
      // agent's own company. A founder-created MCP key replays the founder userId
      // (auth.ts) and would otherwise reach this privileged cross-tenant write;
      // assertBoard rejects non-board bearer tokens, assertCompanyAccess rejects
      // foreign companies. Mirrors the sibling PATCH /companies/:cid/budgets gate.
      assertBoard(req);
      await assertCompanyAccess(db, req, agent.companyId);
    }

    const updated = await agents.update(agentId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await budgets.upsertPolicy(updated.companyId, {
      scopeType: "agent",
      scopeId: agentId,
      amountCents: req.body.budgetMonthlyCents,
      warnPercent: 80,
      hardStopEnabled: true,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.budget_updated",
      entityType: "agent",
      entityId: updated.id,
      details: { budgetMonthlyCents: updated.budgetMonthlyCents },
    });

    res.json(updated);
  });

  router.get("/companies/:companyId/budgets/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const [policies, openIncidents] = await Promise.all([
      budgets.listPolicies(companyId),
      budgets.listOpenIncidents(companyId),
    ]);
    res.json({ policies, openIncidents });
  });

  router.post("/companies/:companyId/budgets/policies", validate(upsertBudgetPolicySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const policy = await budgets.upsertPolicy(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "budget.policy_upserted",
      entityType: "company",
      entityId: companyId,
      details: { scopeType: req.body.scopeType, scopeId: req.body.scopeId, amountCents: req.body.amountCents },
    });
    res.status(201).json(policy);
  });

  router.delete("/companies/:companyId/budgets/policies/:policyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const policyId = req.params.policyId as string;
    await assertCompanyAccess(db, req, companyId);
    const deleted = await budgets.deletePolicy(companyId, policyId);
    if (!deleted) {
      res.status(404).json({ error: "Budget policy not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "budget.policy_deleted",
      entityType: "company",
      entityId: companyId,
      details: { policyId },
    });
    res.json({ ok: true });
  });

  router.post("/companies/:companyId/budget-incidents/:incidentId/resolve", validate(resolveBudgetIncidentSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const incidentId = req.params.incidentId as string;
    await assertCompanyAccess(db, req, companyId);
    await budgets.resolveIncident(incidentId, companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "budget.incident_resolved",
      entityType: "company",
      entityId: companyId,
      details: { incidentId, action: req.body.action },
    });
    res.json({ ok: true });
  });

  return router;
}
