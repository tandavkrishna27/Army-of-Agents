import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { patchInstanceExperimentalSettingsSchema, patchInstanceGeneralSettingsSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { assertCanManageInstanceSettings, getActorInfo } from "./authz.js";
import type { KillSwitchWriteEntry, KillSwitchDocument } from "../services/execution-kill-switches.js";

export function instanceSettingsRoutes(db: Db) {
  const router = Router();
  const svc = instanceSettingsService(db);

  router.get("/instance/settings/general", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.json(await svc.getGeneral());
  });

  router.patch(
    "/instance/settings/general",
    validate(patchInstanceGeneralSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateGeneral(req.body);
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              general: updated.general,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.general);
    },
  );

  router.get("/instance/settings/experimental", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.json(await svc.getExperimental());
  });

  router.patch(
    "/instance/settings/experimental",
    validate(patchInstanceExperimentalSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateExperimental(req.body);
      const actor = getActorInfo(req);
      const companyIds = await svc.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.experimental_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              experimental: updated.experimental,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.experimental);
    },
  );

  // ── REL-004 Lane C — the operator kill-switch write path ────────────────────────
  // Enforcement (evaluateKillSwitches, drain on match) is already live on the worker poll;
  // this is the missing writer so an operator no longer needs hand-SQL to throw a switch.

  router.get("/instance/kill-switches", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.json({ killSwitches: await svc.getKillSwitches() });
  });

  router.put("/instance/kill-switches", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const switches = (req.body as { switches?: unknown } | null)?.switches;
    if (!Array.isArray(switches)) {
      res.status(400).json({ error: "body.switches must be an array of kill switches" });
      return;
    }
    let result: { document: KillSwitchDocument; settingsId: string };
    try {
      // Fail-closed: setKillSwitches -> buildKillSwitchDocument refuses an unreadable
      // document (which would drain every fleet). Refusal is a 400, not a 500.
      result = await svc.setKillSwitches(switches as KillSwitchWriteEntry[]);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "invalid kill-switch document" });
      return;
    }
    const actor = getActorInfo(req);
    const companyIds = await svc.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "instance.kill_switches_set",
          entityType: "instance_settings",
          entityId: result.settingsId,
          details: {
            switchCount: result.document.switches.length,
            dimensions: result.document.switches.map((entry) => entry.dimension),
          },
        }),
      ),
    );
    res.json(result.document);
  });

  router.delete("/instance/kill-switches", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const { settingsId } = await svc.clearKillSwitches();
    const actor = getActorInfo(req);
    const companyIds = await svc.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "instance.kill_switches_cleared",
          entityType: "instance_settings",
          entityId: settingsId,
          details: {},
        }),
      ),
    );
    res.status(204).end();
  });

  return router;
}
