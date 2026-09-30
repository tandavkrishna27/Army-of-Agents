import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { searchService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function searchRoutes(db: Db) {
  const router = Router();
  const svc = searchService(db);

  router.get("/companies/:companyId/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);

    const q = req.query.q as string | undefined;
    if (!q?.trim()) {
      res.status(400).json({ error: "Query parameter 'q' is required" });
      return;
    }

    const includeArchived = req.query.includeArchived === "true";
    const limitPerType = req.query.limitPerType ? Number(req.query.limitPerType) : undefined;

    // Phase 1 Phase E batch 3 (T24): thread-only filters. The service drops
    // unrecognized values (anything outside `THREAD_INTENTS`/`THREAD_PHASES`
    // narrows nothing because the WHERE clause won't match) — we accept the
    // raw strings here and let the SQL ignore unmatched rows.
    const intent = typeof req.query.intent === "string" ? req.query.intent : undefined;
    const phase = typeof req.query.phase === "string" ? req.query.phase : undefined;
    const participant =
      typeof req.query.participant === "string" ? req.query.participant : undefined;

    const results = await svc.search(companyId, {
      query: q,
      actor: req.actor,
      includeArchived,
      limitPerType: Number.isFinite(limitPerType) ? limitPerType : undefined,
      ...(intent ? { intent } : {}),
      ...(phase ? { phase } : {}),
      ...(participant ? { participant } : {}),
    });

    res.json(results);
  });

  return router;
}
