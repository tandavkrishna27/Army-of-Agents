import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import type { CockpitTaskBucket } from "@armyofagents/shared";
import { assertCompanyAccess, assertBoard } from "./authz.js";
import { badRequest, unauthorized } from "../errors.js";
import { cockpitService } from "../services/cockpit.js";
import { decodeCockpitTaskCursor } from "../services/cockpit-work.js";

const TASK_BUCKETS = new Set<CockpitTaskBucket>([
  "mine",
  "managed",
  "awaiting_review",
]);

async function requireBoardActor(db: Db, req: Request, companyId: string) {
  // Company access stays first so unauthenticated callers receive 401.
  await assertCompanyAccess(db, req, companyId);
  assertBoard(req);
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw unauthorized("Board authentication required");
  }
  return {
    actorId: req.actor.userId,
    source: req.actor.source,
    isInstanceAdmin: req.actor.isInstanceAdmin,
  };
}

export function cockpitRoutes(db: Db) {
  const router = Router();
  const svc = cockpitService(db);

  router.get("/companies/:companyId/cockpit", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = await requireBoardActor(db, req, companyId);
    res.json(await svc.get(companyId, actor));
  });

  router.get("/companies/:companyId/cockpit/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = await requireBoardActor(db, req, companyId);
    const rawBucket = req.query.bucket;
    if (typeof rawBucket !== "string" || !TASK_BUCKETS.has(rawBucket as CockpitTaskBucket)) {
      throw badRequest("bucket must be mine, managed, or awaiting_review");
    }

    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw badRequest("limit must be an integer between 1 and 100");
    }

    const rawCursor = req.query.cursor;
    if (rawCursor !== undefined && typeof rawCursor !== "string") {
      throw badRequest("cursor must be a string");
    }
    if (rawCursor && !decodeCockpitTaskCursor(rawCursor)) {
      throw badRequest("cursor is invalid");
    }

    res.json(await svc.listTasks(
      companyId,
      actor,
      rawBucket as CockpitTaskBucket,
      { limit, cursor: rawCursor || undefined },
    ));
  });

  router.get("/companies/:companyId/cockpit/counts", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = await requireBoardActor(db, req, companyId);
    res.json(await svc.getCounts(companyId, actor));
  });

  return router;
}
