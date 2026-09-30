import express, { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import { beginUniverseIntakeSchema } from "@armyofagents/shared";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import { badRequest, unauthorized } from "../errors.js";
import { universeIntakeService } from "../services/universe-intake.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function scope(req: Request) {
  // rbac: paired-via-helper
  assertBoard(req);
  if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Board authentication required");
  return { companyId: req.params.companyId as string, actorKey: req.actor.userId };
}

export function universeIntakeRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const service = universeIntakeService(db, storage);
  const base = "/companies/:companyId/universe/intakes";

  router.post(base, validate(beginUniverseIntakeSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const result = await service.begin(scope(req), req.body);
    res.status(result.created ? 201 : 200).json(result.snapshot);
  });
  router.get(`${base}/:intakeId`, async (req, res) => {
    await assertCompanyAccess(db, req, req.params.companyId as string);
    res.setHeader("cache-control", "no-store");
    res.json(await service.get(scope(req), req.params.intakeId as string));
  });
  router.put(
    `${base}/:intakeId/parts/:partIndex`,
    express.raw({ type: "application/octet-stream", limit: "4mb" }),
    async (req, res) => {
      await assertCompanyAccess(db, req, req.params.companyId as string);
      const hash = req.header("x-part-sha256");
      if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw badRequest("Valid x-part-sha256 header required");
      if (!Buffer.isBuffer(req.body)) throw badRequest("Binary part body required");
      res.json(await service.putPart(scope(req), req.params.intakeId as string, Number(req.params.partIndex), req.body, hash));
    },
  );
  router.post(`${base}/:intakeId/finalize`, async (req, res) => {
    await assertCompanyAccess(db, req, req.params.companyId as string);
    res.json(await service.finalize(scope(req), req.params.intakeId as string));
  });
  router.post(`${base}/:intakeId/cancel`, async (req, res) => {
    await assertCompanyAccess(db, req, req.params.companyId as string);
    res.json(await service.cancel(scope(req), req.params.intakeId as string));
  });
  return router;
}
