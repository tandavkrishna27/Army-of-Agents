import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import type { UserRole, ListHubItemsQuery, HubLane } from "@armyofagents/shared";
import {
  listHubItemsQuery,
  hubActionSchema,
  hubUserStateSchema,
  hubUndoSchema,
  hubBulkActionSchema,
  updateHubPreferencesSchema,
} from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import {
  hubCounterSnapshotsService,
  hubAutopilotService,
  hubItemsService,
  hubPreferencesService,
  permissionService,
} from "../services/index.js";
import { HttpError, notFound, unauthorized } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { emitStaleWorkHubItems } from "../services/hub-stale-work.js";
import { emitOpenApprovalHubItems } from "../services/hub-approval-requests.js";

// Resolve the board user id for these owner-facing hub routes. Agents/MCP keys
// use separate surfaces; the hub is a human attention/decision plane. Mirrors
// `requireBoardUserId` in inbox-dismissals.ts.
function requireBoardUserId(req: Request): string {
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw unauthorized("Board authentication required");
  }
  return req.actor.userId;
}

// local_implicit (loopback / local_trusted) and instance admins carry
// founder-equivalent authority — the same shortcut `assertRole`/`assertBoard`
// already apply. Otherwise the real role is resolved from `user_roles`.
function hasImplicitFounderAuthority(req: Request): boolean {
  return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
}

