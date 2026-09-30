import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memoryItems } from "@armyofagents/db";
import { memoryService, type MultiPathSearchResult } from "../memory.js";
import { recordMemoryRetrievals } from "../memory-retrieval-audit.js";
import { logger } from "../../middleware/logger.js";
import type { NormalizedCommanderContextScope } from "./context-scope.js";
import { splitCommanderMemoryItems } from "./memory-policy.js";

const log = logger.child({ service: "commander-memory-recall" });

export type CommanderMemoryRecallStrictness =
  | "strict"
  | "balanced"
  | "recall-heavy"
  | "precision-heavy";

export type CommanderMemoryLayerSetting = boolean | "scoped";

export interface CommanderMemoryLayerPolicy {
  identity: boolean;
  domain: boolean | "scoped";
  active_context: CommanderMemoryLayerSetting;
  working: CommanderMemoryLayerSetting;
}

export interface CommanderMemoryRecallPolicy {
  enabled: boolean;
  strictness: CommanderMemoryRecallStrictness;
  timeoutMs: number;
  circuitBreakerMaxTimeouts: number;
  circuitBreakerCooldownMs: number;
  maxItems: number;
  layers: CommanderMemoryLayerPolicy;
}

export interface CommanderRecallCandidate {
  id: string;
  title: string;
  content: string;
  layer: string | null;
  status: string | null;
  visibility: string | null;
  expiresAt: Date | string | null;
  conversationId?: string | null;
  createdBy?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  taskId?: string | null;
  retrievalRank?: number;
  similarity?: number | null;
  semanticRank?: number | null;
  keywordRank?: number | null;
  temporalRank?: number | null;
  finalScore?: number;
}

export interface CommanderRecallScope extends Partial<NormalizedCommanderContextScope> {
  departmentId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
}

export type CommanderMemoryRecallStatus =
  | "ok"
  | "disabled"
  | "no_relevant_memory"
  | "timeout"
  | "failed"
  | "circuit_breaker";

export interface CommanderMemoryRecallInput {
  companyId: string;
  userId: string;
  userRole?: string | null;
  conversationId?: string | null;
  agentId?: string | null;
  latestUserMessage: string;
  policy?: CommanderMemoryRecallPolicy;
  scope?: CommanderRecallScope;
}

export interface CommanderMemoryRecallResult {
  status: CommanderMemoryRecallStatus;
  items: CommanderRecallCandidate[];
  query: string | null;
  elapsedMs: number;
}

export const DEFAULT_COMMANDER_MEMORY_RECALL_POLICY: CommanderMemoryRecallPolicy = {
  enabled: true,
  strictness: "balanced",
  timeoutMs: 3000,
  circuitBreakerMaxTimeouts: 3,
  circuitBreakerCooldownMs: 60_000,
  maxItems: 8,
  layers: {
    identity: true,
    domain: true,
    active_context: "scoped",
    working: true,
  },
};

const MAX_COMMANDER_MEMORY_QUERY_CHARS = 480;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  if (floored < min || floored > max) return fallback;
  return floored;
}

function normalizeStrictness(value: unknown): CommanderMemoryRecallStrictness {
  return value === "strict" ||
    value === "balanced" ||
    value === "recall-heavy" ||
    value === "precision-heavy"
    ? value
    : DEFAULT_COMMANDER_MEMORY_RECALL_POLICY.strictness;
}

function normalizeLayerSetting(
  value: unknown,
  fallback: CommanderMemoryLayerSetting,
): CommanderMemoryLayerSetting {
  return value === true || value === false || value === "scoped" ? value : fallback;
}

function normalizeEnabled(value: unknown): boolean {
  if (value === undefined) return DEFAULT_COMMANDER_MEMORY_RECALL_POLICY.enabled;
  if (
    value === true ||
    value === "true" ||
    value === "1" ||
    value === "yes" ||
    value === "on" ||
    value === 1
  ) {
    return true;
  }
  if (
    value === false ||
    value === "false" ||
    value === "0" ||
    value === "no" ||
    value === "off" ||
    value === 0 ||
    value === null
  ) {
    return false;
  }
  return DEFAULT_COMMANDER_MEMORY_RECALL_POLICY.enabled;
}

