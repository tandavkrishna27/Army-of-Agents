/**
 * @fileoverview Marketplace install REST API routes
 *
 * Mounted under /api/companies/:companyId/marketplace.
 * - POST /install — start install operation, return operation ID (202 Accepted)
 * - GET  /install/:operationId — operation status + cascade results
 * - GET  /resolve/:catalogItemId — preview install plan (cascade tree)
 *
 * All routes require board-level auth (assertBoard).
 * Per-company auth enforced via assertCompanyAccess on req.params.companyId.
 *
 * All install types (skill / agent / team / plugin) flow through `dispatchInstall`.
 * The route layer pre-curries `installPlugin` (and the team installer's
 * `installPlugin` cascade hook) with `pluginLoader`, which is route-layer
 * scoped and not available to the orchestrator.
 */

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@armyofagents/db";
import type { MarketplaceCatalogService } from "../services/aoa-marketplace.js";
import { resolveInstallPlan } from "../services/marketplace-install/resolver.js";
import {
  startInstallOperation,
  startPackageInstallOperation,
  dispatchInstall,
  dispatchPackageInstall,
  installSkill,
  installSkillPackage,
  installAgent,
  installTeam,
  installMarketplacePlugin,
  uninstallTeam,
  findOperationById,
  updateOperation,
  type Installers,
  type DispatchInstallOpts,
} from "../services/marketplace-install/index.js";
import { derivePackages } from "../services/derivePackages.js";
import type { PluginLoaderLike } from "../services/marketplace-install/plugin-installer.js";
import { publishLiveEvent } from "../services/live-events.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { assertRole } from "../middleware/rbac.js";
import { permissionService } from "../services/permissions.js";
import { marketplaceSettingsService } from "../services/marketplace-settings.js";
import { marketplaceNotifications } from "../services/marketplace-notifications.js";
import { logger } from "../middleware/logger.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import { listServerAdapters } from "../adapters/index.js";
import {
  PLUGIN_WORKER_BLOCKED_IN_CLOUD,
  cloudPluginExecutionBlockedEnvelope,
} from "../services/cloud-plugin-execution.js";

/**
 * Check if a user role can install a given catalog item type.
 * @param role - effective user role ('founder' | 'team_lead' | 'team_member')
 * @param type - catalog item type ('skill' | 'agent' | 'team' | 'plugin')
 * @param allowTeamLeadPlugins - from company marketplace settings
 */
export function canInstallType(
  role: string,
  type: string,
  allowTeamLeadPlugins: boolean,
): boolean {
  if (role === "founder") return true;
  if (role === "team_lead") {
    if (type === "plugin") return allowTeamLeadPlugins;
    return true; // skill, agent, team
  }
  return false; // team_member
}

/**
 * Resolve the install access decision for a role + type + settings combination.
 * Returns:
 *   "allow"   — proceed with install
 *   "request" — needs approval: team_member with request permission, OR
 *               team_lead when requireFounderApproval=true
 *   "deny"    — insufficient permissions: return 403
 */
export function resolveInstallDecision(
  role: string,
  type: string,
  settings: {
    allowTeamLeadPlugins: boolean;
    teamMemberCanRequestInstall: boolean;
    requireFounderApproval: boolean;
  },
): "allow" | "request" | "deny" {
  if (role === "founder") return "allow";
  if (settings.requireFounderApproval && role === "team_lead") return "request";
  if (canInstallType(role, type, settings.allowTeamLeadPlugins)) return "allow";
  if (role === "team_member" && settings.teamMemberCanRequestInstall) return "request";
  return "deny";
}

const SingleInstallRequestSchema = z.object({
  catalogItemId: z.string().min(1),
  targetDepartmentId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(100).optional(),
  role: z.enum(["cxo", "lead", "general"]).optional(),
  adapterType: z.string().min(1).max(100).optional(),
});
const PackageInstallRequestSchema = z.object({
  packageId: z.string().min(1),
  catalogItemIds: z.array(z.string().min(1)).min(1),
  idempotencyKey: z.string().min(1).max(100).optional(),
});
const InstallRequestSchema = z.union([SingleInstallRequestSchema, PackageInstallRequestSchema]);

function isPackageInstallRequest(
  request: z.infer<typeof InstallRequestSchema>,
): request is z.infer<typeof PackageInstallRequestSchema> {
  return "packageId" in request;
}

function resolveInstallPlanErrorStatus(err: unknown): number {
  if (err instanceof z.ZodError) return 422;
  const message = err instanceof Error ? err.message : String(err);

  if (message.startsWith("Catalog item not found:")) return 404;
  if (message.startsWith("Failed to fetch ")) return 502;
  if (
    message.startsWith("Required catalog item not found:") ||
    message.startsWith("Catalog defect:") ||
    message.startsWith("Failed to parse agent template JSON") ||
    message.includes(" has no resourceUrl") ||
    message.includes(" resourceUrl must end with ")
  ) {
    return 422;
  }

  return 500;
}

