// Execution-target registry CRUD + worker self-register/heartbeat (Phase 5,
// Task 13). Router-factory `({ db })` pattern — see
// server/src/routes/environments.ts:29 (environmentRoutes) — db is injected,
// no global getDb(). executionTargets table comes from @armyofagents/db.
import { Router, type Request, type Response, type NextFunction } from "express";
import type { Db } from "@armyofagents/db";
import { executionTargets } from "@armyofagents/db";
import {
  createExecutionTargetSchema,
  workerExecutionTargetHeartbeatSchema,
  type CreateExecutionTargetInput,
  type WorkerExecutionTargetHeartbeatInput,
} from "@armyofagents/shared";
import {
  createWorkerToken,
  hashWorkerToken,
  listExecutionTargets,
  registerWorkerHeartbeat,
  revokeExecutionTargetWorkerToken,
  resolveWorkerTargetId,
  rotateExecutionTargetWorkerToken,
  stripWorkerSecret,
} from "../services/execution-targets.js";
import { organizationAccessService } from "../services/organization-access.js";
import { assertBoard } from "./authz.js";
import { conflict, forbidden, notFound, unauthorized } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { isUniqueViolation } from "../services/db-errors.js";
import { z } from "zod";

const uuidParam = z.string().uuid();

/**
 * Worker self-auth (Finding #3). The bearer credential is a rotatable worker
 * token minted at registration; only its SHA-256 hash is stored on the target
 * row. We hash the presented token and resolve it to exactly one target id.
 * The row id itself is NO LONGER a credential.
 */
function requireWorkerToken(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.header("authorization") ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      const token = match?.[1]?.trim();
      if (!token) {
        next(unauthorized());
        return;
      }
      const targetId = await resolveWorkerTargetId(db, token);
      if (!targetId) {
        next(unauthorized());
        return;
      }
      (req as Request & { workerTargetId?: string }).workerTargetId = targetId;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function executionTargetRoutes(opts: { db: Db }) {
  const router = Router();
  const orgAccess = organizationAccessService(opts.db);

  // Shared by both routes below. The orgAccess.canOrg check inside this same
  // helper (not the caller) is the real gate — assertBoard is just the
  // actor-type guard.
  async function assertOrgAdmin(req: Request, orgId: string): Promise<void> {
    // rbac: paired-via-helper — orgAccess.canOrg below is the gate.
    assertBoard(req);
    const userId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
    if (!userId) throw forbidden("Sign in to manage execution targets");
    const allowed = await orgAccess.canOrg(orgId, userId, "execution_target:manage");
    if (!allowed) throw forbidden("You are not an owner/admin of this organization");
  }

  // Owner registers a dedicated target (semi-manual: paste slug + endpoint).
  // RBAC: caller must be founder/org-admin of :orgId.
  router.post("/organizations/:orgId/execution-targets", validate(createExecutionTargetSchema), async (req, res, next) => {
    try {
      const orgId = uuidParam.parse(req.params.orgId);
      await assertOrgAdmin(req, orgId);
      const input = req.body as CreateExecutionTargetInput;
      // Mint a rotatable worker credential: persist only its hash, return the
      // plaintext ONCE. The row id is no longer a credential (Finding #3).
      const workerToken = createWorkerToken();
      const [row] = await opts.db
        .insert(executionTargets)
        .values({ organizationId: orgId, ...input, workerTokenHash: hashWorkerToken(workerToken) })
        .returning();
      // Audit trail: registering an execution destination is security-sensitive
      // and must be visible to incident review. activity_log is company-scoped
      // (company_id NOT NULL) and has no organization column, so this org-scoped
      // mutation cannot be a row there; emit a structured log line instead (same
      // pattern as the operator break-glass org-wide audit fix). A durable
      // org-scoped audit feed is tracked for the M6 org-scoped audit feed.
      const operatorUserId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
      logger.info(
        {
          action: "execution_target.register",
          organizationId: orgId,
          executionTargetId: row!.id,
          operatorUserId,
          scope: "org_scoped",
        },
        "execution target registered",
      );
      res.status(201).json({ ...stripWorkerSecret(row!), workerToken });
    } catch (err) {
      if (isUniqueViolation(err, "execution_targets_org_slug_uq")) {
        next(conflict("An execution target with this slug already exists in the organization."));
        return;
      }
      next(err);
    }
  });

  router.get("/organizations/:orgId/execution-targets", async (req, res, next) => {
    try {
      const orgId = uuidParam.parse(req.params.orgId);
      await assertOrgAdmin(req, orgId);
      res.json(await listExecutionTargets(opts.db, orgId));
    } catch (err) {
      next(err);
    }
  });

  router.post("/organizations/:orgId/execution-targets/:targetId/rotate-token", async (req, res, next) => {
    try {
      const orgId = uuidParam.parse(req.params.orgId);
      const targetId = uuidParam.parse(req.params.targetId);
      await assertOrgAdmin(req, orgId);
      const rotated = await rotateExecutionTargetWorkerToken(opts.db, {
        organizationId: orgId,
        targetId,
      });
      if (!rotated) throw notFound("Execution target not found");

      const operatorUserId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
      logger.info(
        {
          action: "execution_target.worker_token.rotated",
          organizationId: orgId,
          executionTargetId: targetId,
          operatorUserId,
          scope: "org_scoped",
        },
        "execution target worker token rotated",
      );
      res.json({ ...rotated.target, workerToken: rotated.workerToken });
    } catch (err) {
      next(err);
    }
  });

  router.post("/organizations/:orgId/execution-targets/:targetId/revoke", async (req, res, next) => {
    try {
      const orgId = uuidParam.parse(req.params.orgId);
      const targetId = uuidParam.parse(req.params.targetId);
      await assertOrgAdmin(req, orgId);
      const target = await revokeExecutionTargetWorkerToken(opts.db, {
        organizationId: orgId,
        targetId,
      });
      if (!target) throw notFound("Execution target not found");

      const operatorUserId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
      logger.info(
        {
          action: "execution_target.worker_token.revoked",
          organizationId: orgId,
          executionTargetId: targetId,
          operatorUserId,
          scope: "org_scoped",
        },
        "execution target worker token revoked",
      );
      res.json(target);
    } catch (err) {
      next(err);
    }
  });

  // Worker self-heartbeat: the worker token is bound to ONE target id. The
  // middleware resolves req.workerTargetId; the URL carries NO slug/org so a
  // caller can never address another tenant's row. Fail closed with 404 when
  // the id no longer exists.
  router.post(
    "/execution-targets/heartbeat",
    requireWorkerToken(opts.db),
    validate(workerExecutionTargetHeartbeatSchema),
    async (req, res, next) => {
    try {
      const targetId = (req as Request & { workerTargetId?: string }).workerTargetId!;
      const input = req.body as WorkerExecutionTargetHeartbeatInput;
      const { updated } = await registerWorkerHeartbeat(opts.db, {
        targetId,
        status: input.status,
        capabilities: input.capabilities,
      });
      if (updated === 0) {
        res.status(404).json({ error: "execution target not found" });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
    },
  );

  return router;
}
