import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { createFinanceEventSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { financeService } from "../services/finance.js";
import { logActivity } from "../services/activity-log.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function parseDateRange(query: Record<string, unknown>) {
  const from = query.from ? new Date(query.from as string) : undefined;
  const to = query.to ? new Date(query.to as string) : undefined;
  return (from || to) ? { from, to } : undefined;
}

function parseListOptions(query: Record<string, unknown>) {
  const limit = query.limit ? Number(query.limit) : undefined;
  const offset = query.offset ? Number(query.offset) : undefined;
  return {
    limit: Number.isFinite(limit) && limit && limit > 0 ? limit : 100,
    offset: Number.isFinite(offset) && offset && offset > 0 ? offset : 0,
  };
}

export function financeRoutes(db: Db) {
  const router = Router();
  const finance = financeService(db);

  router.post(
    "/companies/:companyId/finance-events",
    validate(createFinanceEventSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      // rbac: instance-admin-not-required — assertCompanyAccess on the line above already enforces scope; assertBoard rejects non-board (agent/mcp) actors from posting finance events.
      assertBoard(req);

      const event = await finance.createEvent(companyId, {
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
        action: "finance_event.reported",
        entityType: "finance_event",
        entityId: event.id,
        details: {
          amountCents: event.amountCents,
          biller: event.biller,
          eventKind: event.eventKind,
          direction: event.direction,
        },
      });

      res.status(201).json(event);
    },
  );

  router.get("/companies/:companyId/finance/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const range = parseDateRange(req.query);
    const summary = await finance.summary(companyId, range);
    res.json(summary);
  });

  router.get("/companies/:companyId/finance/by-biller", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const range = parseDateRange(req.query);
    const rows = await finance.byBiller(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/finance/by-kind", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const range = parseDateRange(req.query);
    const rows = await finance.byKind(companyId, range);
    res.json(rows);
  });

  router.get("/companies/:companyId/finance/list", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const range = parseDateRange(req.query);
    const options = parseListOptions(req.query);
    const rows = await finance.list(companyId, range, options);
    res.json(rows);
  });

  return router;
}
