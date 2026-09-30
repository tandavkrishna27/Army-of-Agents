import { Router, type Request } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@armyofagents/db";
import {
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  updateCompanySchema,
  DEFAULT_ORGANIZATION_ID,
  type DeploymentMode,
} from "@armyofagents/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertRole } from "../middleware/rbac.js";
import { accessService, companyPortabilityService, companyService, logActivity } from "../services/index.js";
import { insertActivityLog, publishActivityLogged } from "../services/activity-log.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { invalidateCompanyTenant } from "./authz-tenant.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { seedAoaNativeSkills } from "../services/internal-agent/aoa-skills-seeder.js";
import { ensureCommanderAgent } from "../services/internal-agent/aoa-agents/ensure-commander.js";
import {
  ensureCompanyProfileFromGlobal,
  materializeCompanyProfileFromGlobal,
} from "../services/team.js";
import { backfillIdentityMemory } from "../services/identity-backfill.js";
import { logger } from "../middleware/logger.js";
import { organizationAccessService } from "../services/organization-access.js";
import type { OrgCapability } from "../services/organization-access.js";

/**
 * Anti-tenant-hop: the Organization used to AUTHORIZE the create is the SAME
 * Organization written to the company row. An explicit `body.organizationId`
 * always wins (it is then authorized via canOrg against that exact id).
 *
 * When the client omits organizationId:
 *   - self-hosted (isolation NOT enforced): fall back to P1's
 *     DEFAULT_ORGANIZATION_ID (single-tenant sentinel), as before.
 *   - cloud_auth (isolation enforced) — P3 last-writer, resolves the P2
 *     follow-up: "create another company" must land in the founder's OWN org,
 *     not the shared sentinel. Derive from the actor's org membership when it is
 *     unambiguous (exactly one org). Zero orgs -> nothing to create under;
 *     more than one -> require an explicit organizationId.
 */
export function resolveCompanyOrganizationId(
  body: { organizationId?: string | null },
  opts?: { enforced?: boolean; actorOrganizationIds?: string[] },
): string {
  if (body.organizationId) return body.organizationId;
  if (opts?.enforced) {
    const orgs = opts.actorOrganizationIds ?? [];
    if (orgs.length === 1) return orgs[0] as string;
    throw forbidden(
      orgs.length === 0
        ? "You are not a member of any organization"
        : "organizationId is required: you belong to multiple organizations",
    );
  }
  return DEFAULT_ORGANIZATION_ID;
}

/**
 * Throws unless the caller is an owner/admin of the EXACT organizationId
 * that will be written to the new company row (see resolveCompanyOrganizationId
 * above) — the caller can never authorize for one org and create under another.
 */
export async function assertCompanyCreateAuthorized(
  orgAccess: { canOrg: (organizationId: string, userId: string, cap: OrgCapability) => Promise<boolean> },
  organizationId: string,
  userId: string,
): Promise<void> {
  const ok = await orgAccess.canOrg(organizationId, userId, "company:create");
  if (!ok) throw forbidden("You are not an owner/admin of this organization");
}

/**
 * Shared create-authorization for company-minting routes (`POST /` and the
 * `new_company` branch of `POST /import`). Resolves the server-side owning org
 * and authorizes the actor against that exact org, mirroring `POST /` exactly:
 *
 *   - The self-hosted operator bypass is gated on the STATIC deployment mode
 *     (fail-closed): in cloud_auth isInstanceAdmin is already clamped false, but
 *     the static gate guarantees no future path re-opens the bypass in cloud.
 *   - `resolveCompanyOrganizationId` derives the org (explicit input org, else
 *     the actor's single org, else 403) — server-derived, never a raw client
 *     "target". Self-hosted (!enforced) resolves the DEFAULT sentinel.
 *   - Non-operators must be signed in (`unauthMessage`) and pass canOrg.
 *
 * Returns the resolved organizationId (a concrete string in every path — the
 * DEFAULT sentinel for the self-hosted-operator case).
 */
