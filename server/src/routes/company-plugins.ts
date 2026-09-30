/**
 * Company-scoped plugin management routes.
 *
 * Mounted at /api/companies/:companyId/plugins by app.ts.
 *
 * These routes handle plugin management from the company's perspective:
 * - List installed plugins for this company
 * - Read/write per-company plugin config (plugin_config table, company-scoped)
 * - Trigger upgrade (delegates to lifecycle.upgrade())
 * - Approve new capabilities (upgrade_pending → ready)
 * - Rollback to previous version
 * - Toggle plugin enabled/disabled for this company
 */
import { Router } from "express";
import { eq, and, desc, ne } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  plugins,
  pluginConfig,
  pluginCompanySettings,
  pluginVersionSnapshots,
} from "@armyofagents/db";
import {
  assertBoard,
  assertCanManageInstanceSettings,
  assertCompanyAccess,
} from "./authz.js";
import type { PluginLifecycleManager } from "../services/plugin-lifecycle.js";
import type { PluginLoader } from "../services/plugin-loader.js";
import {
  CloudPluginExecutionBlockedError,
  cloudPluginExecutionBlockedEnvelope,
  isCloudPluginExecutionBlocked,
  projectCloudPluginPolicyState,
  recordCloudPluginBlock,
} from "../services/cloud-plugin-execution.js";

