import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agentApiKeys, agents, boardApiKeys, companies, companyMemberships, heartbeatRuns, instanceUserRoles, mcpApiKeys, organizationMemberships } from "@armyofagents/db";
import { verifyLocalAgentJwt, verifyCommanderRunJwt } from "../agent-auth-jwt.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import type { DeploymentMode } from "@armyofagents/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { hasActiveCloudMembership } from "../services/upgrade-socket-authorization.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Build a board user's allowed-company set.
 *
 * In cloud_auth (tenant isolation enforced) this INTERSECTS active company
 * membership with active ORG ownership: a company is included only when the user
 * holds an active `company_memberships` row AND is an active member of that
 * company's owning organization. This gives `req.actor.companyIds` parity with
 * `assertCompanyAccess` (routes/authz.ts), which requires BOTH memberships — so
 * every `companyIds` reader (GET /companies, /companies/stats, …) enforces the
 * full tenant invariant, not the company-membership half. Closing it here means
 * an org-membership revocation (or an imperfect org backfill) can no longer leak
 * company metadata/stats the per-company detail endpoint already 403s.
 *
 * Empty active-org set → fail-closed to `[]` (short-circuit; never call
 * `inArray(col, [])`, which is an easy footgun to get backwards).
 *
 * Self-hosted (local_trusted / authenticated) keeps the pre-existing
 * company-membership-only derivation UNCHANGED — no org intersection.
 */
