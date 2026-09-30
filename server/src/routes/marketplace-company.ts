/**
 * @fileoverview Company-scoped marketplace routes (settings + updates).
 * Mounted under /api/companies/:companyId/marketplace (mergeParams: true).
 *
 * GET  /settings          — get company marketplace settings
 * PATCH /settings         — update company marketplace settings
 * GET  /updates           — list pending updates
 * POST /updates/:id/dismiss — dismiss a pending update
 * POST /updates/:id/apply   — apply a pending plugin/skill/agent update in one click
 * GET  /updates/:id/diff  — section-level diff for a skill or agent update
 * POST /updates/:id/merge — apply merge decisions and save merged content
 * POST /request-install   — team_member install request (stub, filled in Task 10)
 *
 * **Agent updates (T2.7).** `/diff` and `/merge` accept `itemType: "agent"`.
 * A skill's reviewable unit is a `## ` section of one markdown file; an agent's
 * is `<file>::<## section>` across its whole instruction bundle, because agent
 * instructions are a bundle and two files may carry the same heading. See
 * `services/marketplace-agent-merge.ts` (the algebra) and
 * `services/marketplace-install/agent-update-merge.ts` (the I/O + the write).
 * `/apply` still refuses TEAM updates only.
 *
 * **Skill merges re-materialize the bundle (T2.8).** The skill branch of
 * `/merge` delegates to `services/marketplace-install/skill-update-merge.ts`,
 * which writes the upstream commit's `references/`, `scripts/` and `assets/`
 * to disk alongside the merged markdown. It used to write markdown only, which
 * left the files an agent actually receives pinned at the old commit. The
 * agent branch stays separate on purpose (Decision #115): its bundle root is
 * founder-editable, so it must never be routed through a materializer.
 */
import { Router } from "express";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { type Db, agents, marketplacePendingUpdates, companySkills, plugins } from "@armyofagents/db";
import { assertBoard, assertCanManageInstanceSettings, assertCompanyAccess } from "./authz.js";
import { assertRole } from "../middleware/rbac.js";
import {
  diagnoseCrewProvisioning,
  repairCompanyCrew,
  type CrewRepairDiagnosis,
} from "../services/crew-repair.js";
import { marketplaceSettingsService } from "../services/marketplace-settings.js";
import { computeSectionDiff } from "../services/marketplace-merge.js";
import { marketplaceNotifications } from "../services/marketplace-notifications.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import {
  applySkillUpdate,
  SkillCustomizedError,
  SkillDeletedError,
} from "../services/marketplace-install/skill-auto-updater.js";
import {
  applyCrewAgentUpdate,
  AgentInstructionsCustomizedError,
} from "../services/marketplace-install/crew-updater.js";
import {
  AgentMergeConflictError,
  computeAgentUpdateDiff,
  mergeAgentUpdate,
  type AgentBundleServiceLike,
  type MergeableAgentRow,
} from "../services/marketplace-install/agent-update-merge.js";
import {
  SkillMergeConflictError,
  SkillMergeUpstreamError,
  mergeSkillUpdate,
  skillMergeSnapshotToken,
} from "../services/marketplace-install/skill-update-merge.js";
import { fetchCatalogResource } from "../services/marketplace-install/fetch-resource.js";
import type { AgentInstructionsServiceLike } from "../services/marketplace-install/agent-create.js";
import { SKILL_CUSTOMIZED_ERROR_CODE, type MarketplaceCatalogFile } from "@armyofagents/shared";
import type { PluginLifecycleManager } from "../services/plugin-lifecycle.js";
import {
  CloudPluginExecutionBlockedError,
  cloudPluginExecutionBlockedEnvelope,
} from "../services/cloud-plugin-execution.js";