export function normalizeCommanderMemoryRecallPolicy(value: unknown): CommanderMemoryRecallPolicy {
  const raw = asRecord(value);
  const rawLayers = asRecord(raw.layers);

  return {
    enabled: normalizeEnabled(raw.enabled),
    strictness: normalizeStrictness(raw.strictness),
    timeoutMs: clampInt(raw.timeoutMs, DEFAULT_COMMANDER_MEMORY_RECALL_POLICY.timeoutMs, 250, 30_000),
    circuitBreakerMaxTimeouts: clampInt(
      raw.circuitBreakerMaxTimeouts,
      DEFAULT_COMMANDER_MEMORY_RECALL_POLICY.circuitBreakerMaxTimeouts,
      1,
      20,
    ),
    circuitBreakerCooldownMs: clampInt(
      raw.circuitBreakerCooldownMs,
      DEFAULT_COMMANDER_MEMORY_RECALL_POLICY.circuitBreakerCooldownMs,
      5_000,
      600_000,
    ),
    maxItems: clampInt(raw.maxItems, DEFAULT_COMMANDER_MEMORY_RECALL_POLICY.maxItems, 1, 25),
    layers: {
      identity: normalizeLayerSetting(rawLayers.identity, true) === true,
      domain: normalizeLayerSetting(rawLayers.domain, true),
      active_context: normalizeLayerSetting(rawLayers.active_context, "scoped"),
      working: normalizeLayerSetting(rawLayers.working, true),
    },
  };
}

function stripCodeFences(text: string): string {
  return text.replace(/```(?:\w+)?\s*[\s\S]*?```/g, " ");
}

function stripRecalledBlocks(text: string): string {
  const withoutXml = text.replace(/<active_memory_plugin\b[^>]*>[\s\S]*?<\/active_memory_plugin>/gi, " ");
  const kept: string[] = [];
  let skippingMemorySection = false;

  for (const line of withoutXml.split("\n")) {
    if (/^## Relevant Company Memory\s*$/i.test(line.trim())) {
      skippingMemorySection = true;
      continue;
    }

    if (skippingMemorySection) {
      if (!line.trim()) {
        skippingMemorySection = false;
        continue;
      }
      if (/^#{1,6}\s+/.test(line.trim())) {
        skippingMemorySection = false;
        kept.push(line);
        continue;
      }
      if (/^[^:]{1,200}:\s+/.test(line.trim())) {
        continue;
      }
      skippingMemorySection = false;
    }

    kept.push(line);
  }

  return kept.join("\n");
}

function normalizeQueryText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(conversation info|sender|untrusted context)\b/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampQuery(text: string): string {
  return text.length > MAX_COMMANDER_MEMORY_QUERY_CHARS
    ? text.slice(0, MAX_COMMANDER_MEMORY_QUERY_CHARS).trim()
    : text;
}

export function buildCommanderMemoryRecallQuery(input: { latestUserMessage: string }): string {
  const cleaned = normalizeQueryText(
    stripRecalledBlocks(stripCodeFences(input.latestUserMessage)),
  );
  return clampQuery(cleaned);
}

export function filterCommanderRecallItems(input: {
  items: CommanderRecallCandidate[];
  policy: CommanderMemoryRecallPolicy;
  scope: CommanderRecallScope;
}): { shown: CommanderRecallCandidate[]; filtered: CommanderRecallCandidate[] } {
  const allowedLayers = new Set(
    Object.entries(input.policy.layers)
      .filter(([, enabled]) => enabled !== false)
      .map(([layer]) => layer),
  );
  const layerCandidates = input.items.filter((item) => item.layer && allowedLayers.has(item.layer));
  const policySplit = splitCommanderMemoryItems({
    items: layerCandidates,
    userRole: "founder",
    userId: "__compat__",
    scope: input.scope,
    mode: "automatic_context",
  });
  const shownIds = new Set(policySplit.shown.map((item) => item.id));
  return {
    shown: policySplit.shown,
    filtered: input.items.filter((item) => !shownIds.has(item.id)),
  };
}