async function resolveActorCompanyIds(
  db: Db,
  userId: string,
  membershipCompanyIds: string[],
  activeOrganizationIds: string[],
): Promise<string[]> {
  if (!tenantIsolationEnforced()) {
    // Self-hosted: byte-for-byte the legacy set (company membership only).
    return membershipCompanyIds;
  }
  if (activeOrganizationIds.length === 0) return [];
  const rows = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
    .where(
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
        inArray(companies.organizationId, activeOrganizationIds),
      ),
    );
  return rows.map((row) => row.companyId);
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  /**
   * Dev/offline escape hatch. When true AND deploymentMode is local_trusted,
   * the default actor is the synthetic loopback admin (`local-board`). Ignored
   * (with a WARN) in any other mode — fail-closed. Sourced from
   * `config.devLocalIdentity` (env `AOA_DEV_LOCAL_IDENTITY`).
   */
  devLocalIdentity?: boolean;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  return async (req, _res, next) => {
    // RB4/A6: the synthetic loopback admin is NO LONGER the default. It is
    // produced only behind the dev escape hatch in local_trusted; otherwise the
    // real identity comes from the resolved Google/persisted session below.
    const useEscapeHatch =
      opts.deploymentMode === "local_trusted" && opts.devLocalIdentity === true;
    if (opts.deploymentMode !== "local_trusted" && opts.devLocalIdentity) {
      logger.warn(
        "AOA_DEV_LOCAL_IDENTITY is set but ignored outside local_trusted mode (fail-closed).",
      );
    }
    req.actor = useEscapeHatch
      ? { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" }
      : { type: "none", source: "none" };

    const runIdHeader = req.header("x-aoa-run-id") ?? req.header("x-paperclip-run-id");

    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      // Resolve the real Google/persisted session in BOTH modes (Google
      // identity everywhere) — run whenever a resolver is wired.
      if (opts.resolveSession) {
        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logger.warn(
            { err, method: req.method, url: req.originalUrl },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id) {
          const userId = session.user.id;
          const [roleRow, memberships, orgMemberships] = await Promise.all([
            db
              .select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
              .then((rows) => rows[0] ?? null),
            db
              .select({ companyId: companyMemberships.companyId })
              .from(companyMemberships)
              .where(
                and(
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.principalId, userId),
                  eq(companyMemberships.status, "active"),
                ),
              ),
            db
              .select({ organizationId: organizationMemberships.organizationId })
              .from(organizationMemberships)
              .where(
                and(
                  eq(organizationMemberships.userId, userId),
                  eq(organizationMemberships.status, "active"),
                ),
              ),
          ]);
          const isOperator = Boolean(roleRow);
          const cloud = opts.deploymentMode === "cloud_auth";
          const organizationIds = orgMemberships.map((row) => row.organizationId);
          // cloud_auth: intersect company membership with active-org ownership
          // (parity with assertCompanyAccess); self-hosted keeps the raw set.
          const companyIds = await resolveActorCompanyIds(
            db,
            userId,
            memberships.map((row) => row.companyId),
            organizationIds,
          );
          req.actor = {
            type: "board",
            userId,
            companyIds,
            organizationIds,
            // Operator-plane authority (instance settings). NOT clamped in cloud.
            operator: isOperator,
            // B1: the DATA-plane instance_admin bypass is clamped to false in
            // cloud_auth so every req.actor.isInstanceAdmin reader (rbac, authz,
            // canUser, team, route helpers) fails closed. Self-hosted
            // (local_trusted/authenticated) is preserved byte-for-byte. The
            // operator plane above stays live for instance-settings management.
            isInstanceAdmin: cloud ? false : isOperator,
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          next();
          return;
        }
      }
      // In local_trusted mode, resolve the agent identity from x-aoa-run-id
      // when no Bearer token is present. This is a fallback for environments where
      // the JWT secret is not configured — without it, agent subprocesses silently
      // fall through to the local-board actor and all comments appear as "You".
      if (runIdHeader && opts.deploymentMode === "local_trusted") {
        const run = await db
          .select({ agentId: heartbeatRuns.agentId, companyId: heartbeatRuns.companyId })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runIdHeader))
          .then((rows) => rows[0] ?? null);
        if (run) {
          req.actor = {
            type: "agent",
            agentId: run.agentId,
            companyId: run.companyId,
            runId: runIdHeader,
            source: "run_id_implicit",
          };
          next();
          return;
        }
      }

      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      next();
      return;
    }

    // Check board API keys first (CLI auth bearer tokens)
    const boardKeyRow = await db
      .select()
      .from(boardApiKeys)
      .where(and(eq(boardApiKeys.keyHash, hashToken(token)), isNull(boardApiKeys.revokedAt)))
      .then((rows) => rows.find((row) => !row.expiresAt || row.expiresAt.getTime() > Date.now()) ?? null);

    if (boardKeyRow) {
      const [roleRow, memberships, orgMemberships] = await Promise.all([
        db
          .select({ id: instanceUserRoles.id })
          .from(instanceUserRoles)
          .where(and(eq(instanceUserRoles.userId, boardKeyRow.userId), eq(instanceUserRoles.role, "instance_admin")))
          .then((rows) => rows[0] ?? null),
        db
          .select({ companyId: companyMemberships.companyId })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, boardKeyRow.userId),
              eq(companyMemberships.status, "active"),
            ),
          ),
        db
          .select({ organizationId: organizationMemberships.organizationId })
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.userId, boardKeyRow.userId),
              eq(organizationMemberships.status, "active"),
            ),
          ),
      ]);
      await db.update(boardApiKeys).set({ lastUsedAt: new Date() }).where(eq(boardApiKeys.id, boardKeyRow.id));
      const isOperator = Boolean(roleRow);
      const cloud = opts.deploymentMode === "cloud_auth";
      const organizationIds = orgMemberships.map((row) => row.organizationId);
      // cloud_auth: intersect company membership with active-org ownership
      // (parity with assertCompanyAccess); self-hosted keeps the raw set.
      const companyIds = await resolveActorCompanyIds(
        db,
        boardKeyRow.userId,
        memberships.map((row) => row.companyId),
        organizationIds,
      );
      req.actor = {
        type: "board",
        userId: boardKeyRow.userId,
        companyIds,
        organizationIds,
        // Operator-plane authority (instance settings). NOT clamped in cloud.
        operator: isOperator,
        // B1: DATA-plane instance_admin bypass clamped to false in cloud_auth
        // (same boundary as the session path above). Self-hosted preserved.
        isInstanceAdmin: cloud ? false : isOperator,
        keyId: boardKeyRow.id,
        runId: runIdHeader || undefined,
        source: "board_key",
      };
      next();
      return;
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    const mcpKey = key
      ? null
      : await db
          .select()
          .from(mcpApiKeys)
          .where(and(eq(mcpApiKeys.keyHash, tokenHash), isNull(mcpApiKeys.revokedAt)))
          .then((rows) => rows[0] ?? null);

    if (mcpKey) {
      const cloud = opts.deploymentMode === "cloud_auth";
      // MCP keys are delegated user credentials. Reject stale keys at the
      // authentication boundary, before bare-identifier parameter hooks or any
      // other pre-handler lookup can derive scope from the embedded company id.
      // Preserve lastUsedAt as token-presentation telemetry (it has always been
      // updated before resource authorization, including wrong-company use).
      await db
        .update(mcpApiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(mcpApiKeys.id, mcpKey.id));
      if (
        cloud &&
        (!mcpKey.userId ||
          !(await hasActiveCloudMembership(db, mcpKey.companyId, mcpKey.userId)))
      ) {
        next();
        return;
      }

      req.actor = {
        type: "mcp",
        userId: mcpKey.userId,
        companyId: mcpKey.companyId,
        companyIds: cloud ? [mcpKey.companyId] : undefined,
        keyId: mcpKey.id,
        runId: runIdHeader || undefined,
        source: "mcp_key",
      };
      next();
      return;
    }

    if (!key) {
      // Commander run-JWT (W7.5a / SC2): a per-turn, company-bound, user-scoped
      // token. It has NO agents row — verify it FIRST (the explicit `kind`
      // claim makes discrimination unambiguous) and set a commander actor with
      // NO agents-row lookup, so it never reaches the agent gate below at
      // :318-327 that would reject it for lacking an agents row.
      const commanderClaims = verifyCommanderRunJwt(token);
      if (commanderClaims) {
        req.actor = {
          type: "commander",
          source: "commander_jwt",
          companyId: commanderClaims.company_id,
          userId: commanderClaims.user_id,
          userRole: commanderClaims.user_role,
          conversationId: commanderClaims.conversation_id,
          turnId: commanderClaims.turn_id,
          // Keeps existing run-scoped audit/telemetry (getActorInfo) populated
          // without a separate field.
          runId: commanderClaims.turn_id,
        };
        next();
        return;
      }

      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        next();
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next();
        return;
      }

      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        next();
        return;
      }

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        runId: runIdHeader || claims.run_id || undefined,
        // DAT-007 item #1: the SIGNED run id, immune to the x-aoa-run-id header override
        // above. The distributed /mcp currency gate keys on this, never req.actor.runId.
        signedRunId: claims.run_id,
        source: "agent_jwt",
      };
      next();
      return;
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
      next();
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      runId: runIdHeader || undefined,
      source: "agent_key",
    };

    next();
  };
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
