// Read-only org spend rollup (Phase 5, Task 11). Router-factory `({ db })`
// pattern — see server/src/routes/environments.ts:29 (environmentRoutes) —
// not a global getDb(). No writes; a company-scoped equivalent already exists
// (costRoutes) — this is the org-wide (multi-company) rollup.
import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { getOrgSpend } from "../services/org-spend.js";
import { assertBoard } from "./authz.js";
import { organizationAccessService } from "../services/organization-access.js";
import { forbidden } from "../errors.js";
import { z } from "zod";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const uuidParam = z.string().uuid();

export function orgSpendRoutes(opts: { db: Db }) {
  const router = Router();
  const orgAccess = organizationAccessService(opts.db);

  // RBAC: org owner/admin/billing only (org:spend:view) — financial visibility,
  // read-only. Mirrors the assertBoard + orgAccess.canOrg guard used by
  // organizations.ts / companies.ts for org-scoped endpoints.
  router.get("/organizations/:orgId/spend", async (req, res, next) => {
    try {
      // rbac: instance-admin-not-required — the orgAccess.canOrg check below is the gate.
      assertBoard(req);
      const orgId = uuidParam.parse(req.params.orgId);
      const userId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
      if (!userId) throw forbidden("Sign in to view organization spend");
      const allowed = await orgAccess.canOrg(orgId, userId, "org:spend:view");
      if (!allowed) throw forbidden("You are not authorized to view this organization's spend");

      const since = new Date(Date.now() - THIRTY_DAYS_MS);
      const summary = await getOrgSpend(opts.db, orgId, since);
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
