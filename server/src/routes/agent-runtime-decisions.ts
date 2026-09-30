import { Router, type Request } from "express";
import type { Db } from "@armyofagents/db";
import { runtimeDecisionAnswerSchema } from "@armyofagents/shared";
import { validate } from "../middleware/validate.js";
import { agentRuntimeDecisionService, hubItemsService, permissionService } from "../services/index.js";
import {
  runtimeDecisionDetail,
  type AgentRuntimeTrustRuleRow,
} from "../services/agent-runtime-decisions.js";
import { assertCompanyAccess } from "./authz.js";
import { forbidden, notFound, unauthorized } from "../errors.js";

function requireBoardUserId(req: Request): string {
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw unauthorized("Board authentication required");
  }
  return req.actor.userId;
}

function hasImplicitFounderAuthority(req: Request): boolean {
  return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function runtimeTrustRuleSummary(rule: AgentRuntimeTrustRuleRow) {
  return {
    id: rule.id,
    agentId: rule.agentId,
    runId: rule.runId,
    grantScope: rule.grantScope,
    adapterType: rule.adapterType,
    toolName: rule.toolName,
    commandHashPrefix: rule.commandHash?.slice(0, 8) ?? null,
    pathScope: rule.pathScope,
    networkScope: rule.networkScope,
    riskClass: rule.riskClass,
    enabled: rule.enabled,
    expiresAt: toIso(rule.expiresAt),
    lastUsedAt: toIso(rule.lastUsedAt),
    createdAt: toIso(rule.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(rule.updatedAt) ?? new Date(0).toISOString(),
  };
}

export function agentRuntimeDecisionRoutes(db: Db) {
  const router = Router();
  const runtimeDecisions = agentRuntimeDecisionService(db);
  const hubItems = hubItemsService(db);
  const perms = permissionService(db);

  async function requireFounderAuthority(req: Request, companyId: string, userId: string) {
    if (hasImplicitFounderAuthority(req)) return;
    if (await perms.isFounder(companyId, userId)) return;
    throw forbidden("Runtime decisions require founder authority");
  }

  async function assertFounderOrVisibleRuntimeDecision(req: Request, companyId: string, decisionId: string, userId: string) {
    if (hasImplicitFounderAuthority(req)) return;
    if (await perms.isFounder(companyId, userId)) return;
    const role = await perms.getEffectiveRole(companyId, userId);
    const item = await hubItems.getVisibleBySource(companyId, {
      sourceType: "runtime_decision",
      sourceId: decisionId,
      actorUserId: userId,
      role,
      status: "any",
    });
    if (!item) throw notFound("Runtime decision prompt not found");
  }

  router.get("/companies/:companyId/agent-runtime-decisions/trust-rules", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    await requireFounderAuthority(req, companyId, userId);

    const rules = await runtimeDecisions.listTrustRules({
      companyId,
      includeDisabled: false,
    });
    res.json({ rules: rules.map(runtimeTrustRuleSummary) });
  });

  router.delete("/companies/:companyId/agent-runtime-decisions/trust-rules/:ruleId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ruleId = req.params.ruleId as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    await requireFounderAuthority(req, companyId, userId);

    await runtimeDecisions.revokeTrustRule({
      companyId,
      ruleId,
      actorUserId: userId,
    });
    res.json({ success: true });
  });

  router.get("/companies/:companyId/agent-runtime-decisions/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const decisionId = req.params.id as string;
    await assertCompanyAccess(db, req, companyId);
    const userId = requireBoardUserId(req);
    await assertFounderOrVisibleRuntimeDecision(req, companyId, decisionId, userId);

    const detail = await runtimeDecisions.getDetail(companyId, decisionId);
    res.json(detail);
  });

  router.post(
    "/companies/:companyId/agent-runtime-decisions/:id/answer",
    validate(runtimeDecisionAnswerSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const decisionId = req.params.id as string;
      await assertCompanyAccess(db, req, companyId);
      const userId = requireBoardUserId(req);
      await requireFounderAuthority(req, companyId, userId);

      const answered = await runtimeDecisions.answerPrompt({
        companyId,
        decisionId,
        actorUserId: userId,
        ...req.body,
      });
      res.json(runtimeDecisionDetail(answered));
    },
  );

  return router;
}
