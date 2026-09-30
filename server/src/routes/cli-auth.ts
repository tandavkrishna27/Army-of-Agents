import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import {
  createCliAuthChallengeSchema,
  resolveCliAuthChallengeSchema,
} from "@armyofagents/shared";
import { badRequest, forbidden, notFound, unauthorized } from "../errors.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { validate } from "../middleware/validate.js";
import { cliAuthChallengeLimiter } from "../middleware/rate-limit.js";
import { boardAuthService } from "../services/index.js";
import { resolveInviteBaseUrl } from "./access-helpers.js";
import { canManageInstanceSettings } from "./authz.js";

function buildCliAuthApprovalPath(challengeId: string, token: string) {
  return `/cli-auth/${challengeId}?token=${encodeURIComponent(token)}`;
}

function isLocalImplicit(req: Request) {
  return req.actor.type === "board" && req.actor.source === "local_implicit";
}

function interactiveCliApprover(req: Request): {
  userId: string;
  canManageInstanceSettings: boolean;
  companyIds: string[];
} | null {
  if (req.actor.type !== "board") return null;
  if (req.actor.source !== "session" && !isLocalImplicit(req)) return null;
  const userId =
    req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null);
  if (!userId) return null;
  return {
    userId,
    canManageInstanceSettings: canManageInstanceSettings(req),
    companyIds: req.actor.companyIds ?? [],
  };
}

export function cliAuthRoutes(db: Db) {
  const router = Router();
  const boardAuth = boardAuthService(db);

  // Sprint 4 S4-F: this endpoint is unauthenticated (the CLI has no token
  // yet) and creates 10-minute-TTL rows in cli_auth_challenges. Without a
  // per-IP cap, any script can flood the table. Limiter is 5/min/IP.
  router.post(
    "/cli-auth/challenges",
    cliAuthChallengeLimiter,
    validate(createCliAuthChallengeSchema),
    async (req, res) => {
      const created = await boardAuth.createCliAuthChallenge(req.body);
      const approvalPath = buildCliAuthApprovalPath(
        created.challenge.id,
        created.challengeSecret
      );
      // The approval URL carries an auth token, so build it from a TRUSTED
      // origin — the configured public URL first, then a trust-proxy-gated /
      // real-Host fallback (same derivation as invite links). NEVER a spoofable
      // X-Forwarded-Host: host-header injection here would point the
      // token-bearing link at an attacker origin. `resolveInviteBaseUrl`
      // returns "" only when there is genuinely no configured origin AND no
      // Host header, in which case we cannot mint an absolute URL (a CLI can't
      // resolve a relative one) and fall back to `null`, matching the prior
      // "no host" behaviour.
      const baseUrl = resolveInviteBaseUrl(req);
      res.status(201).json({
        id: created.challenge.id,
        token: created.challengeSecret,
        boardApiToken: created.pendingBoardToken,
        approvalPath,
        approvalUrl: baseUrl ? `${baseUrl}${approvalPath}` : null,
        pollPath: `/cli-auth/challenges/${created.challenge.id}`,
        expiresAt: created.challenge.expiresAt.toISOString(),
        suggestedPollIntervalMs: 1000,
      });
    }
  );

  router.get("/cli-auth/challenges/:id", async (req, res) => {
    const id = (req.params.id as string).trim();
    const token =
      typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!id || !token) throw notFound("CLI auth challenge not found");
    const challenge = await boardAuth.describeCliAuthChallenge(id, token);
    if (!challenge) throw notFound("CLI auth challenge not found");

    const approver = interactiveCliApprover(req);
    const isSignedInBoardUser = approver !== null;
    const canApprove =
      approver !== null &&
      (challenge.requestedAccess !== "instance_admin_required" ||
        approver.canManageInstanceSettings) &&
      (!tenantIsolationEnforced() ||
        !challenge.requestedCompanyId ||
        approver.companyIds.includes(challenge.requestedCompanyId));

    res.json({
      ...challenge,
      requiresSignIn: !isSignedInBoardUser,
      canApprove,
      currentUserId:
        req.actor.type === "board" ? req.actor.userId ?? null : null,
    });
  });

  router.post(
    "/cli-auth/challenges/:id/approve",
    validate(resolveCliAuthChallengeSchema),
    async (req, res) => {
      const id = (req.params.id as string).trim();
      const approver = interactiveCliApprover(req);
      if (!approver) {
        throw unauthorized("Sign in before approving CLI access");
      }

      const userId = approver.userId;
      let cloudActivityCompanyIds: string[] | undefined;
      if (tenantIsolationEnforced()) {
        const challenge = await boardAuth.describeCliAuthChallenge(
          id,
          req.body.token
        );
        if (!challenge) throw notFound("CLI auth challenge not found");
        if (
          challenge.requestedCompanyId &&
          !approver.companyIds.includes(challenge.requestedCompanyId)
        ) {
          throw forbidden(
            "Company access required to approve this CLI challenge"
          );
        }
        cloudActivityCompanyIds = challenge.requestedCompanyId
          ? [challenge.requestedCompanyId]
          : approver.companyIds;
      }

      const approved = await boardAuth.approveCliAuthChallenge(
        id,
        req.body.token,
        userId,
        tenantIsolationEnforced()
          ? {
              canManageInstanceSettings: approver.canManageInstanceSettings,
              activityCompanyIds: cloudActivityCompanyIds ?? [],
            }
          : { canManageInstanceSettings: approver.canManageInstanceSettings }
      );

      res.json({
        approved: approved.status === "approved",
        status: approved.status,
        userId,
        keyId: approved.challenge.boardApiKeyId ?? null,
        expiresAt: approved.challenge.expiresAt.toISOString(),
      });
    }
  );

  router.post(
    "/cli-auth/challenges/:id/cancel",
    validate(resolveCliAuthChallengeSchema),
    async (req, res) => {
      const id = (req.params.id as string).trim();
      const cancelled = await boardAuth.cancelCliAuthChallenge(
        id,
        req.body.token
      );
      res.json({
        status: cancelled.status,
        cancelled: cancelled.status === "cancelled",
      });
    }
  );

  router.get("/cli-auth/me", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const accessSnapshot = await boardAuth.resolveBoardAccess(req.actor.userId);
    const cloudTenantSnapshot = tenantIsolationEnforced();
    res.json({
      user: accessSnapshot.user,
      userId: req.actor.userId,
      isInstanceAdmin: cloudTenantSnapshot
        ? Boolean(req.actor.isInstanceAdmin)
        : accessSnapshot.isInstanceAdmin,
      companyIds: cloudTenantSnapshot
        ? req.actor.companyIds ?? []
        : accessSnapshot.companyIds,
      source: req.actor.source ?? "none",
      keyId: req.actor.source === "board_key" ? req.actor.keyId ?? null : null,
    });
  });

  router.post("/cli-auth/revoke-current", async (req, res) => {
    if (req.actor.type !== "board" || req.actor.source !== "board_key") {
      throw unauthorized("Board API key authentication required");
    }
    const key = await boardAuth.revokeCurrentBoardApiKey({
      keyId: req.actor.keyId ?? "",
      userId: req.actor.userId ?? "",
      ...(tenantIsolationEnforced()
        ? { activityCompanyIds: req.actor.companyIds ?? [] }
        : {}),
    });
    res.json({ revoked: true, keyId: key.id });
  });

  return router;
}
