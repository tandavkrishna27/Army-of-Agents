import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import {
  ONBOARDING_JOURNEYS,
  ONBOARDING_STATES,
  FIRST_RUN_PERSONAS,
  type OnboardingJourney,
  type OnboardingState,
  type FirstRunPersona,
} from "@armyofagents/shared";
import { getProgress, advanceState, setFirstRunProgress } from "../services/onboarding.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/index.js";

/**
 * Progress routes (Stage B / B4 + revB RB4/R3). userId is ALWAYS the actor
 * (never the body) — a user can only read/write their own progress. For a
 * company-scoped row, the board actor must have standard company access
 * (active membership, instance-admin access, or local-implicit access).
 */
export function onboardingRoutes(db: Db): Router {
  const router = Router();

  router.get("/onboarding/progress", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const raw = req.query.companyId;
    const companyId = typeof raw === "string" && raw.length > 0 ? raw : null;
    if (companyId) await assertCompanyAccess(db, req, companyId);
    const progress = await getProgress(db, actor.userId, companyId);
    res.json({ progress });
  });

  router.patch("/onboarding/progress", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const body = (req.body ?? {}) as { companyId?: string | null; journey?: string; requestedState?: string };
    const journey = body.journey as OnboardingJourney;
    const requestedState = body.requestedState as OnboardingState;
    if (!ONBOARDING_JOURNEYS.includes(journey)) {
      res.status(400).json({ error: "invalid journey" });
      return;
    }
    if (!ONBOARDING_STATES.includes(requestedState)) {
      res.status(400).json({ error: "invalid state" });
      return;
    }
    const companyId = typeof body.companyId === "string" && body.companyId.length > 0 ? body.companyId : null;
    if (companyId) await assertCompanyAccess(db, req, companyId);
    const result = await advanceState(db, { userId: actor.userId, companyId, journey, requestedState });
    if (result.status === "illegal") {
      res.status(409).json({ error: "illegal transition", reason: result.reason });
      return;
    }
    if (result.status === "conflict") {
      res.status(409).json({ error: "version conflict, retry" });
      return;
    }
    res.json({ progress: result.row });
  });

  /**
   * WS0b — persona/completion write. Extends the advance-route family rather
   * than adding a standalone endpoint. `userId` is ALWAYS the board actor
   * (never the body), so this can only ever touch the caller's own
   * `(userId, companyId)` row — there is no way to target another user's
   * progress from the request. Company-scoped only (the first-run flag is
   * meaningless on the user-layer row), so companyId is required here (unlike
   * GET/PATCH progress above, which allow a null user-layer companyId).
   */
  router.patch("/onboarding/first-run", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const body = (req.body ?? {}) as {
      companyId?: string;
      firstRunPersona?: string | null;
      completed?: boolean;
    };
    const companyId = typeof body.companyId === "string" && body.companyId.length > 0 ? body.companyId : null;
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    await assertCompanyAccess(db, req, companyId);

    let persona: FirstRunPersona | undefined;
    if (body.firstRunPersona !== undefined && body.firstRunPersona !== null) {
      if (!(FIRST_RUN_PERSONAS as readonly string[]).includes(body.firstRunPersona)) {
        res.status(400).json({ error: "invalid firstRunPersona" });
        return;
      }
      persona = body.firstRunPersona as FirstRunPersona;
    }
    const completed = body.completed === true;
    if (persona === undefined && !completed) {
      res.status(400).json({ error: "nothing to update — supply firstRunPersona and/or completed:true" });
      return;
    }

    const result = await setFirstRunProgress(db, {
      userId: actor.userId,
      companyId,
      persona,
      completed,
    });

    if (result.status === "not_found") {
      res.status(404).json({ error: "onboarding progress not found" });
      return;
    }
    if (result.status === "conflict") {
      res.status(409).json({ error: "version conflict, retry" });
      return;
    }

    const actorInfo = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actorInfo.actorType,
      actorId: actorInfo.actorId,
      agentId: actorInfo.agentId,
      runId: actorInfo.runId,
      action: "onboarding.first_run_updated",
      entityType: "onboarding_progress",
      entityId: result.row.id,
      details: {
        firstRunPersona: result.row.firstRunPersona ?? null,
        firstRunCompleted: result.row.firstRunCompletedAt != null,
      },
    });

    res.json({ progress: result.row });
  });

  return router;
}
