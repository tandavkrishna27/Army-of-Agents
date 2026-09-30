import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { createOrganizationSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";
import { forbidden } from "../errors.js";
import { organizationAccessService } from "../services/organization-access.js";
import { createSelfServeOrganization } from "../services/organizations.js";
import { logger } from "../middleware/logger.js";

export function organizationRoutes(db: Db): Router {
  const router = Router();
  const orgAccess = organizationAccessService(db);

  // Self-serve org creation: any signed-in board user may create an org and
  // becomes its owner. NO instance_admin gate — this is the multi-tenant thesis.
  // rbac: instance-admin-not-required — org-level endpoint with no companyId in path; there is no existing company/org scope to check against (the org is being CREATED by this call), so "authenticated board user" is the entire authorization surface by design.
  router.post("/", validate(createOrganizationSchema), async (req, res) => {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Sign in to create an organization");
    const result = await createSelfServeOrganization(
      db,
      {
        name: req.body.name,
        ownerUserId: req.actor.userId,
        creationRequestId: req.body.creationRequestId,
      },
      organizationAccessService,
    );
    const org = result.organization;
    // Audit: self-serve org creation is a security-sensitive tenant mutation.
    // organizations is org-scoped (no company_id), so record via a structured
    // pino line (mirrors the exec-target register + operator break-glass audits).
    // Durable org-scoped audit is the tracked M6 follow-up.
    if (result.created) {
      logger.info(
        { action: "organization.create", organizationId: org.id, ownerUserId: req.actor.userId, scope: "org_scoped" },
        "self-serve organization created",
      );
    }
    res.status(201).json(org);
  });

  // Caller's own org memberships (for the Lobby org switcher).
  // rbac: instance-admin-not-required — no companyId in path; result is scope-filtered inline against req.actor.userId (listOrgMemberships), mirroring companies.ts:67's list-endpoint idiom.
  router.get("/", async (req, res) => {
    assertBoard(req);
    if (!req.actor.userId) {
      res.json([]);
      return;
    }
    res.json(await orgAccess.listOrgMemberships(req.actor.userId));
  });

  return router;
}