function passesStrictness(
  item: CommanderRecallCandidate,
  strictness: CommanderMemoryRecallStrictness,
): boolean {
  const semantic = item.similarity ?? 0;
  const hasStrongSemantic = semantic >= 0.82 || (item.semanticRank ?? 999) <= 3;
  const hasKeyword = (item.keywordRank ?? 999) <= 5;
  const hasTemporal = (item.temporalRank ?? 999) <= 5;

  switch (strictness) {
    case "strict":
      return semantic >= 0.85 || hasKeyword;
    case "precision-heavy":
      return semantic >= 0.88 || hasKeyword;
    case "recall-heavy":
      return hasStrongSemantic || hasKeyword || hasTemporal || (item.finalScore ?? 0) > 0;
    case "balanced":
    default:
      return hasStrongSemantic || hasKeyword;
  }
}

export function applyCommanderRecallStrictness(input: {
  items: CommanderRecallCandidate[];
  strictness: CommanderMemoryRecallStrictness;
}): CommanderRecallCandidate[] {
  return input.items.filter((item) => passesStrictness(item, input.strictness));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timeout: NodeJS.Timeout | undefined;
  promise.catch(() => undefined);
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toCandidate(row: MultiPathSearchResult, index: number): CommanderRecallCandidate {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    layer: row.layer,
    status: row.status,
    visibility: row.visibility,
    expiresAt: row.expiresAt,
    conversationId: row.conversationId,
    createdBy: row.createdBy,
    departmentId: row.departmentId,
    projectId: row.projectId,
    goalId: row.goalId,
    taskId: row.taskId,
    retrievalRank: index + 1,
    similarity: row.similarity,
    semanticRank: row.semanticRank,
    keywordRank: row.keywordRank,
    temporalRank: row.temporalRank,
    finalScore: row.finalScore,
  };
}

function auditItems(input: {
  shown: CommanderRecallCandidate[];
  filtered: CommanderRecallCandidate[];
}): Array<{ id: string; rank?: number; similarityScore: number | null; shownToAgent: boolean }> {
  return [...input.shown, ...input.filtered]
    .sort((a, b) => (a.retrievalRank ?? 9999) - (b.retrievalRank ?? 9999))
    .map((item) => ({
      id: item.id,
      ...(item.retrievalRank ? { rank: item.retrievalRank } : {}),
      similarityScore: item.similarity ?? null,
      shownToAgent: input.shown.some((shown) => shown.id === item.id),
    }));
}

async function touchShownMemory(db: Db, companyId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(memoryItems)
    .set({ accessedAt: new Date() })
    .where(and(eq(memoryItems.companyId, companyId), inArray(memoryItems.id, ids)))
    .execute()
    .catch((err) => {
      log.warn({ err, count: ids.length }, "Failed to update accessedAt for Commander memory recall");
    });
}

interface CircuitBreakerEntry {
  consecutiveTimeouts: number;
  lastTimeoutAt: number;
}

const commanderRecallCircuitBreakers = new Map<string, CircuitBreakerEntry>();

function circuitBreakerKey(input: CommanderMemoryRecallInput): string {
  return `${input.companyId}:${input.userId}`;
}

function isBreakerOpen(key: string, policy: CommanderMemoryRecallPolicy): boolean {
  const entry = commanderRecallCircuitBreakers.get(key);
  if (!entry || entry.consecutiveTimeouts < policy.circuitBreakerMaxTimeouts) return false;
  if (Date.now() - entry.lastTimeoutAt >= policy.circuitBreakerCooldownMs) {
    commanderRecallCircuitBreakers.delete(key);
    return false;
  }
  return true;
}

