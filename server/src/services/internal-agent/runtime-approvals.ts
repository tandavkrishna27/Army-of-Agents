import { createHash } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  internalAgentRuntimeApprovals,
  internalAgentToolTrustRules,
} from "@armyofagents/db";
import type { CommanderRuntimeApprovalDecision } from "@armyofagents/shared";

const PARAMS_HASH_VERSION = "v1";
const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | { [key: string]: JsonLike };

type CreatePendingInput = {
  companyId: string;
  conversationId?: string | null;
  runId?: string | null;
  userId: string;
  toolName: string;
  params: Record<string, unknown>;
  ttlMs?: number;
};

type ExactTrustInput = {
  companyId: string;
  userId: string;
  toolName: string;
  params: Record<string, unknown>;
};

type MarkExecutedInput = {
  summary: string;
  entityType?: string | null;
  entityId?: string | null;
};

function canonicalize(value: unknown): JsonLike {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, JsonLike> = {};
    for (const key of Object.keys(obj).sort()) {
      const item = obj[key];
      if (item === undefined) continue;
      sorted[key] = canonicalize(item);
    }
    return sorted;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value);
}

export function canonicalRuntimeApprovalParams(params: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(params));
}

export function hashRuntimeApprovalParams(
  toolName: string,
  params: Record<string, unknown>,
): { paramsHash: string; paramsHashVersion: string } {
  const canonicalParams = canonicalRuntimeApprovalParams(params);
  const hashInput = `${PARAMS_HASH_VERSION}:${toolName}:${canonicalParams}`;
  return {
    paramsHash: createHash("sha256").update(hashInput).digest("hex"),
    paramsHashVersion: PARAMS_HASH_VERSION,
  };
}

export function runtimeApprovalService(db: Db) {
  return {
    async createPending(input: CreatePendingInput) {
      const now = Date.now();
      const { paramsHash, paramsHashVersion } = hashRuntimeApprovalParams(
        input.toolName,
        input.params,
      );

      return db
        .insert(internalAgentRuntimeApprovals)
        .values({
          companyId: input.companyId,
          conversationId: input.conversationId ?? null,
          runId: input.runId ?? null,
          userId: input.userId,
          toolName: input.toolName,
          params: input.params,
          paramsHash,
          paramsHashVersion,
          status: "pending",
          expiresAt: new Date(now + (input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS)),
        })
        .returning()
        .then((rows) => rows[0]);
    },

    async findTrustedExact(input: ExactTrustInput) {
      const now = new Date();
      const { paramsHash, paramsHashVersion } = hashRuntimeApprovalParams(
        input.toolName,
        input.params,
      );

      return db
        .select()
        .from(internalAgentToolTrustRules)
        .where(
          and(
            eq(internalAgentToolTrustRules.companyId, input.companyId),
            eq(internalAgentToolTrustRules.userId, input.userId),
            eq(internalAgentToolTrustRules.toolName, input.toolName),
            eq(internalAgentToolTrustRules.paramsHash, paramsHash),
            eq(internalAgentToolTrustRules.paramsHashVersion, paramsHashVersion),
            eq(internalAgentToolTrustRules.scope, "exact_params"),
            eq(internalAgentToolTrustRules.enabled, true),
            or(
              isNull(internalAgentToolTrustRules.expiresAt),
              gt(internalAgentToolTrustRules.expiresAt, now),
            ),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    async listTrustRules(companyId: string, userId: string) {
      return db
        .select()
        .from(internalAgentToolTrustRules)
        .where(
          and(
            eq(internalAgentToolTrustRules.companyId, companyId),
            eq(internalAgentToolTrustRules.userId, userId),
            eq(internalAgentToolTrustRules.enabled, true),
          ),
        )
        .limit(100);
    },

    async createTrustRule(input: ExactTrustInput & { createdByUserId: string }) {
      const now = new Date();
      const { paramsHash, paramsHashVersion } = hashRuntimeApprovalParams(
        input.toolName,
        input.params,
      );

      return db
        .insert(internalAgentToolTrustRules)
        .values({
          companyId: input.companyId,
          userId: input.userId,
          toolName: input.toolName,
          paramsHash,
          paramsHashVersion,
          scope: "exact_params",
          enabled: true,
          createdByUserId: input.createdByUserId,
        })
        .onConflictDoUpdate({
          target: [
            internalAgentToolTrustRules.companyId,
            internalAgentToolTrustRules.userId,
            internalAgentToolTrustRules.toolName,
            internalAgentToolTrustRules.paramsHash,
            internalAgentToolTrustRules.paramsHashVersion,
            internalAgentToolTrustRules.scope,
          ],
          set: {
            enabled: true,
            createdByUserId: input.createdByUserId,
            updatedAt: now,
            expiresAt: null,
          },
        })
        .returning()
        .then((rows) => rows[0]);
    },

    async revokeTrustRule(id: string, companyId: string, userId: string) {
      const now = new Date();
      return db
        .update(internalAgentToolTrustRules)
        .set({
          enabled: false,
          updatedAt: now,
        })
        .where(
          and(
            eq(internalAgentToolTrustRules.id, id),
            eq(internalAgentToolTrustRules.companyId, companyId),
            eq(internalAgentToolTrustRules.userId, userId),
            eq(internalAgentToolTrustRules.enabled, true),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    async deny(id: string, companyId: string, decidedByUserId: string) {
      const now = new Date();
      return db
        .update(internalAgentRuntimeApprovals)
        .set({
          status: "denied",
          decidedByUserId,
          decidedAt: now,
          decision: "deny",
          updatedAt: now,
        })
        .where(
          and(
            eq(internalAgentRuntimeApprovals.id, id),
            eq(internalAgentRuntimeApprovals.companyId, companyId),
            eq(internalAgentRuntimeApprovals.userId, decidedByUserId),
            eq(internalAgentRuntimeApprovals.status, "pending"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    async claimForExecution(
      id: string,
      companyId: string,
      decidedByUserId: string,
      decision: Exclude<CommanderRuntimeApprovalDecision, "deny">,
    ) {
      const now = new Date();
      return db
        .update(internalAgentRuntimeApprovals)
        .set({
          status: "executing",
          decidedByUserId,
          decidedAt: now,
          decision,
          updatedAt: now,
        })
        .where(
          and(
            eq(internalAgentRuntimeApprovals.id, id),
            eq(internalAgentRuntimeApprovals.companyId, companyId),
            eq(internalAgentRuntimeApprovals.userId, decidedByUserId),
            eq(internalAgentRuntimeApprovals.status, "pending"),
            gt(internalAgentRuntimeApprovals.expiresAt, now),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    async markExecuted(id: string, companyId: string, result: MarkExecutedInput) {
      const now = new Date();
      return db
        .update(internalAgentRuntimeApprovals)
        .set({
          status: "approved",
          executedAt: now,
          resultSummary: result.summary,
          resultEntityType: result.entityType ?? null,
          resultEntityId: result.entityId ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(internalAgentRuntimeApprovals.id, id),
            eq(internalAgentRuntimeApprovals.companyId, companyId),
            eq(internalAgentRuntimeApprovals.status, "executing"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    async markFailed(id: string, companyId: string, error: string) {
      const now = new Date();
      return db
        .update(internalAgentRuntimeApprovals)
        .set({
          status: "failed",
          resultError: error,
          updatedAt: now,
        })
        .where(
          and(
            eq(internalAgentRuntimeApprovals.id, id),
            eq(internalAgentRuntimeApprovals.companyId, companyId),
            eq(internalAgentRuntimeApprovals.status, "executing"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },
  };
}
