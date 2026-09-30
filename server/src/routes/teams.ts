import { Router } from "express";
import type { Db } from "@armyofagents/db";
import {
  createTeamSchema,
  updateTeamSchema,
  addTeamsMemberSchema,
  updateTeamsMemberRoleSchema,
  upsertCoordinationSchema,
  TeamManifestSchema,
} from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import {
  teamsService,
  teamCoordinationService,
  teamScaffolderService,
  teamExportService,
} from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertHumanRole, assertDepartmentAccess } from "../middleware/rbac.js";
import { logger } from "../middleware/logger.js";
import { safeLogActivity } from "../utils/safe-log-activity.js";

const log = logger.child({ route: "teams" });

/**
 * HTTP routes for the new departmental Teams domain (Slice 1 / Task 1.10).
 *
 * Naming note: this factory is exported as `teamsRoutes` (plural) to
 * disambiguate from the pre-existing `teamRoutes` (singular) factory at
 * `server/src/routes/team.ts`, which serves the user/board permissions
 * domain. Both files coexist; they cover different domains. The plural
 * naming convention is also applied to the Zod schemas
 * (`addTeamsMemberSchema`, `updateTeamsMemberRoleSchema`).
 *
 * The service-layer `getById` (Task 1.8) throws `notFound` itself when a
 * team does not exist, so route handlers below trust that throw and do
 * NOT add a redundant `if (!team) throw notFound(...)` check. The thrown
 * `HttpError` is converted to a JSON response by the global error
 * middleware.
 */
