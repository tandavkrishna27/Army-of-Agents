import { Router, type Request } from "express";
import { type Db } from "@armyofagents/db";
import {
  companySkillCreateSchema,
  companySkillFileUpdateSchema,
  companySkillImportSchema,
  companySkillImportPackageSchema,
  companySkillProjectScanRequestSchema,
  SKILL_CUSTOMIZED_ERROR_CODE,
  SKILL_NAME_TAKEN_ERROR_CODE,
} from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, companySkillService, logActivity } from "../services/index.js";
import { marketplaceNotifications } from "../services/marketplace-notifications.js";
import { forbidden, HttpError } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function companySkillRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = companySkillService(db);

  /**
   * T2.9 — the founder-visible record of a refused install. The service owns the
   * gate (it throws / reports `refusedCustomized`); the route owns telling the
   * founder, next to the activity log it already writes.
   *
   * Entirely best-effort, name lookup included: a correct 409 must never become
   * a 500 because the notification we tried to attach to it failed.
   *
   * Skips silently when the skill no longer exists. Refusing on an empty
   * RETURNING is right (see the service), but that case can also mean the row was
   * deleted concurrently — and a durable "Kept your edits to X" hub item for a
   * deleted skill would never be auto-closed (`company_skill` has no
   * SOURCE_RECONCILERS entry).
   */
  async function notifyRefusedCustomized(companyId: string, skillId: string) {
    try {
      const skill = await svc.getById(skillId);
      if (!skill || skill.companyId !== companyId) return;
      await marketplaceNotifications.skillUpdateRefusedCustomized(db, companyId, skill.name, skillId);
    } catch {
      // marketplaceNotifications already logs; never fail the request on this.
    }
  }

  function customizedRefusalFrom(err: unknown): { skillId: string } | null {
    if (!(err instanceof HttpError) || err.status !== 409) return null;
    const details = err.details;
    if (!details || typeof details !== "object") return null;
    const record = details as Record<string, unknown>;
    if (record.code !== SKILL_CUSTOMIZED_ERROR_CODE || typeof record.skillId !== "string") return null;
    return { skillId: record.skillId };
  }

  function isSkillNameTaken(err: unknown): err is HttpError {
    if (!(err instanceof HttpError) || err.status !== 409) return false;
    const details = err.details;
    if (!details || typeof details !== "object") return false;
    return (details as Record<string, unknown>).code === SKILL_NAME_TAKEN_ERROR_CODE;
  }

  function canCreateAgents(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanMutateCompanySkills(req: Request, companyId: string) {
    await assertCompanyAccess(db, req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return;
    }

    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "agents:create");
    if (allowedByGrant || canCreateAgents(actorAgent)) {
      return;
    }

    throw forbidden("Missing permission: can create agents");
  }

  router.get("/companies/:companyId/skills", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCompanyAccess(db, req, companyId);
    const result = await svc.detail(companyId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/update-status", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCompanyAccess(db, req, companyId);
    const result = await svc.updateStatus(companyId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.get("/companies/:companyId/skills/:skillId/files", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    const relativePath = String(req.query.path ?? "SKILL.md");
    await assertCompanyAccess(db, req, companyId);
    const result = await svc.readFile(companyId, skillId, relativePath);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/companies/:companyId/skills",
    validate(companySkillCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      let result;
      try {
        result = await svc.createLocalSkill(companyId, req.body);
      } catch (err) {
        if (!isSkillNameTaken(err)) throw err;
        res.status(409).json({
          error: err.message,
          code: SKILL_NAME_TAKEN_ERROR_CODE,
          details: err.details,
        });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_created",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          name: result.name,
        },
      });

      res.status(201).json(result);
    },
  );

  router.patch(
    "/companies/:companyId/skills/:skillId/files",
    validate(companySkillFileUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.updateFile(
        companyId,
        skillId,
        String(req.body.path ?? ""),
        String(req.body.content ?? ""),
      );

      // The customized flag is written inside svc.updateFile(): byte-derived
      // atomically with markdown for SKILL.md, standalone for other files.

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_file_updated",
        entityType: "company_skill",
        entityId: skillId,
        details: {
          path: result.path,
          markdown: result.markdown,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/import-package",
    validate(companySkillImportPackageSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const fileMap = req.body.files as Record<string, string>;
      const result = await svc.importPackageFiles(companyId, fileMap);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skill_created",
        entityType: "company_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          name: result.name,
          fileCount: Object.keys(fileMap).length,
        },
      });

      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/import",
    validate(companySkillImportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const source = String(req.body.source ?? "");
      const result = await svc.importFromSource(companyId, source);

      // T2.9 — rows this import declined to overwrite because they carry
      // founder edits. Surfaced in the response body AND as a hub item.
      for (const refused of result.refusedCustomized) {
        await notifyRefusedCustomized(companyId, refused.skillId);
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skills_imported",
        entityType: "company",
        entityId: companyId,
        details: {
          source,
          importedCount: result.imported.length,
          importedSlugs: result.imported.map((skill) => skill.slug),
          warningCount: result.warnings.length,
          refusedCustomizedKeys: result.refusedCustomized.map((entry) => entry.key),
        },
      });

      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/skills/scan-projects",
    validate(companySkillProjectScanRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanySkills(req, companyId);
      const result = await svc.scanProjectWorkspaces(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.skills_scanned",
        entityType: "company",
        entityId: companyId,
        details: {
          scannedProjects: result.scannedProjects,
          scannedWorkspaces: result.scannedWorkspaces,
          discovered: result.discovered,
          importedCount: result.imported.length,
          updatedCount: result.updated.length,
          conflictCount: result.conflicts.length,
          warningCount: result.warnings.length,
        },
      });

      res.json(result);
    },
  );

  router.delete("/companies/:companyId/skills/:skillId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId);
    const result = await svc.deleteSkill(companyId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_deleted",
      entityType: "company_skill",
      entityId: result.id,
      details: {
        slug: result.slug,
        name: result.name,
      },
    });

    res.json(result);
  });

  router.post("/companies/:companyId/skills/:skillId/install-update", async (req, res) => {
    const companyId = req.params.companyId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateCompanySkills(req, companyId);

    let result;
    try {
      result = await svc.installUpdate(companyId, skillId);
    } catch (err) {
      const refusal = customizedRefusalFrom(err);
      if (!refusal) throw err;

      // T2.9 — refused because the skill carries founder edits. Everything from
      // here is best-effort: the founder must get the 409, never a 500 caused by
      // the notification we tried to attach to it. The name lookup lives INSIDE
      // the guarded block for that reason.
      await notifyRefusedCustomized(companyId, refusal.skillId);

      // Answer with the catalog path's top-level `code` as well as the
      // HttpError-shaped `details`, so one client check works on both surfaces
      // (`MarketplaceUpdatesPanel` reads the top-level form).
      res.status(409).json({
        error: (err as HttpError).message,
        code: SKILL_CUSTOMIZED_ERROR_CODE,
        details: (err as HttpError).details,
      });
      return;
    }

    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.skill_update_installed",
      entityType: "company_skill",
      entityId: result.id,
      details: {
        slug: result.slug,
        sourceRef: result.sourceRef,
      },
    });

    res.json(result);
  });

  return router;
}
