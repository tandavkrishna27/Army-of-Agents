import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { heartbeatRuns, hubAudit, hubAutopilotPolicies, hubItems } from "@armyofagents/db";
import {
  HUB_AUTOPILOT_ACTIONS,
  HUB_SEMANTIC_TYPES,
  hubAutopilotPolicySchema,
  isFounderGatedAutopilotType,
  type HubAutopilotAction,
  type HubAutopilotActionsResponse,
  type HubAutopilotEvaluationResult,
  type HubAutopilotMode,
  type HubAutopilotPolicy,
  type HubAutopilotRule,
  type HubItemStatus,
  type HubSemanticType,
  type UpdateHubAutopilotPolicyInput,
} from "@armyofagents/shared";
import { hubItemsService } from "./hub-items.js";
import { trustScoreService } from "./trust-scores.js";
import { HttpError } from "../errors.js";

type PolicyRow = {
  mode: string;
  rules: unknown;
  updatedAt: Date | string | null;
};

type TrustScoresApi = Pick<ReturnType<typeof trustScoreService>, "getScore">;
type HubItemsApi = Pick<ReturnType<typeof hubItemsService>, "recordLifecycleAction">;

interface HubAutopilotDeps {
  policyReader?: (companyId: string) => Promise<HubAutopilotPolicy>;
  trustScores?: TrustScoresApi;
  hubItems?: HubItemsApi;
  now?: () => Date;
}

export interface AutopilotEvaluationInput {
  companyId: string;
  hubItemId: string;
  semanticType: HubSemanticType;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceAgentId?: string | null;
  version: number;
}

export const DEFAULT_HUB_AUTOPILOT_POLICY: HubAutopilotPolicy = {
  mode: "off",
  handledToday: 0,
  lastHandledAt: null,
  rules: HUB_SEMANTIC_TYPES.map((semanticType) => ({
    semanticType,
    action: "none",
    minTrustScore: 100,
    enabled: false,
  })),
  updatedAt: null,
};

function cloneDefaultPolicy(): HubAutopilotPolicy {
  return {
    ...DEFAULT_HUB_AUTOPILOT_POLICY,
    rules: DEFAULT_HUB_AUTOPILOT_POLICY.rules.map((rule) => ({ ...rule })),
  };
}

function serializeDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function auditedPostActionVersion(priorState: unknown): number | null {
  if (priorState == null || typeof priorState !== "object") return null;
  const priorVersion = (priorState as { version?: unknown }).version;
  return typeof priorVersion === "number" && Number.isInteger(priorVersion) && priorVersion >= 0
    ? priorVersion + 1
    : null;
}

function isAutopilotMode(value: unknown): value is HubAutopilotMode {
  return value === "off" || value === "assist" || value === "drive";
}

function toPolicy(row: PolicyRow | null, stats: Pick<HubAutopilotPolicy, "handledToday" | "lastHandledAt">): HubAutopilotPolicy {
  if (!row) {
    return { ...cloneDefaultPolicy(), ...stats };
  }

  const parsed = hubAutopilotPolicySchema.safeParse({
    mode: isAutopilotMode(row.mode) ? row.mode : "off",
    handledToday: stats.handledToday,
    lastHandledAt: stats.lastHandledAt,
    rules: Array.isArray(row.rules) ? row.rules : cloneDefaultPolicy().rules,
    updatedAt: serializeDate(row.updatedAt),
  });
  return parsed.success ? normalizePolicy(parsed.data) : { ...cloneDefaultPolicy(), ...stats };
}

function normalizePolicy(policy: HubAutopilotPolicy): HubAutopilotPolicy {
  const byType = new Map<HubSemanticType, HubAutopilotRule>();
  for (const rule of cloneDefaultPolicy().rules) byType.set(rule.semanticType, rule);
  for (const rule of policy.rules) byType.set(rule.semanticType, { ...rule });
  return {
    ...policy,
    rules: HUB_SEMANTIC_TYPES.map((semanticType) => byType.get(semanticType)!),
  };
}

