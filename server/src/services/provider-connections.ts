// server/src/services/provider-connections.ts
import type { Db } from "@armyofagents/db";
import { providerConnections, providerAssignments } from "@armyofagents/db";
import { and, eq, ne } from "drizzle-orm";
import type { AuthMethod } from "@armyofagents/shared";
import type { CliAuthTopology } from "./cli-auth-topology.js";
import { conflict, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { removeScopedSubscriptionCredentialHome } from "./provider-credentials.js";

/**
 * Locked decision (2) — BOOT INVARIANT: personal_subscription connections cannot
 * be created OR verified in multi_tenant / cloud_auth. This gate MUST be called on
 * EVERY personal_subscription mint/verify path:
 *   - the connection create route (Task 10 create handler),
 *   - this service's verify() (below), and
 *   - the login-runtime mint (commander-login-runtime.ts:244 onCredentialEvidence)
 *     — add an assertSubscriptionAllowed call there when P4 lands so a hosted
 *     instance cannot even record a pending subscription credential.
 * It is ALSO the run-time backstop for the owner_only tautology (M2): because
 * personal_subscription cannot exist at all in multi_tenant, a shared host never
 * resolves one regardless of the owner_only gate. Mirrors
 * providerSubscriptionCapability (cli-auth-topology.ts:133).
 */
export function assertSubscriptionAllowed(authMethod: AuthMethod, topology: CliAuthTopology): void {
  if (authMethod === "personal_subscription" && topology.trustBoundary === "multi_tenant") {
    throw unprocessable(
      "Personal subscription connections are disabled on shared hosted installations. Use a business API key or enterprise gateway.",
      { code: "subscription_disabled_multi_tenant" },
    );
  }
}

export function providerConnectionService(db: Db, topology: CliAuthTopology) {
  return {
    /**
     * Mark a pending connection verified. `revoked` is terminal and `suspended`
     * requires a separate governed resume path; verify must never resurrect
     * either state. The conditional update closes verify/revoke TOCTOU races,
     * and the activity row commits in the same transaction as the transition.
     */
    async verify(companyId: string, connectionId: string, actorUserId: string) {
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const [conn] = await txDb
          .select()
          .from(providerConnections)
          .where(and(eq(providerConnections.id, connectionId), eq(providerConnections.companyId, companyId)))
          .limit(1);
        if (!conn) throw unprocessable("Connection not found", { code: "connection_not_found" });
        assertSubscriptionAllowed(conn.authMethod as AuthMethod, topology);
        if (!conn.termsAttestedAt) {
          throw unprocessable("Provider terms must be attested before verification", { code: "terms_not_attested" });
        }
        if (conn.state === "verified") return;
        if (conn.state !== "pending") {
          throw conflict(`Cannot verify a ${conn.state} provider connection.`);
        }

        const now = new Date();
        const transitioned = await txDb
          .update(providerConnections)
          .set({ state: "verified", verifiedAt: now, updatedAt: now })
          .where(and(
            eq(providerConnections.id, connectionId),
            eq(providerConnections.companyId, companyId),
            eq(providerConnections.state, "pending"),
          ))
          .returning({ id: providerConnections.id });
        if (transitioned.length === 0) {
          throw conflict("Provider connection changed while it was being verified.");
        }
        await logActivity(txDb, {
          companyId, actorType: "user", actorId: actorUserId,
          action: "provider_connection.verified", entityType: "provider_connection", entityId: connectionId,
          details: { provider: conn.provider, authMethod: conn.authMethod },
        });
      });
    },

    /** Rotation for shareable methods: secret_ref is stable; secretService.rotate
     *  appends a version (secrets.ts:691). Nothing here changes — documented no-op
     *  seam so callers rotate the underlying secret, not the connection row. */
    async touchAfterSecretRotation(connectionId: string) {
      await db
        .update(providerConnections)
        .set({ updatedAt: new Date() })
        .where(eq(providerConnections.id, connectionId));
    },

    /** Revoke: state=revoked, disable dependent assignments, wipe on-disk home for
     *  personal_subscription. Generalizes routes/provider-credentials.ts:324-362. */
    async revoke(companyId: string, connectionId: string, actorUserId: string) {
      const now = new Date();
      const conn = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const [existing] = await txDb
          .select()
          .from(providerConnections)
          .where(and(eq(providerConnections.id, connectionId), eq(providerConnections.companyId, companyId)))
          .limit(1);
        if (!existing) return null;

        // Idempotent revoke: audit only the call that wins the connection state
        // transition, but always repair dependent assignments. The latter is
        // load-bearing because the schema does not constrain assignment state
        // to connection state and older/in-flight writers may leave one active.
        const transitioned = existing.state === "revoked"
          ? []
          : await txDb
              .update(providerConnections)
              .set({ state: "revoked", revokedAt: now, updatedAt: now })
              .where(and(
                eq(providerConnections.id, connectionId),
                eq(providerConnections.companyId, companyId),
                ne(providerConnections.state, "revoked"),
              ))
              .returning();
        await txDb
          .update(providerAssignments)
          .set({ state: "disabled", updatedAt: now })
          .where(eq(providerAssignments.connectionId, connectionId));
        if (transitioned.length > 0) {
          await logActivity(txDb, {
            companyId, actorType: "user", actorId: actorUserId,
            action: "provider_connection.revoked", entityType: "provider_connection", entityId: connectionId,
            details: { provider: existing.provider, authMethod: existing.authMethod },
          });
        }
        return transitioned[0] ?? {
          ...existing,
          state: "revoked" as const,
          revokedAt: existing.revokedAt ?? now,
          updatedAt: now,
        };
      });
      if (!conn) return null;
      let filesRemoved = false;
      if (
        conn.authMethod === "personal_subscription" &&
        conn.ownerUserId &&
        conn.executionTargetId &&
        (conn.provider === "openai" || conn.provider === "anthropic")
      ) {
        filesRemoved = await removeScopedSubscriptionCredentialHome({
          companyId, userId: conn.ownerUserId, provider: conn.provider, executionTargetId: conn.executionTargetId,
        });
      }
      return { id: connectionId, state: "revoked", filesRemoved };
    },
  };
}
