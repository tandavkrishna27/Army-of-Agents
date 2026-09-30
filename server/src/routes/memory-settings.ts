import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { badRequest, notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertDepartmentAccess, assertRole } from "../middleware/rbac.js";
import { memorySettingsService } from "../services/memory-settings.js";
import { logActivity } from "../services/index.js";

/**
 * Settings → Memory governance routes (enterprise memory model, P1-T10).
 *
 * Reads are open to any company member; writes (upsert + override delete) are
 * founder/team_lead gated via `assertRole`. `memory_settings.autonomyLevel` is the
 * AutonomyLevel text enum — a distinct dial from `internal_agent_config.crew_autonomy_level`.
 */
const upsertSchema = z.object({
  departmentId: z.string().uuid().nullable().default(null),
  autonomyLevel: z.enum(["manual", "supervised", "trusted", "policy"]).optional(),
  activeContextTier: z.enum(["ephemeral", "durable", "protected"]).optional(),
});

export function memorySettingsRoutes(db: Db) {
  const router = Router();
  const svc = memorySettingsService(db);

  router.get("/companies/:companyId/memory-settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    res.json(await svc.list(companyId));
  });

  router.put(
    "/companies/:companyId/memory-settings",
    validate(upsertSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertRole(db, req, companyId, "founder", "team_lead");
      const { departmentId, ...patch } = req.body as z.infer<typeof upsertSchema>;
      if (departmentId && !(await svc.getDepartment(companyId, departmentId))) {
        throw notFound("Department not found");
      }
      await assertDepartmentAccess(db, req, companyId, departmentId);
      const row = await svc.upsert(companyId, departmentId, patch);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "memory.settings_updated",
        entityType: "memory_settings",
        entityId: row.id,
        details: { departmentId, ...patch },
      });
      res.json(row);
    },
  );

  router.delete(
    "/companies/:companyId/memory-settings/departments/:departmentId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const departmentId = req.params.departmentId as string;
      if (!z.string().uuid().safeParse(departmentId).success) {
        throw badRequest("Invalid departmentId");
      }
      await assertCompanyAccess(db, req, companyId);
      assertBoard(req);
      await assertRole(db, req, companyId, "founder", "team_lead");
      if (!(await svc.getDepartment(companyId, departmentId))) {
        throw notFound("Department not found");
      }
      await assertDepartmentAccess(db, req, companyId, departmentId);
      await svc.deleteOverride(companyId, departmentId);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "memory.settings_override_deleted",
        entityType: "department",
        entityId: departmentId,
      });
      res.status(204).end();
    },
  );

  return router;
}
