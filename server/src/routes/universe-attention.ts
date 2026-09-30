import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import type { UserRole } from "@armyofagents/shared";
import { unauthorized } from "../errors.js";
import { permissionService } from "../services/permissions.js";
import { universeAttentionProjectionService } from "../services/universe-attention-projection.js";
import { UniverseAttentionCheckpointConflictError, universeAttentionCheckpointService } from "../services/universe-attention-checkpoint.js";
import { universeAttentionCheckpointInputSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function boardUser(req: Request): string {
  // rbac: paired-via-helper
  assertBoard(req);
  if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Board authentication required");
  return req.actor.userId;
}

function implicitFounder(req: Request): boolean {
  return req.actor.type === "board" && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true);
}

export function universeAttentionRoutes(
  db: Db,
  options: {
    projection?: Pick<ReturnType<typeof universeAttentionProjectionService>, "get">;
    checkpoints?: Pick<ReturnType<typeof universeAttentionCheckpointService>, "get" | "issueToken" | "acknowledge">;
  } = {},
) {
  const router = Router();
  const projection = options.projection ?? universeAttentionProjectionService(db);
  const checkpoints = options.checkpoints ?? universeAttentionCheckpointService(db);
  const permissions = permissionService(db);

  router.get("/companies/:companyId/universe/attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const actorUserId = boardUser(req);
    const role: UserRole = implicitFounder(req)
      ? "founder"
      : await permissions.getEffectiveRole(companyId, actorUserId);
    res.setHeader("cache-control", "no-store");
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const result = await projection.get({ companyId, actorUserId, role, cursor });
    const checkpoint = await checkpoints.get(companyId, actorUserId);
    res.json({ ...result, checkpoint, checkpointToken: checkpoints.issueToken(companyId, actorUserId, result.asOf) });
  });

  router.post("/companies/:companyId/universe/attention/checkpoint", validate(universeAttentionCheckpointInputSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const actorUserId = boardUser(req);
    try { res.json(await checkpoints.acknowledge(companyId, actorUserId, req.body)); }
    catch (cause) {
      if (cause instanceof UniverseAttentionCheckpointConflictError)
        return res.status(409).json({ error: cause.message, latest: cause.latest });
      throw cause;
    }
  });

  return router;
}
