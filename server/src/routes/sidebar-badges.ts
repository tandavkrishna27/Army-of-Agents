import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import { and, eq, sql } from "drizzle-orm";
import { joinRequests } from "@armyofagents/db";
import type { UserRole } from "@armyofagents/shared";
import { sidebarBadgeService } from "../services/sidebar-badges.js";
import { issueService } from "../services/issues.js";
import { accessService } from "../services/access.js";
import { dashboardService } from "../services/dashboard.js";
import {
  hubCounterSnapshotsService,
  hubItemsService,
  permissionService,
} from "../services/index.js";
import { emitOpenApprovalHubItems } from "../services/hub-approval-requests.js";
import { emitStaleWorkHubItems } from "../services/hub-stale-work.js";
import { emitLegacyAlertHubItems } from "../services/hub-legacy-alerts.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess } from "./authz.js";

function hasImplicitFounderAuthority(req: Request): boolean {
  return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
}

export function sidebarBadgeRoutes(db: Db) {
  const router = Router();
  const svc = sidebarBadgeService(db);
  const hubItems = hubItemsService(db);
  const counterSnapshots = hubCounterSnapshotsService(db, {
    liveCounts: ({ companyId, userId, role }) => hubItems.counts(companyId, userId, role),
  });
  const perms = permissionService(db);
  const issueSvc = issueService(db);
  const access = accessService(db);
  const dashboard = dashboardService(db);

  async function resolveHubBadgeRole(
    req: Request,
    companyId: string,
    userId: string,
  ): Promise<UserRole> {
    if (hasImplicitFounderAuthority(req)) return "founder";
    return perms.getEffectiveRole(companyId, userId);
  }

  router.get("/companies/:companyId/sidebar-badges", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    let canApproveJoins = false;
    if (req.actor.type === "board") {
      canApproveJoins =
        req.actor.source === "local_implicit" ||
        Boolean(req.actor.isInstanceAdmin) ||
        (await access.canUser(companyId, req.actor.userId, "joins:approve"));
    } else if (req.actor.type === "agent" && req.actor.agentId) {
      canApproveJoins = await access.hasPermission(companyId, "agent", req.actor.agentId, "joins:approve");
    }

    const joinRequestCount = canApproveJoins
      ? await db
        .select({ count: sql<number>`count(*)` })
        .from(joinRequests)
        .where(and(eq(joinRequests.companyId, companyId), eq(joinRequests.status, "pending_approval")))
        .then((rows) => Number(rows[0]?.count ?? 0))
      : 0;

    const badges = await svc.get(companyId, {
      joinRequests: joinRequestCount,
    });
    if (req.actor.type === "board" && req.actor.userId) {
      await emitOpenApprovalHubItems(db, companyId);
      await emitLegacyAlertHubItems(db, companyId);
      // H3: emitLegacyAlertHubItems only (re)fires the budget_alert while
      // utilization stays >= 80%; pair it with a reconcile so clearing/raising the
      // budget (or spend dropping below 80%) closes the item on the very next page
      // load without visiting the Inbox — and heals a stale % in place otherwise.
      // Best-effort: this is background maintenance, not badge data — a reconcile
      // failure must never 500 the hot sidebar-badges route (the Inbox GET path
      // reconciles too, as a backstop).
      try {
        await hubItems.reconcile(companyId, { sourceType: "company_budget" });
      } catch (err) {
        logger.warn({ err, companyId }, "sidebar-badges budget reconcile failed (best-effort)");
      }
      try {
        await hubItems.reconcile(companyId, { sourceType: "heartbeat_run" });
      } catch (err) {
        logger.warn({ err, companyId }, "sidebar-badges heartbeat reconcile failed (best-effort)");
      }
      await emitStaleWorkHubItems(db, companyId, null);
      const role = await resolveHubBadgeRole(req, companyId, req.actor.userId);
      const hubCounts = await counterSnapshots.getOrRefresh({
        companyId,
        userId: req.actor.userId,
        role,
      });
      badges.inbox = hubCounts.open;
    } else {
      const summary = await dashboard.summary(companyId);
      const staleIssueCount = await issueSvc.staleCount(companyId, 24 * 60);
      const hasFailedRuns = badges.failedRuns > 0;
      const alertsCount =
        (summary.agents.error > 0 && !hasFailedRuns ? 1 : 0) +
        (summary.costs.monthBudgetCents > 0 && summary.costs.monthUtilizationPercent >= 80 ? 1 : 0);
      badges.inbox =
        badges.failedRuns + alertsCount + staleIssueCount + joinRequestCount + badges.pendingDiscussions;
    }

    res.json(badges);
  });

  return router;
}