export interface MarketplaceCompanyRoutesDeps {
  db: Db;
  catalogService: { readCache(): Promise<MarketplaceCatalogFile | null> };
  /**
   * Agent instruction bundle I/O. Defaults to the real filesystem-backed
   * service; injectable so the agent diff/merge routes can be exercised without
   * touching disk.
   */
  instructionsService?: AgentBundleServiceLike & AgentInstructionsServiceLike;
  pluginLifecycle?: PluginLifecycleManager;
  pluginLoader?: {
    installPlugin(options: {
      packageName: string;
      version: string;
      companyId: string;
    }): Promise<unknown>;
  };
  pluginRollback?: {
    getRollbackTarget(pluginId: string): Promise<{ packageName: string; version: string } | null>;
  };
}

/** Route-safe view of a diagnosis — ids and counts, no row payloads. */
function summarizeDiagnosis(diagnosis: CrewRepairDiagnosis) {
  return {
    verdict: diagnosis.verdict,
    teamId: diagnosis.teamId,
    managedCrewCount: diagnosis.managedCrew.length,
    unmanagedCrewNames: diagnosis.unmanagedCrew.map((row) => row.name),
    operationStatus: diagnosis.operation?.status ?? null,
  };
}

const MarketplaceSettingsPatchSchema = z.object({
  pluginUpdatePolicy:          z.enum(["auto_patch", "auto_minor", "notify_all"]).optional(),
  skillUpdatePolicy:           z.literal("notify").optional(),
  agentUpdatePolicy:           z.enum(["auto", "notify"]).optional(),
  teamUpdatePolicy:            z.enum(["auto", "notify"]).optional(),
  showTrustBadges:             z.boolean().optional(),
  showSourceInfo:              z.boolean().optional(),
  allowTeamLeadPlugins:        z.boolean().optional(),
  teamMemberCanRequestInstall: z.boolean().optional(),
  requireFounderApproval:      z.boolean().optional(),
  catalogRefreshHours:         z.union([z.literal(6), z.literal(12), z.literal(24)]).optional(),
  updateCheckHours:            z.union([z.literal(6), z.literal(12), z.literal(24)]).optional(),
  updateWindow:                z.enum(["anytime", "off_hours", "weekends"]).optional(),
});

