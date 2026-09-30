import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import {
  agentProviderCredentialBindings,
  agents,
  providerCredentials,
} from "@armyofagents/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { assertRole } from "../middleware/rbac.js";
import { assertCompanyAccess } from "./authz.js";
import { logActivity } from "../services/activity-log.js";
import { removeScopedSubscriptionCredentialHome } from "../services/provider-credentials.js";
import { HttpError, unprocessable } from "../errors.js";

export function providerCredentialRoutes(db: Db): Router {
  const router = Router();

  router.get("/companies/:companyId/provider-credentials", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    await assertRole(db, req, companyId, "founder");
    const rows = await db
      .select({
        id: providerCredentials.id,
        provider: providerCredentials.provider,
        ownerUserId: providerCredentials.ownerUserId,
        executionTargetId: providerCredentials.executionTargetId,
        kind: providerCredentials.kind,
        state: providerCredentials.state,
        verifiedAt: providerCredentials.verifiedAt,
        revokedAt: providerCredentials.revokedAt,
        suspendedAt: providerCredentials.suspendedAt,
      })
      .from(providerCredentials)
      .where(eq(providerCredentials.companyId, companyId));
    res.json(rows);
  });

  router.get(
    "/companies/:companyId/agents/:agentId/provider-credential-bindings",
    async (req: Request, res: Response) => {
      const actor = req.actor;
      if (actor.type !== "board" || !actor.userId) {
        res.status(401).json({ error: "authentication required" });
        return;
      }
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertRole(db, req, companyId, "founder");

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .limit(1);
      if (!agent) {
        throw new HttpError(404, "Agent not found", { code: "agent_not_found" });
      }

      const rows = await db
        .select({
          id: agentProviderCredentialBindings.id,
          credentialId: agentProviderCredentialBindings.credentialId,
          provider: providerCredentials.provider,
          ownerUserId: providerCredentials.ownerUserId,
          executionTargetId: providerCredentials.executionTargetId,
          credentialState: providerCredentials.state,
          approvedByUserId: agentProviderCredentialBindings.approvedByUserId,
          approvedAt: agentProviderCredentialBindings.approvedAt,
          revokedAt: agentProviderCredentialBindings.revokedAt,
        })
        .from(agentProviderCredentialBindings)
        .innerJoin(
          providerCredentials,
          eq(agentProviderCredentialBindings.credentialId, providerCredentials.id),
        )
        .where(
          and(
            eq(agentProviderCredentialBindings.companyId, companyId),
            eq(agentProviderCredentialBindings.agentId, agentId),
            eq(providerCredentials.companyId, companyId),
          ),
        );
      res.json(rows);
    },
  );

  router.post(
    "/companies/:companyId/agents/:agentId/provider-credential-binding",
    async (req: Request, res: Response) => {
      const actor = req.actor;
      if (actor.type !== "board" || !actor.userId) {
        res.status(401).json({ error: "authentication required" });
        return;
      }
      const actorUserId = actor.userId;
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      const credentialId =
        typeof req.body?.credentialId === "string" ? req.body.credentialId.trim() : "";
      if (!credentialId) {
        res.status(400).json({ error: "credentialId is required" });
        return;
      }
      await assertCompanyAccess(db, req, companyId);
      await assertRole(db, req, companyId, "founder");

      const bindingId = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const [agent] = await txDb
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
          .limit(1);
        const [credential] = await txDb
          .select({
            id: providerCredentials.id,
            provider: providerCredentials.provider,
            state: providerCredentials.state,
          })
          .from(providerCredentials)
          .where(
            and(
              eq(providerCredentials.id, credentialId),
              eq(providerCredentials.companyId, companyId),
            ),
          )
          .limit(1);
        if (!agent || !credential) {
          throw new HttpError(404, "Agent or credential not found", {
            code: "agent_or_credential_not_found",
          });
        }
        if (credential.state !== "verified") {
          throw unprocessable("Only verified credentials can be bound", {
            code: "credential_not_verified",
          });
        }

        // Serialize replacement for one agent/provider. Without this lock two
        // concurrent approvals can both observe no active binding, insert
        // different credentials, and leave execution fail-closed as ambiguous.
        await txDb.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`provider-binding:${companyId}:${agentId}:${credential.provider}`}))`,
        );
        const existing = await txDb
          .select({
            id: agentProviderCredentialBindings.id,
            credentialId: providerCredentials.id,
          })
          .from(agentProviderCredentialBindings)
          .innerJoin(
            providerCredentials,
            eq(agentProviderCredentialBindings.credentialId, providerCredentials.id),
          )
          .where(
            and(
              eq(agentProviderCredentialBindings.companyId, companyId),
              eq(agentProviderCredentialBindings.agentId, agentId),
              eq(providerCredentials.provider, credential.provider),
              isNull(agentProviderCredentialBindings.revokedAt),
            ),
          );
        const now = new Date();
        for (const row of existing) {
          if (row.credentialId === credentialId) continue;
          await txDb
            .update(agentProviderCredentialBindings)
            .set({ revokedAt: now, updatedAt: now })
            .where(eq(agentProviderCredentialBindings.id, row.id));
        }
        const [binding] = await txDb
          .insert(agentProviderCredentialBindings)
          .values({
            companyId,
            agentId,
            credentialId,
            approvedByUserId: actorUserId,
            approvedAt: now,
            revokedAt: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              agentProviderCredentialBindings.agentId,
              agentProviderCredentialBindings.credentialId,
            ],
            set: {
              approvedByUserId: actorUserId,
              approvedAt: now,
              revokedAt: null,
              updatedAt: now,
            },
          })
          .returning({ id: agentProviderCredentialBindings.id });
        if (!binding) throw new Error("Credential binding was not created");
        await logActivity(txDb, {
          companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "provider_credential.binding.approved",
          entityType: "agent_provider_credential_binding",
          entityId: binding.id,
          agentId,
          details: { credentialId, provider: credential.provider },
        });
        return binding.id;
      });
      res.status(201).json({ id: bindingId });
    },
  );

  router.delete(
    "/companies/:companyId/agents/:agentId/provider-credential-binding/:bindingId",
    async (req: Request, res: Response) => {
      const actor = req.actor;
      if (actor.type !== "board" || !actor.userId) {
        res.status(401).json({ error: "authentication required" });
        return;
      }
      const actorUserId = actor.userId;
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      const bindingId = req.params.bindingId as string;
      await assertCompanyAccess(db, req, companyId);
      await assertRole(db, req, companyId, "founder");
      const revoked = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const now = new Date();
        const [row] = await txDb
          .update(agentProviderCredentialBindings)
          .set({ revokedAt: now, updatedAt: now })
          .where(
            and(
              eq(agentProviderCredentialBindings.id, bindingId),
              eq(agentProviderCredentialBindings.companyId, companyId),
              eq(agentProviderCredentialBindings.agentId, agentId),
              isNull(agentProviderCredentialBindings.revokedAt),
            ),
          )
          .returning({ id: agentProviderCredentialBindings.id });
        if (!row) return null;
        await logActivity(txDb, {
          companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "provider_credential.binding.revoked",
          entityType: "agent_provider_credential_binding",
          entityId: bindingId,
          agentId,
        });
        return row;
      });
      if (!revoked) {
        res.status(404).json({ error: "Credential binding not found" });
        return;
      }
      res.status(204).end();
    },
  );

  router.delete(
    "/companies/:companyId/provider-credentials/:credentialId",
    async (req: Request, res: Response) => {
      const actor = req.actor;
      if (actor.type !== "board" || !actor.userId) {
        res.status(401).json({ error: "authentication required" });
        return;
      }
      const actorUserId = actor.userId;
      const companyId = req.params.companyId as string;
      const credentialId = req.params.credentialId as string;
      const confirmation =
        typeof req.body?.confirmation === "string" ? req.body.confirmation.trim() : "";
      if (confirmation !== credentialId) {
        res.status(400).json({ error: "confirmation must exactly match credentialId" });
        return;
      }
      await assertCompanyAccess(db, req, companyId);
      await assertRole(db, req, companyId, "founder");

      const [credential] = await db
        .select({
          id: providerCredentials.id,
          provider: providerCredentials.provider,
          ownerUserId: providerCredentials.ownerUserId,
          executionTargetId: providerCredentials.executionTargetId,
          kind: providerCredentials.kind,
        })
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.id, credentialId),
            eq(providerCredentials.companyId, companyId),
          ),
        )
        .limit(1);
      if (!credential) {
        res.status(404).json({ error: "Provider credential not found" });
        return;
      }
      if (
        credential.kind !== "personal_subscription" ||
        (credential.provider !== "openai" && credential.provider !== "anthropic")
      ) {
        res.status(422).json({ error: "Only CLI subscription credentials can be revoked here" });
        return;
      }
      const localTargetId = process.env.AOA_EXECUTION_TARGET_ID?.trim() || "control-plane";
      if (credential.executionTargetId !== localTargetId) {
        res.status(409).json({
          error: "Credential is owned by another execution target",
          code: "credential_target_mismatch",
        });
        return;
      }

      const now = new Date();
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await txDb
          .update(providerCredentials)
          .set({ state: "revoked", revokedAt: now, updatedAt: now })
          .where(
            and(
              eq(providerCredentials.id, credentialId),
              eq(providerCredentials.companyId, companyId),
            ),
          );
        await txDb
          .update(agentProviderCredentialBindings)
          .set({ revokedAt: now, updatedAt: now })
          .where(
            and(
              eq(agentProviderCredentialBindings.companyId, companyId),
              eq(agentProviderCredentialBindings.credentialId, credentialId),
              isNull(agentProviderCredentialBindings.revokedAt),
            ),
          );
        await logActivity(txDb, {
          companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "provider_credential.revoked",
          entityType: "provider_credential",
          entityId: credentialId,
          details: { provider: credential.provider, executionTargetId: credential.executionTargetId },
        });
      });

      const filesRemoved = await removeScopedSubscriptionCredentialHome({
        companyId,
        userId: credential.ownerUserId,
        provider: credential.provider,
        executionTargetId: credential.executionTargetId,
      });
      res.json({ id: credentialId, state: "revoked", filesRemoved });
    },
  );

  return router;
}
