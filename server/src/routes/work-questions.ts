import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import {
  WORK_QUESTION_STATUSES,
  answerWorkQuestionSchema,
  mutateWorkQuestionVersionSchema,
  reassignWorkQuestionSchema,
} from "@armyofagents/shared";
import { z } from "zod";
import { unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { workQuestionService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

const listWorkQuestionsSchema = z.object({
  status: z.enum(WORK_QUESTION_STATUSES).optional(),
  issueId: z.string().uuid().optional(),
  sourceDiscussionId: z.string().uuid().optional(),
  executionWorkspaceId: z.string().uuid().optional(),
  sourceCommanderConversationId: z.string().uuid().optional(),
  scope: z.enum(["mine", "all"]).optional().default("mine"),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

function boardActor(req: Request) {
  if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Board authentication required");
  return {
    userId: req.actor.userId,
    instanceAdmin: req.actor.isInstanceAdmin === true || req.actor.source === "local_implicit",
  };
}

export function workQuestionRoutes(db: Db) {
  const router = Router();
  const questions = workQuestionService(db);

  router.get("/companies/:companyId/work-questions", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const actor = boardActor(req);
    const query = listWorkQuestionsSchema.parse(req.query);
    const hasSourceFilter = Boolean(
      query.issueId
      || query.sourceDiscussionId
      || query.executionWorkspaceId
      || query.sourceCommanderConversationId,
    );
    const result = await questions.listForUser(companyId, actor, {
      status: query.status,
      issueId: query.issueId,
      sourceDiscussionId: query.sourceDiscussionId,
      executionWorkspaceId: query.executionWorkspaceId,
      sourceCommanderConversationId: query.sourceCommanderConversationId,
      currentRecipientUserId: query.scope === "mine" && !hasSourceFilter ? actor.userId : undefined,
      limit: query.limit,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/work-questions/inline", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const actor = boardActor(req);
    const query = listWorkQuestionsSchema.parse(req.query);
    const hasSourceFilter = Boolean(
      query.issueId
      || query.sourceDiscussionId
      || query.executionWorkspaceId
      || query.sourceCommanderConversationId,
    );
    const result = await questions.listDetailsForUser(companyId, actor, {
      status: query.status,
      issueId: query.issueId,
      sourceDiscussionId: query.sourceDiscussionId,
      executionWorkspaceId: query.executionWorkspaceId,
      sourceCommanderConversationId: query.sourceCommanderConversationId,
      currentRecipientUserId: query.scope === "mine" && !hasSourceFilter ? actor.userId : undefined,
      limit: query.limit,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/work-questions/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    res.json(await questions.getDetailForUser(companyId, req.params.id as string, boardActor(req)));
  });

  router.post(
    "/companies/:companyId/work-questions/:id/answer",
    validate(answerWorkQuestionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const questionId = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = boardActor(req);
      const result = await questions.answer(companyId, questionId, actor, req.body);
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/work-questions/:id/reassign",
    validate(reassignWorkQuestionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const questionId = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = boardActor(req);
      const result = await questions.reassign(
        companyId,
        questionId,
        actor,
        req.body.userId,
        req.body.expectedVersion,
      );
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/work-questions/:id/take-over",
    validate(mutateWorkQuestionVersionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const questionId = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = boardActor(req);
      const result = await questions.takeOver(companyId, questionId, actor, req.body.expectedVersion);
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/work-questions/:id/retry-continuation",
    validate(mutateWorkQuestionVersionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const questionId = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = boardActor(req);
      const result = await questions.retryContinuation(companyId, questionId, actor, req.body.expectedVersion);
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/work-questions/:id/cancel",
    validate(mutateWorkQuestionVersionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const questionId = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);
      const actor = boardActor(req);
      const result = await questions.cancelByUser(companyId, questionId, actor, req.body.expectedVersion);
      res.json(result);
    },
  );

  return router;
}