async function resolveAndAuthorizeCompanyCreate(
  db: Db,
  req: Request,
  input: { organizationId?: string | null },
  opts?: { unauthMessage?: string },
): Promise<string> {
  const enforced = tenantIsolationEnforced();
  const isSelfHostedOperator =
    !enforced && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin);
  const organizationId = resolveCompanyOrganizationId(input, {
    enforced,
    actorOrganizationIds: req.actor.organizationIds ?? [],
  }); // server-derived; never a raw client "target"
  if (!isSelfHostedOperator) {
    if (!req.actor.userId) throw forbidden(opts?.unauthMessage ?? "Sign in to create a company");
    await assertCompanyCreateAuthorized(organizationAccessService(db), organizationId, req.actor.userId);
  }
  return organizationId;
}

export function companyRoutes(db: Db, opts: { deploymentMode: DeploymentMode }) {
  const router = Router();
  const svc = companyService(db);
  const portability = companyPortabilityService(db);
  const access = accessService(db);

  async function assertCanAssignTasks(req: Request, companyId: string) {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
    if (!allowed) throw forbidden("Missing permission: tasks:assign");
  }

  router.get("/", async (req, res) => {
    // rbac: instance-admin-not-required — list endpoint with no companyId in path; result is scope-filtered in SQL against req.actor.companyIds.
    assertBoard(req);
    // The full-list bypass is a self-hosted-only affordance. In cloud_auth
    // (isolation enforced) the operator plane must NOT see every tenant's
    // companies. Fix 4: push the actor's allowed-company set into SQL rather
    // than scanning all companies and filtering in JS. isInstanceAdmin is
    // already clamped false in cloud (Task 4); the static gate is defense-in-depth.
    const legacyAdmin =
      !tenantIsolationEnforced() &&
      (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin);
    const result = legacyAdmin
      ? await svc.list("unscoped")
      : await svc.list(req.actor.companyIds ?? []);
    res.json(result);
  });

  router.get("/stats", async (req, res) => {
    // rbac: instance-admin-not-required — stats endpoint with no companyId in path; result is scope-filtered in SQL against req.actor.companyIds.
    assertBoard(req);
    // Self-hosted operator view: unscoped (unchanged). Everyone else: push the
    // actor's allowed-company set into the four aggregations rather than running
    // instance-wide GROUP BYs and filtering in JS (Fix 4).
    const legacyAdmin =
      !tenantIsolationEnforced() &&
      (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin);
    const stats = legacyAdmin
      ? await svc.stats("unscoped")
      : await svc.stats(req.actor.companyIds ?? []);
    res.json(stats);
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.post("/:companyId/export", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const result = await portability.exportBundle(companyId, req.body);
    res.json(result);
  });

  router.post("/:companyId/export/preview", validate(companyPortabilityExportSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const result = await portability.previewExport(companyId, req.body);
    res.json(result);
  });

  router.post("/import/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    if (req.body.target.mode === "existing_company") {
      await assertCompanyAccess(db, req, req.body.target.companyId);
    } else {
      assertBoard(req);
    }
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
    assertBoard(req);
    const existingCompanyId =
      req.body.target.mode === "existing_company" ? req.body.target.companyId : null;
    if (req.body.target.mode === "existing_company") {
      await assertCompanyAccess(db, req, req.body.target.companyId);
      // D2 (privilege-escalation hardening): an existing-company import is a
      // whole-company mutation spanning EVERY section — company settings (incl.
      // requireBoardApprovalForNewAgents), skills (agents execute skills →
      // behaviour injection), internal_agent_config, budget_policies, projects,
      // issues, routines, financials, etc. Membership (assertCompanyAccess) is NOT
      // enough: a plain team_member could silently overwrite company governance.
      // Gate the WHOLE existing-company import on founder/team_lead. This is
      // DELIBERATELY stricter than the membership-only PATCH /:companyId route —
      // do NOT reconcile it back down to match that route. PATCH mutates a few
      // named fields under their own per-field guards; import applies an entire
      // bundle at once, so the coarse role gate is the right altitude here.
      await assertRole(db, req, req.body.target.companyId, "founder", "team_lead");
    }

    // D2/H3: a new_company import creates a company and MUST be placed + authorized
    // exactly like POST / — never the shared DEFAULT sentinel under cloud_auth.
    // resolveAndAuthorizeCompanyCreate (shared with POST /) derives the server-side
    // org (explicit target.organizationId, else the actor's single org, else 403)
    // and gates canOrg against that exact org. The self-hosted operator bypass +
    // DEFAULT-sentinel fallback are preserved inside the helper.
    let newCompanyOrganizationId: string | undefined;
    if (req.body.target.mode === "new_company") {
      newCompanyOrganizationId = await resolveAndAuthorizeCompanyCreate(
        db,
        req,
        { organizationId: req.body.target.organizationId },
        { unauthMessage: "Sign in to import a company" },
      );
    }

    const actor = getActorInfo(req);
    const result = await portability.importBundle(
      req.body,
      req.actor.type === "board" ? req.actor.userId : null,
      existingCompanyId
        ? async ({
            requiresTaskAssignmentPermission,
            importsWorkflowTemplates,
            importsAgents,
            importsInternalAgentConfig,
            importsBudgetPolicies,
          }) => {
          // D2/H2: importing agents into an existing company is a company-structure
          // mutation — require founder/team_lead. The handler-level blanket gate
          // above already enforces founder/team_lead for the whole existing-company
          // import; these section gates are kept as defense-in-depth (and cover any
          // future call site that reaches importBundle without the route's gate).
          if (importsAgents) {
            await assertRole(db, req, existingCompanyId, "founder", "team_lead");
          }
          if (requiresTaskAssignmentPermission) {
            await assertCanAssignTasks(req, existingCompanyId);
          }
          if (importsWorkflowTemplates) {
            await assertRole(db, req, existingCompanyId, "founder", "team_lead");
          }
          // D2 (privilege-escalation hardening): the two founder-PLANE sections are
          // stricter still — FOUNDER only. internal_agent_config governs crew
          // autonomy / budget / capabilities; budget_policies governs hard-stop
          // enforcement. Neither is a team_lead concern (memory candidates stay
          // founder-gated elsewhere, D12).
          if (importsInternalAgentConfig || importsBudgetPolicies) {
            await assertRole(db, req, existingCompanyId, "founder");
          }
        }
        : undefined,
      { organizationId: newCompanyOrganizationId },
    );
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "company.imported",
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
      },
    });
    res.json(result);
  });

  router.post("/", validate(createCompanySchema), async (req, res) => {
    // Task 10 (Phase 2 lockout cluster, ATOMIC cutover): the isInstanceAdmin
    // gate is swapped for org-owner/admin authorization scoped to a
    // server-derived organizationId. Self-hosted local_trusted/authenticated
    // are UNCHANGED (local_implicit / isInstanceAdmin still bypass, exactly
    // as before) — this only OPENS a new path for cloud_auth org owners who
    // are not (and in cloud_auth, cannot be) instance_admin. P2 lockout-scoped
    // gate; P3 is last-writer — final authz moves to req.tenant.enforced
    // calling canOrg.
    // rbac: instance-admin-not-required — the isSelfHostedOperator/canOrg check below is the gate.
    assertBoard(req);
    // Shared with POST /import (new_company): resolve the server-derived owning
    // org + authorize the actor against it. Self-hosted operator bypass +
    // DEFAULT-sentinel fallback live inside the helper.
    const organizationId = await resolveAndAuthorizeCompanyCreate(db, req, req.body);
    // D6: local_trusted = single trust boundary (loopback); one-click approve is friction.
    // authenticated = real multi-human board; approval is multi-person accountability.
    const requireBoardApprovalForNewAgents = opts.deploymentMode !== "local_trusted";
    // requestedByUserId attributes the crew's marketplace install operation
    // (T2.3). The column is free text with no FK, and `local_trusted` actors
    // legitimately have no userId — hence the null fallback.
    //
    // P3 (mirrors Fix 5): the company row + founder membership/role/org
    // membership are written atomically inside ONE transaction, so a transient
    // fault can never commit an orphan company with no membership. `buildAccess`
    // is bound to the tx handle so ensureRealOperator's writes join it. Group A
    // (operator-independent seeders) runs best-effort post-commit inside
    // createWithOperator; Group B (operator-dependent, below) stays here and
    // reuses the returned operatorId.
    const { company, operatorId, created, committedActivity } = await svc.createWithOperator(
      { ...req.body, requireBoardApprovalForNewAgents, organizationId },
      { requestedByUserId: req.actor.userId ?? null },
      req.actor.userId,
      (tx) => accessService(tx),
      (tx, inserted) =>
        insertActivityLog(tx, {
          companyId: inserted.id,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "company.created",
          entityType: "company",
          entityId: inserted.id,
          details: { name: inserted.name },
        }),
    );
    // Seed the founder's company Human Operating Profile from their GLOBAL
    // profile. Onboarding's HumanProfileStep writes only the global
    // `user_profiles` row (companyId is null at that step); without this, the
    // founder's freshly-entered title/bio/timezone/socialLinks show blank on
    // their own company Team page. The invited-approve and manual-add paths
    // already materialize via the same helper — founder-create was the gap.
    // Best-effort — never block company creation. (Codex P2)
    const reconcileFounderProfile = created
      ? materializeCompanyProfileFromGlobal
      : ensureCompanyProfileFromGlobal;
    await reconcileFounderProfile(db, company.id, operatorId, operatorId).catch((err) => {
      logger.warn(
        { err, companyId: company.id, userId: operatorId },
        "company create: founder profile seeding failed (non-fatal)",
      );
    });
    await seedAoaNativeSkills(db, company.id).catch(() => {
      // Never block company creation on skill seeding failure
    });
    // QA-BUG-007 fix: re-run Commander provisioning AFTER native skills are
    // seeded so the Commander's skillKeys backfills from the now-populated
    // company_skills table. The first ensureCommanderAgent call inside
    // svc.create() runs BEFORE seedAoaNativeSkills, so installed.length is
    // 0 and the gate in ensure-commander.ts:170-200 skips writing. This
    // second call (combined with the relaxed gate in ensure-commander.ts
    // that allows re-run when skillKeys is empty AND installed > 0)
    // populates skillKeys with all seeded native skills. The function is
    // idempotent — second call only updates skillKeys and is otherwise
    // no-op against the agent row.
    await ensureCommanderAgent(db, company.id).catch(() => {
      // Never block company creation on Commander skill-init re-run failure
    });
    if (committedActivity) {
      try {
        publishActivityLogged(committedActivity);
      } catch (err) {
        logger.warn(
          { err, companyId: company.id },
          "company create: post-commit activity publish failed (non-fatal)",
        );
      }
    }
    res.status(201).json(company);
  });

  router.patch("/:companyId", validate(updateCompanySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    if (
      "agentCompletionPolicyDefault" in req.body ||
      "agentCompletionReviewGuardrail" in req.body ||
      "humanQuestionSlaHours" in req.body
    ) {
      await assertCanAssignTasks(req, companyId);
    }
    const company = await svc.update(companyId, req.body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    // P1-T9 — mirror edited vision/mission/values into layer='identity' memory
    // (the single home for company identity). Idempotent + best-effort; the
    // startup backfill is the safety net for any path that bypasses this route.
    if ("vision" in req.body || "mission" in req.body || "values" in req.body) {
      await backfillIdentityMemory(db, companyId).catch((err: unknown) =>
        logger.warn({ err, companyId }, "company identity memory mirror failed (non-fatal)"),
      );
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      details: req.body,
    });
    res.json(company);
  });

  // Founder-only toggle for the team-architecture feature flag (Slices 6 + 7).
  // Default is false; flipping to true opts the company into the teams system.
  //
  // P1: `assertBoard(req)` runs BEFORE `assertRole` because `assertRole` only
  // checks role assignments — it does not bypass agent actors. Without the
  // board guard an agent with API key + a founder role assignment could flip
  // this company-wide flag, but this toggle is documented as founder-only
  // (a founder is a human-board user). Board access is the trust boundary.
  router.patch(
    "/:companyId/enable-teams",
    validate(z.object({ enabled: z.boolean() })),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      await assertCompanyAccess(db, req, companyId);
      await assertRole(db, req, companyId, "founder");
      await db
        .update(companies)
        .set({ enableTeams: req.body.enabled, updatedAt: new Date() })
        .where(eq(companies.id, companyId));
      await logActivity(db, {
        ...getActorInfo(req),
        companyId,
        action: "company.teams_feature_toggled",
        entityType: "company",
        entityId: companyId,
        details: { enabled: req.body.enabled },
      });
      res.json({ ok: true });
    },
  );

  router.post("/:companyId/archive", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");
    const company = await svc.archive(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.archived",
      entityType: "company",
      entityId: companyId,
    });
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    // Drop the cached companyId -> organizationId mapping so a recycled id can
    // never resolve to the deleted company's tenant.
    invalidateCompanyTenant(companyId);
    res.json({ ok: true });
  });

  return router;
}