export function companyPluginRoutes(
  db: Db,
  lifecycle: PluginLifecycleManager,
  loader: PluginLoader
) {
  const router = Router({ mergeParams: true });

  // ── GET /api/companies/:companyId/plugins ────────────────────────────────
  // List all plugins installed for this company with their settings overlay.
  router.get("/", async (req, res) => {
    assertBoard(req);
    const params = req.params as Record<string, string>;
    const companyId = params.companyId;
    await assertCompanyAccess(db, req, companyId);

    const [installed, settings] = await Promise.all([
      db
        .select()
        .from(plugins)
        .where(
          and(
            eq(plugins.companyId, companyId),
            ne(plugins.status, "uninstalled")
          )
        )
        .orderBy(plugins.installedAt),
      db
        .select()
        .from(pluginCompanySettings)
        .where(eq(pluginCompanySettings.companyId, companyId)),
    ]);

    const settingsMap = new Map(settings.map((s) => [s.pluginId, s]));

    const result = installed.map((plugin) =>
      projectCloudPluginPolicyState({
        id: plugin.id,
        companyId: plugin.companyId,
        catalogItemId: plugin.catalogItemId,
        pluginKey: plugin.pluginKey,
        packageName: plugin.packageName,
        version: plugin.version,
        status: plugin.status,
        statusReasonCode: plugin.statusReasonCode,
        categories: plugin.categories,
        manifest: plugin.manifestJson,
        lastError: plugin.lastError,
        installedAt: plugin.installedAt,
        updatedAt: plugin.updatedAt,
        enabled: settingsMap.get(plugin.id)?.enabled ?? true,
      })
    );

    res.json(result);
  });

  // ── GET /api/companies/:companyId/plugins/:pluginId/config ───────────────
  router.get("/:pluginId/config", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params as {
      companyId: string;
      pluginId: string;
    };
    await assertCompanyAccess(db, req, companyId);
    assertCanManageInstanceSettings(req);

    const [ownedPlugin] = await db
      .select({ id: plugins.id, status: plugins.status })
      .from(plugins)
      .where(and(eq(plugins.companyId, companyId), eq(plugins.id, pluginId)));
    if (!ownedPlugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const [config] = await db
      .select()
      .from(pluginConfig)
      .where(
        and(
          eq(pluginConfig.companyId, companyId),
          eq(pluginConfig.pluginId, pluginId)
        )
      );

    res.json({ configJson: config?.configJson ?? {} });
  });

  // ── POST /api/companies/:companyId/plugins/:pluginId/config ──────────────
  // Upsert per-company plugin config.
  router.post("/:pluginId/config", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params as {
      companyId: string;
      pluginId: string;
    };
    await assertCompanyAccess(db, req, companyId);
    // H9: plugin config rewrite (incl. secret-ref bindings / devUiUrl) is a
    // host-trust operation — gate it to instance admins, matching the
    // instance-scoped plugin routes (plugins.ts). In authenticated mode any
    // company member is a `board` actor and assertCompanyAccess passes for any
    // member, so without this a team_member could rewrite plugin config.
    // (local_implicit passes — loopback trust in local_trusted is unchanged.)
    assertCanManageInstanceSettings(req);

    const { configJson } = req.body as { configJson: Record<string, unknown> };
    if (!configJson || typeof configJson !== "object") {
      res.status(400).json({ error: "configJson must be an object" });
      return;
    }

    // Verify plugin belongs to this company
    const [plugin] = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(and(eq(plugins.companyId, companyId), eq(plugins.id, pluginId)));

    if (!plugin) {
      res.status(404).json({ error: "Plugin not found for this company" });
      return;
    }

    const [existing] = await db
      .select()
      .from(pluginConfig)
      .where(
        and(
          eq(pluginConfig.companyId, companyId),
          eq(pluginConfig.pluginId, pluginId)
        )
      );

    if (existing) {
      const [updated] = await db
        .update(pluginConfig)
        .set({ configJson, updatedAt: new Date() })
        .where(eq(pluginConfig.id, existing.id))
        .returning();
      res.json({ configJson: updated.configJson });
    } else {
      const [inserted] = await db
        .insert(pluginConfig)
        .values({ companyId, pluginId, configJson })
        .returning();
      res.json({ configJson: inserted.configJson });
    }
  });

  // ── POST /api/companies/:companyId/plugins/:pluginId/upgrade ─────────────
  // Trigger upgrade to the latest catalog version.
  // Returns { version, status: 'ready' | 'upgrade_pending', delta? }
  // Note: lifecycle.upgrade() saves the rollback snapshot internally.
  router.post("/:pluginId/upgrade", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params as {
      companyId: string;
      pluginId: string;
    };
    await assertCompanyAccess(db, req, companyId);
    // H9: drives host-side `npm install <version>` of the plugin package —
    // instance-admin only, matching the instance-scoped routes.
    assertCanManageInstanceSettings(req);

    const { version } = req.body as { version?: string };

    if (version !== undefined && typeof version !== "string") {
      res.status(400).json({ error: "version must be a string" });
      return;
    }

    const [plugin] = await db
      .select()
      .from(plugins)
      .where(and(eq(plugins.companyId, companyId), eq(plugins.id, pluginId)));

    if (!plugin) {
      res.status(404).json({ error: "Plugin not found for this company" });
      return;
    }

    try {
      // Reconcile the durable cloud denial before status validation or any
      // auto-rollback path can perform package work.
      await lifecycle.blockActivationInCloud(plugin.id, "direct");
      const result = await lifecycle.upgrade(plugin.id, version);
      res.json(result);
    } catch (err) {
      if (err instanceof CloudPluginExecutionBlockedError) {
        res.status(503).json(cloudPluginExecutionBlockedEnvelope());
        return;
      }
      // Auto-rollback: find the most recent snapshot and reinstall
      const [snapshot] = await db
        .select()
        .from(pluginVersionSnapshots)
        .where(
          and(
            eq(pluginVersionSnapshots.companyId, companyId),
            eq(pluginVersionSnapshots.pluginId, pluginId)
          )
        )
        .orderBy(desc(pluginVersionSnapshots.createdAt))
        .limit(1);

      if (snapshot) {
        try {
          await loader.upgradePlugin(plugin.id, {
            packageName: snapshot.packageName,
            version: snapshot.version,
          });
          await lifecycle.load(plugin.id);
          await db
            .delete(pluginVersionSnapshots)
            .where(eq(pluginVersionSnapshots.id, snapshot.id));
        } catch (revertErr) {
          // Plugin is in broken state — log but don't mask the original error
          console.error("Auto-rollback failed", revertErr);
        }
      }

      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ── POST /api/companies/:companyId/plugins/:pluginId/upgrade/approve ─────
  // Approve new capabilities and transition upgrade_pending → ready.
  router.post("/:pluginId/upgrade/approve", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params as {
      companyId: string;
      pluginId: string;
    };
    await assertCompanyAccess(db, req, companyId);
    // H9: transitions upgrade_pending -> ready, approving NEWLY-ESCALATED plugin
    // capabilities before the worker restarts with the more-powerful manifest.
    // This is the human-in-the-loop operator gate — instance-admin only.
    assertCanManageInstanceSettings(req);

    const [plugin] = await db
      .select()
      .from(plugins)
      .where(and(eq(plugins.companyId, companyId), eq(plugins.id, pluginId)));

    if (!plugin) {
      res.status(404).json({ error: "Plugin not found for this company" });
      return;
    }

    try {
      // Cloud policy must win over lifecycle-state validation so callers get
      // the canonical typed denial even after boot reconciles the row to error.
      await lifecycle.blockActivationInCloud(plugin.id, "direct");
    } catch (err) {
      if (err instanceof CloudPluginExecutionBlockedError) {
        res.status(503).json(cloudPluginExecutionBlockedEnvelope());
        return;
      }
      throw err;
    }

    if (plugin.status !== "upgrade_pending") {
      res.status(400).json({
        error: `Plugin is not in upgrade_pending state (current: ${plugin.status})`,
      });
      return;
    }

    try {
      await lifecycle.load(plugin.id);
      res.json({ status: "ready" });
    } catch (err) {
      if (err instanceof CloudPluginExecutionBlockedError) {
        res.status(503).json(cloudPluginExecutionBlockedEnvelope());
        return;
      }
      throw err;
    }
  });

  // ── POST /api/companies/:companyId/plugins/:pluginId/upgrade/rollback ────
  // Cancel upgrade — restore from snapshot, transition back to ready.
  router.post("/:pluginId/upgrade/rollback", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params as {
      companyId: string;
      pluginId: string;
    };

    // RW5a: rollback's own "loader" gate is the ENTRY boundary — it delegates
    // to `loader.upgradePlugin`, which stays allowed on cloud; the manifest
    // re-import that upgrade performs internally is separately gated by
    // "loader-import" and stays blocked in the control plane.
    if (isCloudPluginExecutionBlocked("loader")) {
      recordCloudPluginBlock({
        pluginId,
        companyId,
        source: "direct",
        sink: "loader",
      });
      res.status(503).json(cloudPluginExecutionBlockedEnvelope());
      return;
    }

    await assertCompanyAccess(db, req, companyId);
    // H9: rolls the plugin back to a prior version (host-side) — instance-admin only.
    assertCanManageInstanceSettings(req);

    const [plugin] = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(and(eq(plugins.companyId, companyId), eq(plugins.id, pluginId)));

    if (!plugin) {
      res.status(404).json({ error: "Plugin not found for this company" });
      return;
    }

    const [snapshot] = await db
      .select()
      .from(pluginVersionSnapshots)
      .where(
        and(
          eq(pluginVersionSnapshots.companyId, companyId),
          eq(pluginVersionSnapshots.pluginId, pluginId)
        )
      )
      .orderBy(desc(pluginVersionSnapshots.createdAt))
      .limit(1);

    if (!snapshot) {
      res
        .status(404)
        .json({ error: "No rollback snapshot found for this plugin" });
      return;
    }

    try {
      await loader.upgradePlugin(plugin.id, {
        packageName: snapshot.packageName,
        version: snapshot.version,
      });

      const [updatedPlugin] = await db
        .select()
        .from(plugins)
        .where(and(eq(plugins.companyId, companyId), eq(plugins.id, pluginId)));

      if (updatedPlugin) await lifecycle.load(updatedPlugin.id);

      res.json({ status: "ready", version: snapshot.version });
    } catch (err) {
      if (err instanceof CloudPluginExecutionBlockedError) {
        res.status(503).json(cloudPluginExecutionBlockedEnvelope());
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ── PATCH /api/companies/:companyId/plugins/:pluginId/settings ───────────
  // Toggle enabled/disabled for this company.
  router.patch("/:pluginId/settings", async (req, res) => {
    assertBoard(req);
    const { companyId, pluginId } = req.params as {
      companyId: string;
      pluginId: string;
    };
    await assertCompanyAccess(db, req, companyId);
    // H9: enabling/disabling a plugin for the company is an operator decision —
    // instance-admin only, matching PUT /companies/:cid/plugin-settings/:pid.
    assertCanManageInstanceSettings(req);

    const { enabled } = req.body as { enabled: boolean };
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }

    const [ownedPlugin] = await db
      .select({ id: plugins.id, status: plugins.status })
      .from(plugins)
      .where(and(eq(plugins.companyId, companyId), eq(plugins.id, pluginId)));
    if (!ownedPlugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    if (enabled) {
      try {
        await lifecycle.blockActivationInCloud(ownedPlugin.id, "direct");
      } catch (err) {
        if (err instanceof CloudPluginExecutionBlockedError) {
          res.status(503).json(cloudPluginExecutionBlockedEnvelope());
          return;
        }
        throw err;
      }
    }

    const [existing] = await db
      .select()
      .from(pluginCompanySettings)
      .where(
        and(
          eq(pluginCompanySettings.companyId, companyId),
          eq(pluginCompanySettings.pluginId, pluginId)
        )
      );

    let savedEnabled: boolean;
    if (existing) {
      const [updated] = await db
        .update(pluginCompanySettings)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(pluginCompanySettings.id, existing.id))
        .returning();
      savedEnabled = updated.enabled;
    } else {
      const [inserted] = await db
        .insert(pluginCompanySettings)
        .values({ companyId, pluginId, enabled })
        .returning();
      savedEnabled = inserted.enabled;
    }

    // Revocation is persisted before touching the in-memory runtime. On disable,
    // route/host gates are therefore closed even if teardown fails. On enable,
    // a failed activation leaves the lifecycle non-ready and still blocked.
    try {
      if (!enabled && ownedPlugin.status === "ready") {
        await lifecycle.disable(pluginId, "Disabled for company");
      } else if (enabled && ownedPlugin.status === "disabled") {
        await lifecycle.enable(pluginId);
      }
    } catch (err) {
      if (err instanceof CloudPluginExecutionBlockedError) {
        res.status(503).json(cloudPluginExecutionBlockedEnvelope());
        return;
      }
      throw err;
    }
    res.json({ enabled: savedEnabled });
  });

  return router;
}