export function hubItemRoutes(db: Db) {
  const router = Router();
  const svc = hubItemsService(db);
  const autopilot = hubAutopilotService(db);
  const preferences = hubPreferencesService(db);
  const counterSnapshots = hubCounterSnapshotsService(db, {
    liveCounts: ({ companyId, userId, role }) => svc.counts(companyId, userId, role),
  });
  const perms = permissionService(db);

  // Resolve the effective role for query/counts. Implicit-authority actors
  // (local_trusted, instance admin) are treated as founder so they see all items.
  async function resolveRole(req: Request, companyId: string, userId: string): Promise<UserRole> {
    if (hasImplicitFounderAuthority(req)) return "founder";
    return perms.getEffectiveRole(companyId, userId);
  }

  async function evaluateAutopilotRefresh(companyId: string, limit: number) {
    try {
      await autopilot.evaluateOpenItems({ companyId, limit });
    } catch (error) {
      console.warn("[hub.autopilot] refresh evaluation failed", error);
    }
  }

  async function reconcileRuntimeDecisionHubItems(companyId: string) {
    await svc.reconcile(companyId, { sourceType: "runtime_decision" });
  }

  router.get("/companies/:companyId/hub-items/preferences/me", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    const result = await preferences.get(userId, companyId);
    res.json(result);
  });

  router.patch(
    "/companies/:companyId/hub-items/preferences/me",
    validate(updateHubPreferencesSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req);
      const result = await preferences.upsert(userId, companyId, req.body);
      res.json(result);
    },
  );

  router.post("/companies/:companyId/hub-items/preferences/me/reset", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    const result = await preferences.reset(userId, companyId);
    res.json(result);
  });

  // GET list — RBAC-scoped hot set (open by default), per-user state joined in.
  // List filters arrive on the query string, so parse `req.query` directly (the
  // `validate` middleware only covers `req.body`); a bad value throws a ZodError
  // → 400 via the global error handler. Matches access.ts query-param parsing.
  router.get("/companies/:companyId/hub-items", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    const role = await resolveRole(req, companyId, userId);
    const query: ListHubItemsQuery = listHubItemsQuery.parse(req.query);
    if (!query.lane || query.lane === "waiting_on_you") {
      await emitOpenApprovalHubItems(db, companyId, query.limit);
      await reconcileRuntimeDecisionHubItems(companyId);
    }
    if (!query.lane || query.lane === "notifications") {
      await svc.reconcile(companyId, { sourceType: "heartbeat_run" });
      // H3: close/heal the budget_alert item here too so hub-first users (who
      // never hit the sidebar-badges scan) see it close on normalized spend and
      // heal the stale % in place — mirrors the run_failed reconcile above.
      await svc.reconcile(companyId, { sourceType: "company_budget" });
    }
    if (!query.lane || query.lane === "suggestions") {
      await emitStaleWorkHubItems(db, companyId, query.limit);
    }
    await evaluateAutopilotRefresh(companyId, query.limit);
    const items = await svc.query(companyId, {
      actorUserId: userId,
      role,
      lane: query.lane,
      status: query.status,
      includeDismissed: query.includeDismissed,
      includeSnoozed: query.includeSnoozed,
      q: query.q,
      cursor: query.cursor,
      groupMode: query.groupMode,
      limit: query.limit,
    });
    res.json(items);
  });

  // GET counts — RBAC-scoped { open, unread } badge counters (live count).
  router.get("/companies/:companyId/hub-items/counts", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    const role = await resolveRole(req, companyId, userId);
    await emitOpenApprovalHubItems(db, companyId);
    await emitStaleWorkHubItems(db, companyId, null);
    await reconcileRuntimeDecisionHubItems(companyId);
    await evaluateAutopilotRefresh(companyId, 25);
    const result = await counterSnapshots.getOrRefresh({ companyId, userId, role });
    res.json(result);
  });

  // GET hidden-count — per-lane count of OPEN items THIS user has personally
  // dismissed/snoozed. Powers the waiting-lane "N hidden" chip (the dismiss-hole
  // safety net). Lane-scoped + per-actor; never touches the {open,unread} snapshot
  // cache. Defaults to the waiting lane (the only lane that surfaces the chip).
  router.get("/companies/:companyId/hub-items/hidden-count", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    const role = await resolveRole(req, companyId, userId);
    const laneParam = typeof req.query.lane === "string" ? req.query.lane : undefined;
    const lane: HubLane =
      laneParam === "notifications" || laneParam === "suggestions"
        ? laneParam
        : "waiting_on_you";
    const hiddenOpen = await svc.hiddenCount(companyId, userId, lane, role);
    res.json({ hiddenOpen });
  });

  // GET item — RBAC-scoped hydration route for realtime toasts/viewers. Live
  // events only carry metadata; clients load rich title/summary fields here.
  router.get("/companies/:companyId/hub-items/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const hubItemId = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    const role = await resolveRole(req, companyId, userId);
    const item = await svc.getVisible(companyId, {
      hubItemId,
      actorUserId: userId,
      role,
      status: "any",
    });
    if (!item) throw notFound("Hub item not found");
    res.json(item);
  });

  // POST action — optimistic-concurrency transition + audit-before-side-effect.
  // The Authority gate lives in the service; the route resolves `actorIsFounder`.
  router.post(
    "/companies/:companyId/hub-items/:id/action",
    validate(hubActionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const hubItemId = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req);
      // Board/local_implicit/instance-admin actors carry founder-authority;
      // otherwise resolve the real founder role from user_roles.
      const actorIsFounder = hasImplicitFounderAuthority(req)
        ? true
        : await perms.isFounder(companyId, userId);

      const { action, expectedVersion, idempotencyKey, reason } = req.body as {
        action: "resolve" | "archive" | "claim" | "release";
        expectedVersion: number;
        idempotencyKey?: string;
        reason?: string;
      };
      let item;
      try {
        item = await svc.recordLifecycleAction({
          companyId,
          hubItemId,
          action,
          expectedVersion,
          actorType: "user",
          actorId: userId,
          actorIsFounder,
          authorityBasis: actorIsFounder ? "founder" : "owner",
          reason,
          idempotencyKey,
        });
      } catch (err) {
        // conflict→409, notFound→404, forbidden→403 — same HttpError convention
        // as goals.ts (the helpers all return an HttpError carrying `.status`).
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.message, details: err.details });
          return;
        }
        throw err;
      }

      res.json(item);
    },
  );

  router.post(
    "/companies/:companyId/hub-items/:id/undo",
    validate(hubUndoSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const hubItemId = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req);
      const { auditId, expectedVersion } = req.body as {
        auditId: string;
        expectedVersion: number;
      };

      const result = await svc.undoAction({
        companyId,
        hubItemId,
        auditId,
        expectedVersion,
        actorType: "user",
        actorId: userId,
      });

      res.json(result);
    },
  );

  // PATCH state — upsert the sparse per-principal user-state row (read/snooze/
  // dismiss). Keyed on (hubItemId, principalType, principalId) per W6.
  router.get("/companies/:companyId/hub-items/:id/audit", async (req, res) => {
    const companyId = req.params.companyId as string;
    const hubItemId = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    const role = await resolveRole(req, companyId, userId);
    const rows = await svc.getAudit({
      companyId,
      hubItemId,
      actorUserId: userId,
      role,
    });

    res.json(rows);
  });

  router.post(
    "/companies/:companyId/hub-items/bulk-action",
    validate(hubBulkActionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req);
      const role = await resolveRole(req, companyId, userId);
      const actorIsFounder = hasImplicitFounderAuthority(req)
        ? true
        : await perms.isFounder(companyId, userId);
      const body = req.body as {
        bulkId?: string;
        items: Array<{
          id: string;
          action: "resolve" | "archive" | "dismiss" | "snooze" | "claim" | "release";
          expectedVersion?: number;
          until?: string;
          idempotencyKey?: string;
          reason?: string;
        }>;
      };

      const result = await svc.bulkAction({
        companyId,
        actorUserId: userId,
        actorIsFounder,
        role,
        actorType: "user",
        bulkId: body.bulkId,
        items: body.items,
      });

      res.json(result);
    },
  );

  router.patch(
    "/companies/:companyId/hub-items/:id/state",
    validate(hubUserStateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const hubItemId = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req);
      const role = await resolveRole(req, companyId, userId);
      const row = await svc.applyPersonalState({
        companyId,
        hubItemId,
        actorUserId: userId,
        role,
        state: req.body,
      });

      res.json(row);
    },
  );

  return router;
}