function mergeRules(existing: HubAutopilotRule[], patchRules: HubAutopilotRule[] | undefined): HubAutopilotRule[] {
  if (!patchRules) return existing.map((rule) => ({ ...rule }));
  const merged = new Map(existing.map((rule) => [rule.semanticType, { ...rule }]));
  for (const rule of patchRules) merged.set(rule.semanticType, { ...rule });
  return HUB_SEMANTIC_TYPES.map((semanticType) => merged.get(semanticType) ?? cloneDefaultPolicy().rules.find((rule) => rule.semanticType === semanticType)!);
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function noActionResult(reason: string, autonomyLevel: HubAutopilotMode, decision: "noop" | "escalate" = "noop"): HubAutopilotEvaluationResult {
  return {
    decision,
    action: "none",
    reason,
    autonomyLevel,
  };
}

function isSafeAction(action: HubAutopilotAction): action is "resolve" | "archive" {
  return action === "resolve" || action === "archive";
}

export function hubAutopilotService(db: Db, deps: HubAutopilotDeps = {}) {
  const policyReader = deps.policyReader;
  const trustScores = deps.trustScores ?? trustScoreService(db);
  const hub = deps.hubItems ?? hubItemsService(db);
  const now = deps.now ?? (() => new Date());

  async function autonomyStats(companyId: string): Promise<Pick<HubAutopilotPolicy, "handledToday" | "lastHandledAt">> {
    const start = utcDayStart(now());
    const todayRows = await db
      .select({ id: hubAudit.id })
      .from(hubAudit)
      .where(
        and(
          eq(hubAudit.companyId, companyId),
          eq(hubAudit.actorType, "autonomy"),
          inArray(hubAudit.action, ["resolve", "archive"]),
          gte(hubAudit.createdAt, start),
        ),
      );
    const latest = await db
      .select({ createdAt: hubAudit.createdAt })
      .from(hubAudit)
      .where(
        and(
          eq(hubAudit.companyId, companyId),
          eq(hubAudit.actorType, "autonomy"),
          inArray(hubAudit.action, ["resolve", "archive"]),
        ),
      )
      .orderBy(desc(hubAudit.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    return {
      handledToday: todayRows.length,
      lastHandledAt: serializeDate(latest?.createdAt ?? null),
    };
  }

  async function readRow(companyId: string): Promise<PolicyRow | null> {
    const rows = await db
      .select({
        mode: hubAutopilotPolicies.mode,
        rules: hubAutopilotPolicies.rules,
        updatedAt: hubAutopilotPolicies.updatedAt,
      })
      .from(hubAutopilotPolicies)
      .where(eq(hubAutopilotPolicies.companyId, companyId));
    return rows[0] ?? null;
  }

  async function writePolicy(companyId: string, policy: Omit<HubAutopilotPolicy, "handledToday" | "lastHandledAt" | "updatedAt">): Promise<HubAutopilotPolicy> {
    const nowDate = now();
    const [row] = await db
      .insert(hubAutopilotPolicies)
      .values({
        companyId,
        mode: policy.mode,
        rules: policy.rules,
        updatedAt: nowDate,
      })
      .onConflictDoUpdate({
        target: [hubAutopilotPolicies.companyId],
        set: {
          mode: policy.mode,
          rules: policy.rules,
          updatedAt: nowDate,
        },
      })
      .returning({
        mode: hubAutopilotPolicies.mode,
        rules: hubAutopilotPolicies.rules,
        updatedAt: hubAutopilotPolicies.updatedAt,
      });
    return toPolicy(row ?? null, await autonomyStats(companyId));
  }

  async function getPolicy(companyId: string): Promise<HubAutopilotPolicy> {
    if (policyReader) return normalizePolicy(await policyReader(companyId));
    return toPolicy(await readRow(companyId), await autonomyStats(companyId));
  }

  async function resolveSourceAgent(input: AutopilotEvaluationInput): Promise<string | null> {
    if (input.sourceAgentId) return input.sourceAgentId;
    if (input.sourceType !== "heartbeat_run" || !input.sourceId) return null;
    const row = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.sourceId), eq(heartbeatRuns.companyId, input.companyId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.agentId ?? null;
  }

  async function evaluate(input: AutopilotEvaluationInput): Promise<HubAutopilotEvaluationResult> {
    const policy = await getPolicy(input.companyId);
    if (policy.mode === "off") return noActionResult("Autopilot is off", "off");

    if (isFounderGatedAutopilotType(input.semanticType)) {
      return noActionResult("Founder-gated hub categories cannot be auto-handled in W3 core", policy.mode, "escalate");
    }

    const rule = policy.rules.find((candidate) => candidate.semanticType === input.semanticType);
    if (!rule?.enabled || rule.action === "none") {
      return noActionResult("No enabled Autopilot rule for this category", policy.mode);
    }

    if (!(HUB_AUTOPILOT_ACTIONS as readonly string[]).includes(rule.action) || !isSafeAction(rule.action)) {
      return noActionResult("Autopilot action is not safe in W3 core", policy.mode, "escalate");
    }

    const sourceAgentId = await resolveSourceAgent(input);
    if (!sourceAgentId) {
      return noActionResult("No trusted source-agent context is available", policy.mode, "escalate");
    }

    const trustScore = await trustScores.getScore(input.companyId, sourceAgentId);
    if (!trustScore) return noActionResult("No trust score is available for the source agent", policy.mode, "escalate");

    if (trustScore.currentScore < rule.minTrustScore) {
      return noActionResult(`Trust score ${trustScore.currentScore} is below required ${rule.minTrustScore}`, policy.mode, "escalate");
    }

    if (policy.mode === "assist") {
      return noActionResult("Autopilot Assist explains but does not auto-handle", "assist", "escalate");
    }

    return {
      decision: "auto_handle",
      action: rule.action,
      reason: `Autopilot Drive accepted ${input.semanticType}; trust ${trustScore.currentScore} >= ${rule.minTrustScore}`,
      autonomyLevel: "drive",
    };
  }

  async function applyEvaluation(input: AutopilotEvaluationInput) {
    const policy = await getPolicy(input.companyId);
    const evaluation = await evaluate(input);
    if (evaluation.decision !== "auto_handle" || !isSafeAction(evaluation.action)) {
      return { handled: false as const, evaluation };
    }
    const rule = policy.rules.find((candidate) => candidate.semanticType === input.semanticType);
    const sourceAgentId = await resolveSourceAgent(input);
    const result = await hub.recordLifecycleAction({
      companyId: input.companyId,
      hubItemId: input.hubItemId,
      action: evaluation.action,
      expectedVersion: input.version,
      actorType: "autonomy",
      actorId: "autopilot",
      actorIsFounder: false,
      authorityBasis: `autopilot_policy:${input.semanticType}:${evaluation.autonomyLevel}`,
      autonomyLevel: evaluation.autonomyLevel,
      reason: evaluation.reason,
      idempotencyKey: `autopilot:${input.companyId}:${input.hubItemId}:${input.version}:${evaluation.action}`,
      decisionContext: {
        autopilot: true,
        semanticType: input.semanticType,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        sourceAgentId,
        minTrustScore: rule?.minTrustScore ?? null,
      },
    });
    return { handled: true as const, evaluation, result };
  }

  return {
    get: getPolicy,

    async upsert(companyId: string, patch: UpdateHubAutopilotPolicyInput): Promise<HubAutopilotPolicy> {
      const existing = await getPolicy(companyId);
      const next = hubAutopilotPolicySchema.parse({
        mode: patch.mode ?? existing.mode,
        handledToday: existing.handledToday,
        lastHandledAt: existing.lastHandledAt,
        rules: mergeRules(existing.rules, patch.rules),
        updatedAt: existing.updatedAt,
      });
      return writePolicy(companyId, next);
    },

    async reset(companyId: string): Promise<HubAutopilotPolicy> {
      const defaults = cloneDefaultPolicy();
      return writePolicy(companyId, {
        mode: defaults.mode,
        rules: defaults.rules,
      });
    },

    evaluate,
    applyEvaluation,

    async evaluateOpenItems(args: {
      companyId: string;
      limit: number;
    }): Promise<{ evaluated: number; handled: number; escalated: number }> {
      const limit = Math.min(Math.max(args.limit, 1), 25);
      const rows = await db
        .select({
          id: hubItems.id,
          semanticType: hubItems.semanticType,
          sourceType: hubItems.sourceType,
          sourceId: hubItems.sourceId,
          version: hubItems.version,
        })
        .from(hubItems)
        .where(and(eq(hubItems.companyId, args.companyId), eq(hubItems.status, "open")))
        .limit(limit);

      let evaluated = 0;
      let handled = 0;
      let escalated = 0;
      for (const row of rows) {
        if (!row.semanticType || !(HUB_SEMANTIC_TYPES as readonly string[]).includes(row.semanticType)) continue;
        const semanticType = row.semanticType as HubSemanticType;
        if (isFounderGatedAutopilotType(semanticType)) continue;
        evaluated += 1;
        try {
          const result = await applyEvaluation({
            companyId: args.companyId,
            hubItemId: row.id,
            semanticType,
            sourceType: row.sourceType,
            sourceId: row.sourceId,
            version: row.version,
          });
          if (result.handled) handled += 1;
          else if (result.evaluation.decision === "escalate") escalated += 1;
        } catch (error) {
          if (error instanceof HttpError && error.status === 409) continue;
          throw error;
        }
      }
      return { evaluated, handled, escalated };
    },

    async listRecentActions(companyId: string, args: { limit?: number } = {}): Promise<HubAutopilotActionsResponse> {
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
      const rows = await db
        .select({
          auditId: hubAudit.id,
          hubItemId: hubAudit.hubItemId,
          title: hubItems.title,
          semanticType: hubItems.semanticType,
          action: hubAudit.action,
          autonomyLevel: hubAudit.autonomyLevel,
          reason: hubAudit.reason,
          decisionContext: hubAudit.decisionContext,
          priorState: hubAudit.priorState,
          undoDeadline: hubAudit.undoDeadline,
          itemStatus: hubItems.status,
          createdAt: hubAudit.createdAt,
        })
        .from(hubAudit)
        .leftJoin(hubItems, eq(hubItems.id, hubAudit.hubItemId))
        .where(
          and(
            eq(hubAudit.companyId, companyId),
            eq(hubAudit.actorType, "autonomy"),
            inArray(hubAudit.action, ["resolve", "archive"]),
          ),
        )
        .orderBy(desc(hubAudit.createdAt))
        .limit(limit);

      return {
        items: rows.map((row) => ({
          auditId: row.auditId,
          hubItemId: row.hubItemId ?? null,
          title: row.title ?? "Autopilot action",
          semanticType: (row.semanticType as HubSemanticType | null) ?? null,
          action: row.action as "resolve" | "archive",
          autonomyLevel: (row.autonomyLevel as HubAutopilotMode | null) ?? null,
          reason: row.reason ?? null,
          decisionContext: row.decisionContext ?? null,
          undoDeadline: serializeDate(row.undoDeadline),
          itemStatus: (row.itemStatus as HubItemStatus | null) ?? null,
          itemVersion: auditedPostActionVersion(row.priorState),
          createdAt: serializeDate(row.createdAt) ?? new Date(0).toISOString(),
        })),
      };
    },
  };
}
