import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { accessService, humanCapabilitiesService, humanContextService, humanDiscoveryService, logActivity, teamService } from "../services/index.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { resolveInviteBaseUrl } from "./access-helpers.js";
import {
  addMemberSchema,
  createHumanCapabilityDocumentSchema,
  reassignAndRemoveSchema,
  searchHumansSchema,
  transferAdminSchema,
  updateCompanyUserProfileSchema,
  updateHumanCapabilityDocumentSchema,
  updateTeamMemberRoleSchema,
} from "@armyofagents/shared";

export function teamRoutes(db: Db) {
  const router = Router();
  const team = teamService(db);
  const humanCapabilities = humanCapabilitiesService(db);
  const humanContext = humanContextService(db);
  const humanDiscovery = humanDiscoveryService(db);
  const access = accessService(db);

  async function assertCanEditHumanCapabilities(req: Request, companyId: string, userId: string) {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw forbidden("Board authentication required");
    }
    const actorUserId = req.actor.userId;
    if (actorUserId === userId) return actorUserId;
    const [actorRole, isSystemAdmin] = await Promise.all([
      team.getUserRole(companyId, actorUserId),
      team.isCompanySystemAdmin(companyId, actorUserId),
    ]);
    if (actorRole.role !== "founder" && !isSystemAdmin) {
      throw forbidden("Only founders or company system admins can edit another member's capabilities");
    }
    return actorUserId;
  }

  router.get("/companies/:companyId/team", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const summary = await team.listTeam(companyId, req.actor.type === "board" ? req.actor.userId ?? null : null);
    res.json(summary);
  });

  router.get("/companies/:companyId/team/humans/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const input = searchHumansSchema.parse(req.query);
    res.json(await humanDiscovery.search(companyId, input));
  });

  router.patch(
    "/companies/:companyId/team/users/:userId/role",
    validate(updateTeamMemberRoleSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = req.params.userId as string;
      await assertCompanyAccess(db, req, companyId);
      if (req.actor.type !== "board" || !req.actor.userId) {
        res.status(403).json({ error: "Board authentication required" });
        return;
      }
      await team.assertFounder(companyId, req.actor.userId);
      const updated = await team.updateUserRole(
        companyId,
        userId,
        {
          role: req.body.role,
          projectId: req.body.role === "founder" ? null : (req.body.projectId ?? null),
          parentType: req.body.parentType,
          parentId: req.body.parentId,
        },
        req.actor.userId,
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "team.role_updated",
        entityType: "user_role",
        entityId: userId,
        details: {
          role: updated.role,
          projectId: updated.projectId,
        },
      });

      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/team/users/:userId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    await team.assertFounder(companyId, req.actor.userId);
    await team.removeMember(companyId, userId);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "team.member_removed",
      entityType: "user_role",
      entityId: userId,
      details: {},
    });

    res.json({ ok: true });
  });

  router.patch(
    "/companies/:companyId/team/users/:userId/profile",
    validate(updateCompanyUserProfileSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = req.params.userId as string;
      await assertCompanyAccess(db, req, companyId);
      if (req.actor.type !== "board" || !req.actor.userId) {
        res.status(403).json({ error: "Board authentication required" });
        return;
      }

      const actorUserId = req.actor.userId;
      if (actorUserId !== userId) {
        const [actorRole, isSystemAdmin] = await Promise.all([
          team.getUserRole(companyId, actorUserId),
          team.isCompanySystemAdmin(companyId, actorUserId),
        ]);
        if (actorRole.role !== "founder" && !isSystemAdmin) {
          throw forbidden("Only founders or company system admins can edit another member's profile");
        }
      }

      const profile = await team.updateCompanyUserProfile(companyId, userId, req.body, actorUserId);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "team.profile_updated",
        entityType: "user_profile",
        entityId: userId,
        details: {
          fields: Object.keys(req.body),
        },
      });

      res.json({ profile });
    },
  );

  router.get("/companies/:companyId/team/users/:userId/agent-context", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const bundle = await humanContext.getBundle(companyId, userId, req.actor.userId ?? null);
    res.json({ bundle });
  });

  // POST /companies/:companyId/team/members — Direct add member
  router.get("/companies/:companyId/team/users/:userId/capabilities", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const actorUserId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    res.json(await humanCapabilities.listDocuments(companyId, userId, actorUserId));
  });

  router.post(
    "/companies/:companyId/team/users/:userId/capabilities",
    validate(createHumanCapabilityDocumentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = req.params.userId as string;
      await assertCompanyAccess(db, req, companyId);
      const actorUserId = await assertCanEditHumanCapabilities(req, companyId, userId);
      const document = await humanCapabilities.createDocument(companyId, userId, req.body, actorUserId);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "team.capability_document_created",
        entityType: "user_capability_document",
        entityId: document.id,
        details: {
          userId,
          filename: document.filename,
          title: document.title,
        },
      });

      res.json({ document });
    },
  );

  router.patch(
    "/companies/:companyId/team/users/:userId/capabilities/:documentId",
    validate(updateHumanCapabilityDocumentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = req.params.userId as string;
      const documentId = req.params.documentId as string;
      await assertCompanyAccess(db, req, companyId);
      const actorUserId = await assertCanEditHumanCapabilities(req, companyId, userId);
      const document = await humanCapabilities.updateDocument(companyId, userId, documentId, req.body, actorUserId);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "team.capability_document_updated",
        entityType: "user_capability_document",
        entityId: document.id,
        details: {
          userId,
          filename: document.filename,
          fields: Object.keys(req.body),
        },
      });

      res.json({ document });
    },
  );

  router.delete("/companies/:companyId/team/users/:userId/capabilities/:documentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    const documentId = req.params.documentId as string;
    await assertCompanyAccess(db, req, companyId);
    const actorUserId = await assertCanEditHumanCapabilities(req, companyId, userId);
    await humanCapabilities.deleteDocument(companyId, userId, documentId);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "team.capability_document_deleted",
      entityType: "user_capability_document",
      entityId: documentId,
      details: { userId },
    });

    res.json({ ok: true });
  });

  router.post(
    "/companies/:companyId/team/members",
    validate(addMemberSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      if (req.actor.type !== "board" || !req.actor.userId) {
        res.status(403).json({ error: "Board authentication required" });
        return;
      }
      const result = await team.addMember(companyId, req.body, req.actor.userId);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "team.member_added",
        entityType: "user_role",
        entityId: result.userId,
        details: { name: req.body.name, email: req.body.email, role: req.body.role },
      });

      res.json(result);
    },
  );

  // POST /companies/:companyId/team/transfer-admin — Transfer system admin
  router.post(
    "/companies/:companyId/team/transfer-admin",
    validate(transferAdminSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCompanyAccess(db, req, companyId);
      if (req.actor.type !== "board" || !req.actor.userId) {
        res.status(403).json({ error: "Board authentication required" });
        return;
      }
      await team.transferAdmin(companyId, req.actor.userId, req.body.toUserId);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "team.admin_transferred",
        entityType: "user_role",
        entityId: req.body.toUserId,
        details: { fromUserId: req.actor.userId, toUserId: req.body.toUserId },
      });

      res.json({ ok: true });
    },
  );

  // GET /companies/:companyId/team/users/:userId — Get member detail
  router.get("/companies/:companyId/team/users/:userId/workload", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    res.json(await team.getWorkload(companyId, userId));
  });

  router.get("/companies/:companyId/team/users/:userId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    await assertCompanyAccess(db, req, companyId);
    const summary = await team.listTeam(companyId, req.actor.type === "board" ? req.actor.userId ?? null : null);
    const member = summary.members.find((m) => m.userId === userId);
    if (!member) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    const deps = await team.getDependencies(companyId, userId);
    res.json({ member, dependencies: deps });
  });

  // GET /companies/:companyId/team/users/:userId/dependencies — Get member dependencies
  router.get("/companies/:companyId/team/users/:userId/dependencies", async (req, res) => {
    const companyId = req.params.companyId as string;
    const userId = req.params.userId as string;
    await assertCompanyAccess(db, req, companyId);
    const deps = await team.getDependencies(companyId, userId);
    res.json(deps);
  });

  // POST /companies/:companyId/team/users/:userId/reassign-and-remove
  router.post(
    "/companies/:companyId/team/users/:userId/reassign-and-remove",
    validate(reassignAndRemoveSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = req.params.userId as string;
      await assertCompanyAccess(db, req, companyId);
      if (req.actor.type !== "board" || !req.actor.userId) {
        res.status(403).json({ error: "Board authentication required" });
        return;
      }
      await team.assertFounder(companyId, req.actor.userId);
      await team.reassignAndRemove(companyId, userId, req.body);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "team.member_removed",
        entityType: "user_role",
        entityId: userId,
        details: {
          humanReassignments: req.body.humanReassignments.length,
          agentReassignments: req.body.agentReassignments.length,
        },
      });

      res.json({ ok: true });
    },
  );

  // PATCH /companies/:companyId/invites/:inviteId/revoke — Revoke invite
  router.patch("/companies/:companyId/invites/:inviteId/revoke", async (req, res) => {
    const companyId = req.params.companyId as string;
    const inviteId = req.params.inviteId as string;
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    await team.assertFounder(companyId, req.actor.userId);
    await access.revokeInvite(companyId, inviteId);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "team.invite_revoked",
      entityType: "invite",
      entityId: inviteId,
      details: {},
    });

    res.json({ ok: true });
  });

  // POST /companies/:companyId/invites/:inviteId/resend — Resend invite
  router.post("/companies/:companyId/invites/:inviteId/resend", async (req, res) => {
    const companyId = req.params.companyId as string;
    const inviteId = req.params.inviteId as string;
    await assertCompanyAccess(db, req, companyId);
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    await team.assertFounder(companyId, req.actor.userId);
    const result = await access.resendInvite(companyId, inviteId);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "team.invite_resent",
      entityType: "invite",
      entityId: result.invite.id,
      details: { oldInviteId: inviteId },
    });

    // Resend rotates the token — return the fresh link (absolute, so it can
    // be copied verbatim) plus the new expiry so the UI can surface both.
    // Build it from the trusted origin (configured public URL → trust-proxy-
    // gated / real Host), matching invite-create — never a spoofable
    // X-Forwarded-Host.
    const baseUrl = resolveInviteBaseUrl(req);
    const invitePath = `/invite/${result.token}`;
    res.json({
      inviteId: result.invite.id,
      token: result.token,
      inviteUrl: baseUrl ? `${baseUrl}${invitePath}` : invitePath,
      expiresAt: result.invite.expiresAt,
    });
  });

  router.use((err: unknown, _req: Request, _res: Response, next: NextFunction) => {
    logger.warn({ err }, "team route failed");
    next(err);
  });

  return router;
}