export interface MarketplaceInstallRoutesDeps {
  db: Db;
  catalogService: MarketplaceCatalogService;
  pluginLoader: PluginLoaderLike;
}

export function createMarketplaceInstallRouter(deps: MarketplaceInstallRoutesDeps): Router {
  const { db, catalogService, pluginLoader } = deps;
  const router = Router({ mergeParams: true });

  router.get("/resolve/:catalogItemId", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    if (!companyId) {
      res.status(400).json({ error: "Company context required" });
      return;
    }
    await assertCompanyAccess(db, req, companyId);

    const catalog = await catalogService.readCache();
    if (!catalog) {
      res.status(503).json({ error: "Catalog not yet synced" });
      return;
    }

    try {
      const plan = await resolveInstallPlan({
        catalogItemId: req.params.catalogItemId,
        catalog,
        db,
        companyId,
        availableAdapterTypes: listServerAdapters().map((adapter) => adapter.type),
      });
      res.json(plan);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = resolveInstallPlanErrorStatus(err);
      if (status >= 500) {
        logger.error({ err, catalogItemId: req.params.catalogItemId }, "marketplace resolve failed");
      }
      res.status(status).json({ error: message });
    }
  });

  router.post("/install", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    const userId = req.actor.userId;
    if (!companyId || !userId) {
      res.status(400).json({ error: "Company + user context required" });
      return;
    }
    await assertCompanyAccess(db, req, companyId);

    const parseResult = InstallRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: "Invalid request", details: parseResult.error.flatten() });
      return;
    }
    const request = parseResult.data;

    const catalog = await catalogService.readCache();
    if (!catalog) {
      res.status(503).json({ error: "Catalog not yet synced" });
      return;
    }

    if (isPackageInstallRequest(request)) {
      const packages = derivePackages(catalog.items);
      const pkg = packages.find((candidate) => candidate.id === request.packageId);
      if (!pkg) {
        res.status(404).json({ error: `Package not found: ${request.packageId}` });
        return;
      }

      const expected = [...pkg.memberItemIds].sort();
      const requested = [...request.catalogItemIds].sort();
      if (expected.join("\n") !== requested.join("\n")) {
        res.status(400).json({ error: `Package member mismatch for ${request.packageId}` });
        return;
      }

      const memberItems = catalog.items.filter((item) => pkg.memberItemIds.includes(item.id));
      if (memberItems.length !== pkg.memberItemIds.length) {
        res.status(400).json({ error: `Package member mismatch for ${request.packageId}` });
        return;
      }
      if (memberItems.some((item) => item.type !== "skill")) {
        res.status(400).json({ error: "Install all supports skill-only packages in this version" });
        return;
      }

      if (
        req.actor.type === "board" &&
        req.actor.source !== "local_implicit" &&
        !req.actor.isInstanceAdmin
      ) {
        const effectiveRole = await permissionService(db).getEffectiveRole(companyId, userId);
        const settings = await marketplaceSettingsService(db).get(companyId);

        const decision = resolveInstallDecision(effectiveRole, "skill", settings);
        if (decision === "request") {
          let requestedOp;
          try {
            requestedOp = await startPackageInstallOperation({
              request, companyId, requestedByUserId: userId, db,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: `Failed to queue install request: ${message}` });
            return;
          }
          void updateOperation(db, requestedOp.id, {
            status: "requested",
            completedAt: new Date(),
          }).catch((err) => logger.error({ err }, "marketplace: failed to set package status=requested"));

          void marketplaceNotifications
            .installRequested(db, companyId, pkg.name, userId, requestedOp.id)
            .catch((err) => logger.error({ err }, "marketplace package installRequested notification failed"));
          res.status(202).json({
            queued: true,
            operationId: requestedOp.id,
            status: "requested",
            message: "Install request submitted. A founder will review it.",
          });
          return;
        }
        if (decision === "deny") {
          res.status(403).json({ error: "Insufficient permissions to install package" });
          return;
        }
      }

      const operation = await startPackageInstallOperation({
        request, companyId, requestedByUserId: userId, db,
      });

      void dispatchPackageInstall({
        operation,
        pkg,
        memberItems,
        db,
        installSkillPackage,
        publishLiveEvent,
      });

      res.status(202).json({ operationId: operation.id, status: operation.status });
      return;
    }

    const catalogItem = catalog.items.find((i) => i.id === request.catalogItemId);
    if (!catalogItem) {
      res.status(404).json({ error: `Catalog item not found: ${request.catalogItemId}` });
      return;
    }

    // RBAC check — skip for local_implicit actors (full access by design) and instance admins
    // Agent actors (type !== "board") also bypass — they use separate permission paths
    if (
      req.actor.type === "board" &&
      req.actor.source !== "local_implicit" &&
      !req.actor.isInstanceAdmin
    ) {
      const effectiveRole = await permissionService(db).getEffectiveRole(companyId, userId);
      const settings = await marketplaceSettingsService(db).get(companyId);

      const decision = resolveInstallDecision(effectiveRole, catalogItem.type, settings);
      if (decision === "request") {
        // Persist a pending operation row so founders can review it via GET /install/:operationId,
        // then notify founders that a team member has requested the install.
        let requestedOp;
        try {
          requestedOp = await startInstallOperation({
            request, catalogItem, companyId, requestedByUserId: userId, db,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.status(500).json({ error: `Failed to queue install request: ${message}` });
          return;
        }
        // Transition to terminal "requested" status so polling clients stop waiting.
        // Fire-and-forget — a failure here is logged but doesn't block the 202 response.
        void updateOperation(db, requestedOp.id, {
          status: "requested",
          completedAt: new Date(),
        }).catch((err) => logger.error({ err }, "marketplace: failed to set status=requested"));

        void marketplaceNotifications
          .installRequested(db, companyId, catalogItem.name, userId, requestedOp.id)
          .catch((err) => logger.error({ err }, "marketplace installRequested notification failed"));
        res.status(202).json({
          queued: true,
          operationId: requestedOp.id,
          status: "requested",
          message: "Install request submitted. A founder will review it.",
        });
        return;
      }
      if (decision === "deny") {
        res.status(403).json({ error: `Insufficient permissions to install ${catalogItem.type}` });
        return;
      }
    }

    if ((catalogItem.type === "agent" || catalogItem.type === "team") && !request.targetDepartmentId) {
      res.status(400).json({ error: `targetDepartmentId required for ${catalogItem.type} installs` });
      return;
    }

    const operation = await startInstallOperation({
      request, catalogItem, companyId, requestedByUserId: userId, db,
    });

    const installers: Installers = {
      installSkill,
      installAgent: (opts) =>
        installAgent({
          ...opts,
          availableAdapterTypes: listServerAdapters().map((adapter) => adapter.type),
          instructionsService: agentInstructionsService(),
        }),
      installTeam: (opts) =>
        installTeam({
          ...opts,
          installPlugin: async (pluginOpts) => {
            const r = await installMarketplacePlugin({
              catalogItem: pluginOpts.catalogItem,
              companyId: pluginOpts.companyId,
              db: pluginOpts.db,
              pluginLoader,
            });
            return { pluginId: r.pluginId, alreadyInstalled: r.alreadyInstalled };
          },
        }),
      installPlugin: (opts) => installMarketplacePlugin({ ...opts, pluginLoader }),
    };

    const installOverrides =
      catalogItem.type === "agent" && (request.role || request.adapterType)
        ? {
          ...(request.role ? { role: request.role } : {}),
          ...(request.adapterType ? { adapterType: request.adapterType } : {}),
        }
        : undefined;

    const dispatchOpts: DispatchInstallOpts = {
      operation,
      catalogItem,
      catalog,
      db,
      installers,
      publishLiveEvent,
    };
    if (installOverrides) {
      dispatchOpts.installOverrides = installOverrides;
    }

    void dispatchInstall(dispatchOpts);

    res.status(202).json({ operationId: operation.id, status: operation.status });
  });

  router.get("/install/:operationId", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    if (!companyId) {
      res.status(400).json({ error: "Company context required" });
      return;
    }
    await assertCompanyAccess(db, req, companyId);

    const op = await findOperationById(db, req.params.operationId, companyId);
    if (!op) {
      res.status(404).json({ error: "Operation not found" });
      return;
    }
    if (
      op.status === "failure" &&
      op.itemType === "plugin" &&
      op.errorCode === PLUGIN_WORKER_BLOCKED_IN_CLOUD
    ) {
      res.status(503).json(cloudPluginExecutionBlockedEnvelope());
      return;
    }
    res.json(op);
  });

  // DELETE /api/companies/:companyId/marketplace/teams/:teamId
  router.delete("/teams/:teamId", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    if (!companyId) {
      res.status(400).json({ error: "Company context required" });
      return;
    }
    await assertCompanyAccess(db, req, companyId);
    // Uninstalling a team permanently deletes all its agents — founder-only,
    // same as DELETE /agents/:id. assertRole throws 403 for team_lead / team_member.
    await assertRole(db, req, companyId, "founder");

    const { teamId } = req.params;
    try {
      const result = await uninstallTeam({ db, companyId, teamId });
      // D23: protected AoA agents are detached, not destroyed. Report them
      // explicitly — a 200 that silently kept members the caller asked to
      // remove would be the failure mode that made refusing look attractive.
      res.json({
        success: true,
        deletedAgentIds: result.deletedAgentIds,
        retainedAgentIds: result.retainedAgents.map((a) => a.id),
        retainedAgents: result.retainedAgents,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
        return;
      }
      logger.error({ err, companyId, teamId }, "team uninstall failed");
      res.status(500).json({ error: "Uninstall failed" });
    }
  });

  return router;
}