function recordBreakerTimeout(key: string): void {
  const existing = commanderRecallCircuitBreakers.get(key);
  commanderRecallCircuitBreakers.set(key, {
    consecutiveTimeouts: (existing?.consecutiveTimeouts ?? 0) + 1,
    lastTimeoutAt: Date.now(),
  });
}

function resetBreaker(key: string): void {
  commanderRecallCircuitBreakers.delete(key);
}

export function resetCommanderMemoryRecallCircuitBreakersForTests(): void {
  commanderRecallCircuitBreakers.clear();
}

export function commanderMemoryRecallService(db: Db) {
  return {
    async recall(input: CommanderMemoryRecallInput): Promise<CommanderMemoryRecallResult> {
      const startedAt = Date.now();
      const policy = input.policy ?? DEFAULT_COMMANDER_MEMORY_RECALL_POLICY;
      if (!policy.enabled) {
        return { status: "disabled", items: [], query: null, elapsedMs: Date.now() - startedAt };
      }

      const query = buildCommanderMemoryRecallQuery({
        latestUserMessage: input.latestUserMessage,
      });
      if (!query) {
        return { status: "no_relevant_memory", items: [], query, elapsedMs: Date.now() - startedAt };
      }
      const breakerKey = circuitBreakerKey(input);
      if (isBreakerOpen(breakerKey, policy)) {
        return { status: "circuit_breaker", items: [], query, elapsedMs: Date.now() - startedAt };
      }

      try {
        const result = await withTimeout(
          memoryService(db).searchMultiPath(input.companyId, query, { limit: policy.maxItems }),
          policy.timeoutMs,
        );

        if (result === "timeout") {
          recordBreakerTimeout(breakerKey);
          return { status: "timeout", items: [], query, elapsedMs: Date.now() - startedAt };
        }

        resetBreaker(breakerKey);

        const candidates = result.map(toCandidate);
        const allowedLayers = new Set(
          Object.entries(policy.layers)
            .filter(([, enabled]) => enabled !== false)
            .map(([layer]) => layer),
        );
        const layerCandidates = candidates.filter((item) => item.layer && allowedLayers.has(item.layer));
        const layerFiltered = splitCommanderMemoryItems({
          items: layerCandidates,
          userRole: input.userRole,
          userId: input.userId,
          scope: input.scope ?? {},
          mode: "automatic_context",
        });
        const strictShown = applyCommanderRecallStrictness({
          items: layerFiltered.shown,
          strictness: policy.strictness,
        }).slice(0, policy.maxItems);
        const strictShownIds = new Set(strictShown.map((item) => item.id));
        const strictFiltered = [
          ...candidates.filter((item) => !layerCandidates.some((candidate) => candidate.id === item.id)),
          ...layerFiltered.filtered,
          ...layerFiltered.shown.filter((item) => !strictShownIds.has(item.id)),
        ];

        const itemsForAudit = auditItems({ shown: strictShown, filtered: strictFiltered });
        if (itemsForAudit.length > 0) {
          await recordMemoryRetrievals(db, {
            companyId: input.companyId,
            agentId: input.agentId ?? null,
            taskId: input.scope?.taskId ?? null,
            runId: null,
            conversationId: input.conversationId ?? input.scope?.conversationId ?? null,
            triggeredBy: "commander_context",
            query,
            items: itemsForAudit,
          }).catch((err) => {
            log.warn(
              { err, companyId: input.companyId, itemCount: itemsForAudit.length },
              "Failed to record Commander memory recall audit rows",
            );
          });
        }

        void touchShownMemory(db, input.companyId, strictShown.map((item) => item.id));

        return {
          status: strictShown.length > 0 ? "ok" : "no_relevant_memory",
          items: strictShown,
          query,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (err) {
        recordBreakerTimeout(circuitBreakerKey(input));
        log.warn({ err, companyId: input.companyId }, "Commander memory recall failed");
        return { status: "failed", items: [], query, elapsedMs: Date.now() - startedAt };
      }
    },
  };
}