export function teamsRoutes(db: Db) {
  const router = Router();
  const svc = teamsService(db);
  const coordSvc = teamCoordinationService(db);
  // B3.2: hoist scaffolder construction to factory time. Other services
  // (`svc`, `coordSvc`) are also factory-scoped — the per-request
  // construction inside the manifest + regenerate handlers was an
  // inconsistency, not a deliberate request-scoping. The scaffolder is
  // stateless and safely shared across requests.
  const scaffolder = teamScaffolderService(db);

  // GET /companies/:companyId/teams
  router.get("/companies/:companyId/teams", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const projectId = req.query.projectId as string | undefined;
    const result = await svc.list(companyId, projectId);
    res.json({ items: result });
  });

  // POST /companies/:companyId/teams
  router.post(
    "/companies/:companyId/teams",
    validate(createTeamSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertHumanRole(db, req, companyId, "team_lead");
      await assertDepartmentAccess(db, req, companyId, req.body.parentProjectId);
      const result = await svc.create(companyId, req.body);
      const actor = getActorInfo(req);
      await safeLogActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "team.created",
        entityType: "team",
        entityId: result.id,
        details: {
          name: result.name,
          parentProjectId: result.parentProjectId,
        },
      });
      res.status(201).json(result);
    },
  );

  // GET /teams/:id
  router.get("/teams/:id", async (req, res) => {
    const id = req.params.id as string;
    const team = await svc.getById(id);
    await assertCompanyAccess(db, req, team.companyId);
    res.json(team);
  });

  // GET /teams/:id/export — download as .team.yaml
  //
  // Read access only — founders, leads, AND members can export their own
  // team's manifest. assertCompanyAccess is sufficient; no assertRole.
  // Activity logging is intentionally skipped for this read-only operation.
  router.get("/teams/:id/export", async (req, res) => {
    const id = req.params.id as string;
    const team = await svc.getById(id);
    await assertCompanyAccess(db, req, team.companyId);

    const exportSvc = teamExportService(db);
    const yaml = await exportSvc.exportYaml(id);

    // P2: defense-in-depth — slugs are produced by `generateTeamSlug` and
    // currently match `[a-z0-9-]+`, but interpolating them raw into a
    // header is a header-injection footgun if that contract ever loosens.
    // Use the RFC 6266 / RFC 5987 `filename*=` form alongside the legacy
    // `filename=` so modern browsers prefer the percent-encoded variant
    // and older clients still get a usable name.
    const filename = `${team.slug}.team.yaml`;
    const safeName = encodeURIComponent(filename);
    res.setHeader("Content-Type", "application/x-yaml");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${safeName}`,
    );
    res.send(yaml);
  });

  // PATCH /teams/:id
  router.patch(
    "/teams/:id",
    validate(updateTeamSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      await assertCompanyAccess(db, req, existing.companyId);
      await assertHumanRole(db, req, existing.companyId, "team_lead");
      await assertDepartmentAccess(db, req, existing.companyId, existing.parentProjectId);
      const result = await svc.update(id, req.body);
      const actor = getActorInfo(req);
      await safeLogActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "team.updated",
        entityType: "team",
        entityId: id,
        details: req.body,
      });
      res.json(result);
    },
  );

  // PUT /teams/:id/manifest
  //
  // Replaces the team's manifest JSONB column wholesale. Cascades to
  // regenerate the auto-managed sections of the team's coordination.md
  // (so e.g. routing rule changes flow into the contract injected into
  // agent system prompts). Skips the cascade silently if no coordination
  // row exists yet — the dedicated `POST /teams/:id/coordination/regenerate`
  // is the right call site to scaffold a fresh one.
  router.put(
    "/teams/:id/manifest",
    validate(TeamManifestSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const team = await svc.getById(id);
      await assertCompanyAccess(db, req, team.companyId);
      await assertHumanRole(db, req, team.companyId, "team_lead");
      await assertDepartmentAccess(db, req, team.companyId, team.parentProjectId);

      const result = await svc.updateManifest(id, req.body);

      // Cascade: refresh auto sections of coordination.md if one exists.
      const existing = await coordSvc.getByTeam(id);
      if (existing) {
        const sections = await scaffolder.regenerateAutoContent(id);
        await coordSvc.regenerateAutoSections(existing.id, sections);
      }

      const actor = getActorInfo(req);
      await safeLogActivity(db, {
        companyId: team.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "team.manifest_updated",
        entityType: "team",
        entityId: id,
        details: {
          schemaVersion: req.body.schemaVersion,
          version: req.body.version,
        },
      });
      res.json(result);
    },
  );

  // DELETE /teams/:id (archives — soft delete)
  router.delete("/teams/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    await assertCompanyAccess(db, req, existing.companyId);
    await assertHumanRole(db, req, existing.companyId, "team_lead");
    await assertDepartmentAccess(db, req, existing.companyId, existing.parentProjectId);
    await svc.archive(id);
    const actor = getActorInfo(req);
    await safeLogActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "team.archived",
      entityType: "team",
      entityId: id,
    });
    res.status(204).end();
  });

  // DELETE /teams/:id/dismantle (hard delete — cascades to team_members +
  // team_coordinations). Agents survive. Founder escape hatch for "I imported
  // the wrong team and want to undo it cleanly." For temporary hide, use the
  // soft-delete `DELETE /teams/:id` route above.
  router.delete("/teams/:id/dismantle", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    await assertCompanyAccess(db, req, existing.companyId);
    await assertHumanRole(db, req, existing.companyId, "team_lead");
    await assertDepartmentAccess(db, req, existing.companyId, existing.parentProjectId);
    const result = await svc.dismantle(id);
    const actor = getActorInfo(req);
    await safeLogActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "team.dismantled",
      entityType: "team",
      entityId: id,
      details: { name: existing.name, slug: existing.slug },
    });
    res.json(result);
  });

  // GET /teams/:id/members
  router.get("/teams/:id/members", async (req, res) => {
    const id = req.params.id as string;
    const team = await svc.getById(id);
    await assertCompanyAccess(db, req, team.companyId);
    const result = await svc.listMembers(id);
    res.json({ items: result });
  });

  // GET /teams/:id/members/:agentId
  router.get("/teams/:id/members/:agentId", async (req, res) => {
    const id = req.params.id as string;
    const agentId = req.params.agentId as string;
    const team = await svc.getById(id);
    await assertCompanyAccess(db, req, team.companyId);
    const member = await svc.getMember(id, agentId);
    res.json(member);
  });

  // POST /teams/:id/members
  router.post(
    "/teams/:id/members",
    validate(addTeamsMemberSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const team = await svc.getById(id);
      await assertCompanyAccess(db, req, team.companyId);
      await assertHumanRole(db, req, team.companyId, "team_lead");
      await assertDepartmentAccess(db, req, team.companyId, team.parentProjectId);
      const result = await svc.addMember(id, req.body.agentId, req.body.role);
      const actor = getActorInfo(req);
      await safeLogActivity(db, {
        companyId: team.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "team.member_added",
        entityType: "team",
        entityId: id,
        details: { agentId: req.body.agentId, role: req.body.role },
      });
      res.status(201).json(result);
    },
  );

  // DELETE /teams/:id/members/:agentId
  router.delete("/teams/:id/members/:agentId", async (req, res) => {
    const id = req.params.id as string;
    const agentId = req.params.agentId as string;
    const team = await svc.getById(id);
    await assertCompanyAccess(db, req, team.companyId);
    await assertHumanRole(db, req, team.companyId, "team_lead");
    await assertDepartmentAccess(db, req, team.companyId, team.parentProjectId);
    await svc.removeMember(id, agentId);
    const actor = getActorInfo(req);
    await safeLogActivity(db, {
      companyId: team.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "team.member_removed",
      entityType: "team",
      entityId: id,
      details: { agentId },
    });
    res.status(204).end();
  });

  // PATCH /teams/:id/members/:agentId  (change role)
  router.patch(
    "/teams/:id/members/:agentId",
    validate(updateTeamsMemberRoleSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const agentId = req.params.agentId as string;
      const team = await svc.getById(id);
      await assertCompanyAccess(db, req, team.companyId);
      await assertHumanRole(db, req, team.companyId, "team_lead");
      await assertDepartmentAccess(db, req, team.companyId, team.parentProjectId);
      const result = await svc.updateMemberRole(id, agentId, req.body.role);
      const actor = getActorInfo(req);
      await safeLogActivity(db, {
        companyId: team.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "team.member_role_changed",
        entityType: "team",
        entityId: id,
        details: { agentId, role: req.body.role },
      });
      res.json(result);
    },
  );

  // GET /teams/:id/coordination
  router.get("/teams/:id/coordination", async (req, res) => {
    const id = req.params.id as string;
    const team = await svc.getById(id);
    await assertCompanyAccess(db, req, team.companyId);
    const result = await coordSvc.getByTeam(id);
    res.json(result);
  });

  // PUT /teams/:id/coordination
  router.put(
    "/teams/:id/coordination",
    validate(upsertCoordinationSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const team = await svc.getById(id);
      await assertCompanyAccess(db, req, team.companyId);
      await assertHumanRole(db, req, team.companyId, "team_lead");
      await assertDepartmentAccess(db, req, team.companyId, team.parentProjectId);
      const result = await coordSvc.upsert(team.companyId, {
        teamId: id,
        ...req.body,
      });
      const actor = getActorInfo(req);
      await safeLogActivity(db, {
        companyId: team.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "team.coordination_updated",
        entityType: "team",
        entityId: id,
      });
      res.json(result);
    },
  );

  // POST /teams/:id/coordination/regenerate
  //
  // If no coordination row exists yet for the team, scaffold the full
  // initial markdown via `teamScaffolderService.scaffoldInitial` and
  // create the row via `coordSvc.upsert`.
  // If a coordination row already exists, regenerate just the auto:*
  // section contents and apply via `coordSvc.regenerateAutoSections`.
  router.post("/teams/:id/coordination/regenerate", async (req, res) => {
    const id = req.params.id as string;
    const team = await svc.getById(id);
    await assertCompanyAccess(db, req, team.companyId);
    await assertHumanRole(db, req, team.companyId, "team_lead");
    await assertDepartmentAccess(db, req, team.companyId, team.parentProjectId);

    const existing = await coordSvc.getByTeam(id);
    const actor = getActorInfo(req);

    if (!existing) {
      const initial = await scaffolder.scaffoldInitial(id);
      const created = await coordSvc.upsert(team.companyId, {
        teamId: id,
        name: `${team.name} Coordination`,
        markdown: initial,
      });
      await safeLogActivity(db, {
        companyId: team.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "team.coordination_scaffolded",
        entityType: "team",
        entityId: id,
      });
      res.json(created);
      return;
    }

    const sections = await scaffolder.regenerateAutoContent(id);
    const updated = await coordSvc.regenerateAutoSections(existing.id, sections);
    await safeLogActivity(db, {
      companyId: team.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "team.coordination_regenerated",
      entityType: "team",
      entityId: id,
    });
    res.json(updated);
  });

  return router;
}