export function createMarketplaceCompanyRouter(deps: MarketplaceCompanyRoutesDeps): Router {
  const { db } = deps;
  const router = Router({ mergeParams: true });
  const svc = marketplaceSettingsService(db);
  const instructionsService: AgentBundleServiceLike & AgentInstructionsServiceLike =
    deps.instructionsService ?? agentInstructionsService();

  /**
   * Find the crew agent a pending `itemType: "agent"` update refers to.
   *
   * The join key is `agents.template_origin = marketplace_pending_updates.
   * catalog_item_id` — the same key `checkCrewUpdates` used to mint the row.
   *
   * **Fails closed on ambiguity.** Nothing enforces one agent per origin per
   * company (`installAgent` will happily install the same template twice under a
   * suffixed name), while the pending-update table is unique on
   * (companyId, catalogItemId). Picking one arbitrarily would write a merge into
   * whichever row the planner happened to return first and silently leave the
   * other diverged, so two matches is a 409 the founder can act on instead.
   */
  async function resolveAgentForUpdate(
    companyId: string,
    catalogItemId: string,
  ): Promise<
    | { ok: true; agent: MergeableAgentRow }
    | { ok: false; status: number; body: Record<string, unknown> }
  > {
    const rows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        runtimeConfig: agents.runtimeConfig,
        skillKeys: agents.skillKeys,
        templateOrigin: agents.templateOrigin,
        templateVersion: agents.templateVersion,
        instructionsCustomized: agents.instructionsCustomized,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.templateOrigin, catalogItemId)));

    if (rows.length === 0) {
      return { ok: false, status: 404, body: { error: "Installed agent not found for this update" } };
    }
    if (rows.length > 1) {
      return {
        ok: false,
        status: 409,
        body: {
          error:
            `${rows.length} agents in this company share the template ${catalogItemId}. ` +
            "Remove or re-point the duplicates before reviewing this update.",
          code: "AMBIGUOUS_AGENT_ORIGIN",
        },
      };
    }
    return { ok: true, agent: rows[0] as MergeableAgentRow };
  }

  /** Look up the catalog item a pending update points at. */
  async function resolveCatalogItem(catalogItemId: string) {
    const catalog = await deps.catalogService.readCache();
    return catalog?.items.find((item) => item.id === catalogItemId) ?? null;
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  router.get("/settings", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    await assertCompanyAccess(db, req, companyId);

    const settings = await svc.get(companyId);
    res.json(settings);
  });

  router.patch("/settings", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");

    const parsed = MarketplaceSettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid settings", details: parsed.error.flatten() });
      return;
    }

    const updated = await svc.patch(companyId, parsed.data);
    res.json(updated);
  });

  // ── Updates ───────────────────────────────────────────────────────────────

  router.get("/updates", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    await assertCompanyAccess(db, req, companyId);

    const typeFilter = req.query.type as string | undefined;
    const conditions = [
      eq(marketplacePendingUpdates.companyId, companyId),
      ne(marketplacePendingUpdates.status, "dismissed"),
      ne(marketplacePendingUpdates.status, "applied"),
    ];
    if (typeFilter) {
      conditions.push(eq(marketplacePendingUpdates.itemType, typeFilter));
    }

    const rows = await db.select().from(marketplacePendingUpdates).where(and(...conditions));
    res.json(rows);
  });

  // POST /updates/:id/dismiss
  router.post("/updates/:id/dismiss", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");

    const { id } = req.params as { id: string };
    await db
      .update(marketplacePendingUpdates)
      .set({ status: "dismissed", updatedAt: new Date() })
      .where(
        and(
          eq(marketplacePendingUpdates.id, id),
          eq(marketplacePendingUpdates.companyId, companyId),
        ),
      );
    res.json({ ok: true });
  });

  // POST /updates/:id/apply
  router.post("/updates/:id/apply", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");

    const { id } = req.params as { id: string };
    const [update] = await db
      .select()
      .from(marketplacePendingUpdates)
      .where(
        and(
          eq(marketplacePendingUpdates.id, id),
          eq(marketplacePendingUpdates.companyId, companyId),
        ),
      );

    if (!update) {
      res.status(404).json({ error: "Update not found" });
      return;
    }

    if (update.status !== "pending" && update.status !== "conflict") {
      res.status(409).json({ error: `Update is not pending (current: ${update.status})` });
      return;
    }

    if (update.itemType === "plugin") {
      assertCanManageInstanceSettings(req);

      if (!deps.pluginLifecycle) {
        res.status(501).json({ error: "Plugin update apply is not configured on this server" });
        return;
      }

      let [plugin] = await db
        .select()
        .from(plugins)
        .where(
          and(
            eq(plugins.companyId, companyId),
            eq(plugins.catalogItemId, update.catalogItemId),
          ),
        )
        .limit(1);

      if (!plugin) {
        const catalog = await deps.catalogService.readCache();
        const catalogItem = catalog?.items.find((item) => item.id === update.catalogItemId);
        const packageName = catalogItem?.npm?.packageName;
        if (packageName) {
          [plugin] = await db
            .select()
            .from(plugins)
            .where(
              and(
                eq(plugins.companyId, companyId),
                eq(plugins.packageName, packageName),
              ),
            )
            .limit(1);
        }
      }

      if (!plugin) {
        res.status(404).json({ error: "Installed plugin not found for this marketplace update" });
        return;
      }

      let result: Awaited<ReturnType<PluginLifecycleManager["upgrade"]>>;
      try {
        // Persist cloud policy state before lifecycle status validation. This
        // also prevents a policy denial from being misclassified for rollback.
        await deps.pluginLifecycle.blockActivationInCloud(plugin.id, "marketplace");
        result = await deps.pluginLifecycle.upgrade(plugin.id, update.latestVersion);
      } catch (err) {
        // A cloud policy denial occurs before an upgrade mutates package state.
        // Preserve the canonical contract and never manufacture rollback work.
        if (err instanceof CloudPluginExecutionBlockedError) {
          res.status(503).json(cloudPluginExecutionBlockedEnvelope());
          return;
        }
        const rollbackTarget = await deps.pluginRollback
          ?.getRollbackTarget(plugin.id)
          .catch(() => null);
        if (rollbackTarget && deps.pluginLoader) {
          try {
            await deps.pluginLoader.installPlugin({
              packageName: rollbackTarget.packageName,
              version: rollbackTarget.version,
              companyId,
            });
            await deps.pluginLifecycle.load(plugin.id);
          } catch (rollbackErr) {
            console.error("Marketplace plugin update rollback failed", rollbackErr);
          }
        }
        res.status(400).json({
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (result.status === "ready") {
        await db
          .update(marketplacePendingUpdates)
          .set({ status: "applied", updatedAt: new Date() })
          .where(
            and(
              eq(marketplacePendingUpdates.id, id),
              eq(marketplacePendingUpdates.companyId, companyId),
            ),
          );
      }

      res.json({
        ok: true,
        pluginId: plugin.id,
        version: result.version,
        status: result.status,
        delta: result.delta,
      });
      return;
    }

    if (update.itemType === "skill") {
      const catalog = await deps.catalogService.readCache();
      const catalogItem = catalog?.items.find((item) => item.id === update.catalogItemId);
      if (!catalogItem) {
        res.status(422).json({ error: "Catalog item not found — catalog may be stale." });
        return;
      }
      try {
        await applySkillUpdate({
          db,
          catalogItemId: update.catalogItemId,
          catalogItemName: update.catalogItemName,
          companyId,
          catalogItem,
        });
        res.json({ ok: true, applied: true });
      } catch (err) {
        if (err instanceof SkillCustomizedError) {
          res.status(409).json({
            error: "Skill customized. Manual merge required.",
            code: SKILL_CUSTOMIZED_ERROR_CODE,
          });
        } else if (err instanceof SkillDeletedError) {
          res.status(410).json({ error: "Skill removed.", code: "SKILL_DELETED" });
        } else {
          res.status(500).json({ error: err instanceof Error ? err.message : "Apply failed" });
        }
      }
      return;
    }

    if (update.itemType === "agent") {
      // T2.7 — an agent with NO local divergence must land with one click, the
      // same as a skill. Before this, every agent update answered 501 "use
      // merge", which forced a review even on a provably untouched bundle where
      // there is nothing to review. `applyCrewAgentUpdate` owns the D22 gate, so
      // the customized/unknown rows still fall through to 409 → the merge path.
      const catalogItem = await resolveCatalogItem(update.catalogItemId);
      if (!catalogItem) {
        res.status(422).json({ error: "Catalog item not found — catalog may be stale." });
        return;
      }

      const resolved = await resolveAgentForUpdate(companyId, update.catalogItemId);
      if (!resolved.ok) {
        res.status(resolved.status).json(resolved.body);
        return;
      }

      try {
        await applyCrewAgentUpdate({
          db,
          agentRow: {
            id: resolved.agent.id,
            companyId,
            name: resolved.agent.name,
            adapterType: resolved.agent.adapterType,
            adapterConfig: resolved.agent.adapterConfig,
            runtimeConfig: resolved.agent.runtimeConfig,
            skillKeys: resolved.agent.skillKeys ?? [],
            templateVersion: resolved.agent.templateVersion,
            instructionsCustomized: resolved.agent.instructionsCustomized,
          },
          catalogItem,
          instructionsService,
        });
        res.json({ ok: true, applied: true });
      } catch (err) {
        if (err instanceof AgentInstructionsCustomizedError) {
          res.status(409).json({
            error: "Agent instructions are customized. Manual merge required.",
            code: "AGENT_INSTRUCTIONS_CUSTOMIZED",
          });
        } else {
          res.status(500).json({ error: err instanceof Error ? err.message : "Apply failed" });
        }
      }
      return;
    }

    // For team snapshot types: not implemented at V1.
    res.status(501).json({
      error: "Direct apply not supported for team updates. Use POST /updates/:id/merge for reviewed merge.",
    });
  });

  // GET /updates/:id/diff — returns section-level diff for a skill update
  router.get("/updates/:id/diff", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    await assertCompanyAccess(db, req, companyId);

    const { id } = req.params as { id: string };
    const [update] = await db
      .select()
      .from(marketplacePendingUpdates)
      .where(
        and(
          eq(marketplacePendingUpdates.id, id),
          eq(marketplacePendingUpdates.companyId, companyId),
        ),
      );

    if (!update) {
      res.status(404).json({ error: "Update not found" });
      return;
    }

    if (update.itemType === "agent") {
      const catalogItem = await resolveCatalogItem(update.catalogItemId);
      if (!catalogItem) {
        res.status(422).json({ error: "Catalog item not found — catalog may be stale." });
        return;
      }

      const resolved = await resolveAgentForUpdate(companyId, update.catalogItemId);
      if (!resolved.ok) {
        res.status(resolved.status).json(resolved.body);
        return;
      }

      try {
        const result = await computeAgentUpdateDiff({
          instructions: instructionsService,
          agent: resolved.agent,
          catalogItem,
        });
        res.json({
          diff: result.diff,
          currentVersion: update.currentVersion,
          latestVersion: update.latestVersion,
          // Lets the modal say "nothing of yours is in the way" rather than
          // rendering an all-unchanged wall the founder has to scroll.
          identical: result.identical,
          instructionsCustomized: resolved.agent.instructionsCustomized,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(502).json({ error: `Failed to fetch upstream agent template: ${message}` });
      }
      return;
    }

    if (update.itemType !== "skill") {
      res.status(400).json({ error: "Section diff only supported for skill and agent updates" });
      return;
    }

    // Get current installed skill content
    const [skill] = await db
      .select({ markdown: companySkills.markdown })
      .from(companySkills)
      .where(
        and(
          eq(companySkills.companyId, companyId),
          eq(companySkills.sourceLocator, update.catalogItemId),
        ),
      );

    if (!skill) {
      res.status(404).json({ error: "Installed skill not found" });
      return;
    }

    // Fetch latest from catalog
    const catalog = await deps.catalogService.readCache();
    const catalogItem = catalog?.items.find((i) => i.id === update.catalogItemId);
    if (!catalogItem?.resourceUrl) {
      res.status(503).json({ error: "Catalog item resource URL not available" });
      return;
    }
    try {
      const upstreamContent = await fetchCatalogResource(catalogItem, "skill update diff");

      const diff = computeSectionDiff(skill.markdown ?? "", upstreamContent);
      res.json({
        diff,
        currentVersion: update.currentVersion,
        latestVersion: catalogItem.version,
        snapshotToken: skillMergeSnapshotToken(
          skill.markdown ?? "",
          upstreamContent,
          catalogItem.version,
        ),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: `Failed to fetch upstream content: ${message}` });
    }
  });

  // POST /updates/:id/merge — apply merge decisions and save
  router.post("/updates/:id/merge", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");

    const { id } = req.params as { id: string };
    const { decisions, snapshotToken } = req.body as {
      decisions?: Record<string, "mine" | "theirs">;
      snapshotToken?: string;
    };

    if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) {
      res.status(400).json({ error: "decisions must be an object" });
      return;
    }

    const invalidDecision = Object.values(decisions).find((v) => v !== "mine" && v !== "theirs");
    if (invalidDecision !== undefined) {
      res.status(400).json({ error: `Invalid decision value "${String(invalidDecision)}" — must be "mine" or "theirs"` });
      return;
    }

    const [update] = await db
      .select()
      .from(marketplacePendingUpdates)
      .where(
        and(
          eq(marketplacePendingUpdates.id, id),
          eq(marketplacePendingUpdates.companyId, companyId),
        ),
      );

    if (!update || (update.itemType !== "skill" && update.itemType !== "agent")) {
      res.status(404).json({ error: "Update not found or not mergeable" });
      return;
    }

    // The same guard `/apply` carries (see :272). `/merge` never had one, which
    // was survivable while a merge only rewrote a markdown column — a replay
    // just wrote the same bytes again. It stopped being survivable once a merge
    // started writing FILES: an already-`applied` row's bundle directory is the
    // LIVE one, so replaying a merge asks the materializer to replace a tree the
    // row currently points at. The modal makes that reachable — on a failed
    // request it shows an error and re-enables the button without closing
    // (`SnapshotUpdateModal.tsx` `onError`), so "the response was lost after the
    // commit landed" turns into a second click against an applied row.
    if (update.status !== "pending" && update.status !== "conflict") {
      res.status(409).json({ error: `Update is not pending (current: ${update.status})` });
      return;
    }

    if (update.itemType === "agent") {
      // An agent merge legitimately carries ZERO decisions: the founder opened
      // a `null`-provenance update, found nothing of theirs in the way, and
      // accepted the defaults. The skill path's non-empty guard would turn that
      // — the exact case that drains the T2.6 backlog — into a 400.
      const catalogItem = await resolveCatalogItem(update.catalogItemId);
      if (!catalogItem) {
        res.status(422).json({ error: "Catalog item not found — catalog may be stale." });
        return;
      }

      const resolved = await resolveAgentForUpdate(companyId, update.catalogItemId);
      if (!resolved.ok) {
        res.status(resolved.status).json(resolved.body);
        return;
      }

      try {
        const outcome = await mergeAgentUpdate({
          db,
          instructions: instructionsService,
          agent: resolved.agent,
          catalogItem,
          pendingUpdateId: id,
          decisions,
        });
        res.json({ ok: true, ...outcome });
      } catch (err) {
        if (err instanceof AgentMergeConflictError) {
          res.status(409).json({ error: err.message, code: "AGENT_MERGE_CONFLICT" });
        } else {
          res.status(500).json({ error: err instanceof Error ? err.message : "Merge failed" });
        }
      }
      return;
    }

    if (Object.keys(decisions).length === 0) {
      res.status(400).json({ error: "decisions must not be empty" });
      return;
    }
    if (typeof snapshotToken !== "string" || snapshotToken.length === 0) {
      res.status(400).json({ error: "snapshotToken is required; refresh the diff before merging" });
      return;
    }

    // `metadata` is read (not just written) because the bundle re-materialization
    // patches it rather than replacing it — the row's catalog trust tier and
    // package provenance must survive a merge.
    const [skill] = await db
      .select({
        id: companySkills.id,
        markdown: companySkills.markdown,
        metadata: companySkills.metadata,
        customized: companySkills.customized,
      })
      .from(companySkills)
      .where(
        and(
          eq(companySkills.companyId, companyId),
          eq(companySkills.sourceLocator, update.catalogItemId),
        ),
      );

    if (!skill) {
      res.status(404).json({ error: "Installed skill not found" });
      return;
    }

    const catalog = await deps.catalogService.readCache();
    const catalogItem = catalog?.items.find((i) => i.id === update.catalogItemId);
    if (!catalogItem?.resourceUrl) {
      res.status(503).json({ error: "Catalog resource URL not available" });
      return;
    }

    // T2.8: the merged markdown AND the bundle's files land together. Writing
    // only the markdown left `references/`, `scripts/` and `assets/` pinned at
    // the old commit while `sourceRef` advanced, so nothing would ever repair
    // them. See `skill-update-merge.ts` for the ordering and its failure modes.
    try {
      const outcome = await mergeSkillUpdate({
        db,
        companyId,
        skill,
        catalogItem,
        pendingUpdateId: id,
        expectedSnapshotToken: snapshotToken,
        decisions,
      });
      // `outcome.bundlePath` is deliberately NOT echoed: it is an absolute
      // server path, the client has no use for it, and the merge modal ignores
      // the body entirely today.
      res.json({
        ok: true,
        bundleMaterialized: outcome.bundleMaterialized,
        ...(outcome.fileCount !== undefined ? { bundleFileCount: outcome.fileCount } : {}),
      });
    } catch (err) {
      if (err instanceof SkillMergeConflictError) {
        res.status(409).json({ error: err.message, code: "SKILL_MERGE_CONFLICT" });
      } else if (err instanceof SkillMergeUpstreamError) {
        res.status(502).json({ error: err.message });
      } else {
        res.status(500).json({ error: err instanceof Error ? err.message : "Merge failed" });
      }
    }
  });

  // ── Crew provisioning repair (T2.3b) ──────────────────────────────────────
  //
  // The boot pass (index.ts) is what actually reaches the companies whose
  // founder will never know anything is wrong. This route exists alongside it
  // for the operator who DOES know: it is attributable, immediate, and returns
  // the diagnosis, so "is this company frozen out of crew updates?" is
  // answerable without DB access.
  //
  // Founder-only. It does NOT rewrite instruction bundles, skillKeys or
  // triggers — adoption is pointer-only (`templateOrigin` + `templateVersion`)
  // precisely so an unattended pass can never destroy founder-edited content;
  // the follow-on content change flows through `agentUpdatePolicy`. Do not
  // "improve" this by calling `applyCrewAgentUpdate` here: it deletes the
  // agent's managed-instructions directory outside any transaction. It is
  // founder-only because it changes how the company's agents are GOVERNED.
  //
  // D22 (Decision #114): adopted rows carry `instructions_customized = NULL`
  // (unknown), which `crew-updater` treats as customized — so the follow-on
  // content change is a founder-visible pending update even under `auto`.
  router.post("/crew/repair", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");

    const catalog = await deps.catalogService.readCache();
    if (!catalog) {
      // No catalog = nothing to repair towards. Distinct from "nothing to do".
      res.status(503).json({ error: "Marketplace catalog is not available" });
      return;
    }

    const diagnosis = await diagnoseCrewProvisioning(db, companyId);
    if (diagnosis.verdict === "healthy") {
      res.json({ diagnosis: summarizeDiagnosis(diagnosis), result: { action: "none" } });
      return;
    }

    // Without `force` this shares `CREW_REPAIR_COOLDOWN_MS` with the background
    // pass. That is deliberate: repair fetches, and on a crewless company each
    // call is a full provisioning attempt (catalog wait + install deadline +
    // ~27 fetches), so an un-gated route is a self-inflicted CDN loop. `force`
    // is the explicit operator override for "I just fixed the thing, retry now".
    const force = (req.body as { force?: unknown } | undefined)?.force === true;
    const result = await repairCompanyCrew(db, companyId, {
      catalogItems: catalog.items,
      requestedByUserId: req.actor.userId ?? "board",
      // `force` skips the 6h cooldown but NOT the short floor — a founder
      // holding the button down must not become a fetch loop either.
      force,
    });
    res.json({ diagnosis: summarizeDiagnosis(diagnosis), result });
  });

  // ── Request install ────────────────────────────────────────────────────────

  router.post("/request-install", async (req, res) => {
    assertBoard(req);
    const companyId = (req.params as Record<string, string>).companyId;
    await assertCompanyAccess(db, req, companyId);

    const { catalogItemId } = req.body as { catalogItemId?: string };
    if (!catalogItemId) {
      res.status(400).json({ error: "catalogItemId is required" });
      return;
    }

    // Look up catalog item name for the notification
    const catalog = await deps.catalogService.readCache();
    const catalogItem = catalog?.items.find((i) => i.id === catalogItemId);
    const itemName = catalogItem?.name ?? catalogItemId;

    const requestingUserId = req.actor.userId ?? "unknown";

    // Notify founders of the install request via the distinct install_requested type
    void marketplaceNotifications
      .installRequested(db, companyId, itemName, requestingUserId)
      .catch(() => {});

    res.status(202).json({ queued: true });
  });

  return router;
}
