import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import { draftDestinationSchema, universeDraftPatchSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { universeDraftsService } from "../services/universe-drafts.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { unauthorized, badRequest } from "../errors.js";

function requireBoardUserId(req: Request): string {
  // rbac: paired-via-helper — both handlers await assertCompanyAccess before parse calls this helper.
  assertBoard(req);
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw unauthorized("Board authentication required");
  }
  return req.actor.userId;
}

/**
 * Owner-scoped, destination-scoped Universe composer drafts. Company access-gated,
 * board-only. The scope's userId comes from the authenticated board actor,
 * conversationId + destination from the path; the body carries only the draft
 * text/attachments and the expectedRevision. A stale revision surfaces as 409 via
 * the global error handler.
 */
export function universeDraftsRoutes(db: Db) {
  const router = Router();
  const svc = universeDraftsService(db);
  const base =
    "/companies/:companyId/universe/conversations/:conversationId/drafts/:destinationKind/:destinationId";

  const parse = (req: Request) => {
    const scope = {
      companyId: req.params.companyId as string,
      conversationId: req.params.conversationId as string,
      userId: requireBoardUserId(req),
    };
    const destination = draftDestinationSchema.safeParse({
      kind: req.params.destinationKind,
      id: req.params.destinationId,
    });
    if (!destination.success) throw badRequest("Invalid draft destination");
    return { scope, destination: destination.data };
  };

  router.get(base, async (req, res) => {
    await assertCompanyAccess(db, req, req.params.companyId as string);
    const { scope, destination } = parse(req);
    await svc.assertDestinationAccess(scope, destination);
    res.json(await svc.get(scope, destination));
  });

  router.patch(base, validate(universeDraftPatchSchema), async (req, res) => {
    await assertCompanyAccess(db, req, req.params.companyId as string);
    const { scope, destination } = parse(req);
    await svc.assertDestinationAccess(scope, destination);
    res.json(await svc.patch(scope, destination, req.body));
  });

  return router;
}
