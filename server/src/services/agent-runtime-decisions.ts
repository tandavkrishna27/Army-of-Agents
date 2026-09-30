import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agentRuntimeDecisions, agentRuntimeTrustRules, heartbeatRuns } from "@armyofagents/db";
import type {
  RuntimeDecisionDetail,
  RuntimeDecisionKind,
  RuntimeDecisionPermissionDecision,
  RuntimeDecisionStatus,
  RuntimeDecisionTimeoutPolicy,
} from "@armyofagents/shared";
import { RUNTIME_DECISION_PERMISSION_DECISIONS } from "@armyofagents/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { redactEventPayload, redactSecretsInString } from "../redaction.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { hubItemsService } from "./hub-items.js";
import { parseConnectorServerName } from "./mcp-connectors.js";

const SOURCE_TYPE = "runtime_decision";
const ACTIVE_STATUSES = new Set<RuntimeDecisionStatus>([
  "created",
  "shown",
  "answered",
  "relay_failed",
]);
const TERMINAL_STATUSES = new Set<RuntimeDecisionStatus>([
  "relayed",
  "expired",
  "cancelled",
]);

const PERMISSION_DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const WORK_QUESTION_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// R1 zombie-decision guard: heartbeat run statuses that are final. A terminal
// (or missing) run must never mint a NEW runtime decision — a zombie CLI whose
// process survived a cancel would otherwise POST to the hook route and create
// endless decisions that later expire into agent_error noise. Kept in sync with
// heartbeat.TERMINAL_RUN_STATUSES (duplicated to avoid a service→service import
// cycle with the heavy heartbeat module).
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

function defaultTtlMs(kind: RuntimeDecisionKind) {
  return kind === "permission" ? PERMISSION_DEFAULT_TTL_MS : WORK_QUESTION_DEFAULT_TTL_MS;
}

export function defaultTimeoutPolicy(kind: RuntimeDecisionKind): RuntimeDecisionTimeoutPolicy {
  return kind === "permission" ? "deny" : "park_run";
}

const TRUST_RULE_DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export const STANDING_GRANT_UNBOUND_REASON =
  "This request has no agent, so there is nothing a standing grant could be scoped to. Answer allow once or deny.";

/**
 * ★★★ BRW-004 (E8-F002) — THE TENTH NULL-HAZARD, and design §D5 named it in advance: "the
 * moment slice (c) populates `networkTarget` … `allow_always` becomes reachable for browser
 * egress". Slice (c) landed; this refusal did not, and it is the only one of the ten that is a
 * PRIVILEGE ESCALATION rather than a broken lever.
 *
 * A standing grant (`allow_always` → persistent rule; `allow_run` → run-scoped rule) is scoped
 * by the agent it is bound to. A distributed browser decision has no agent and no run, so the
 * rule minted from it would have been bound to nothing — and an unbound rule was a COMPANY-WIDE
 * WILDCARD IN THE AGENT DIMENSION, because `trustRuleMatchesPrompt` skipped its agent clause on a
 * null. One founder answering "always allow this browser session to reach example.com" would have
 * silently authorised sessions they never saw, with no second answer.
 *
 * ★★ THE BLAST RADIUS, RE-DERIVED RATHER THAN ASSERTED. An unbound rule drops the AGENT
 * dimension entirely — the grant stops being scoped to a principal, which is the defect. It does
 * not follow that every agent is reachable: a match also needs equal `riskClass` and an exact
 * `networkScope`. Today the browser seam emits `riskClass: "network_egress"` with a URL ORIGIN
 * (`navigationTarget` → `new URL(u).origin`), while the CLI hook bridge emits `"network"` with a
 * bare HOSTNAME (`runtime-hook-bridge.ts` `resolveRiskClass` / `new URL(url).hostname`), so a
 * heartbeat prompt cannot match a browser-minted rule today. What IS reachable is every other
 * distributed browser prompt in the company on the same adapter and origin — a different job, a
 * different session, a different requester — for ninety days, plus any future producer that emits
 * the same pair. A per-session answer silently becoming a cross-session grant is the escalation;
 * "every org agent" would have been an overclaim, and the two-clause coincidence that prevents it
 * is not a guard anyone designed.
 *
 * ★★ THE PREDICATE IS THE BINDING, NOT THE SOURCE. §D5 words the refusal as "browser-sourced
 * prompts", but the decision row carries NO source column (checked: `agent_runtime_decisions`
 * has `sourceUniqueKey` and nothing else that names a job source). The binding is the only
 * discriminator the row actually has — and it is also the load-bearing one, because "unbound"
 * is precisely what makes the grant unsafe. Today the two sets coincide: `browser_request` is
 * the only source that opens an agent-less decision.
 *
 * ★ It tests `runId` too, though the DB CHECK on the decisions table already makes the pair
 * all-or-nothing. If that check were ever dropped, a half-bound row must still not mint a
 * standing grant — the fail-closed direction costs one clause.
 *
 * Returns the narrowed binding rather than a boolean, so the ONLY way to build a trust rule is
 * to have passed through here: both builders take `agentId: string`, and deleting this call is
 * a compile error rather than a silently-missing guard.
 */
export function standingGrantBinding(
  row: Pick<AgentRuntimeDecisionRow, "agentId" | "runId">,
): { agentId: string; runId: string } | null {
  if (row.agentId === null || row.runId === null) return null;
  return { agentId: row.agentId, runId: row.runId };
}

function buildTrustRuleInsert(
  row: AgentRuntimeDecisionRow,
  binding: { agentId: string },
  actorUserId: string,
  nowDate: Date,
): typeof agentRuntimeTrustRules.$inferInsert {
  return {
    companyId: row.companyId,
    agentId: binding.agentId,
    runId: null,
    grantScope: "persistent",
    adapterType: row.adapterType,
    toolName: row.toolName,
    commandHash: row.commandHash,
    pathScope: row.path,
    networkScope: row.networkTarget,
    riskClass: row.riskClass,
    enabled: true,
    expiresAt: new Date(nowDate.getTime() + TRUST_RULE_DEFAULT_TTL_MS),
    createdByUserId: actorUserId,
  };
}

export function runtimeRunGrantEligibility(row: Pick<
  AgentRuntimeDecisionRow,
  "kind" | "riskClass" | "command" | "cwd" | "path" | "networkTarget"
>): { eligible: boolean; reason: string | null } {
  if (row.kind !== "permission") return { eligible: false, reason: "Only permission requests support run access." };
  if (row.riskClass !== "filesystem") {
    return { eligible: false, reason: "Run access is unavailable for shell, network, secret, or unknown actions." };
  }
  if (row.command || row.networkTarget) {
    return { eligible: false, reason: "Run access never includes shell or network access." };
  }
  if (!row.cwd || !row.path || !pathMatchesScope(row.path, row.cwd)) {
    return { eligible: false, reason: "The target must be validated inside the current Workspace." };
  }
  return { eligible: true, reason: null };
}

function buildRunTrustRuleInsert(
  row: AgentRuntimeDecisionRow,
  binding: { agentId: string; runId: string },
  actorUserId: string,
): typeof agentRuntimeTrustRules.$inferInsert {
  const eligibility = runtimeRunGrantEligibility(row);
  if (!eligibility.eligible || !row.cwd) {
    throw unprocessable(eligibility.reason ?? "Run access is unavailable for this action");
  }
  return {
    companyId: row.companyId,
    agentId: binding.agentId,
    runId: binding.runId,
    grantScope: "run",
    adapterType: row.adapterType,
    toolName: null,
    commandHash: null,
    pathScope: row.cwd,
    networkScope: null,
    riskClass: "filesystem",
    enabled: true,
    // The run itself is the lifetime boundary. Terminal run cleanup revokes
    // this rule, while runId matching prevents it from authorizing other work.
    expiresAt: null,
    createdByUserId: actorUserId,
  };
}

/**
 * BRW-004 (E8-F002) — the ONE place a standing grant is built, and therefore the one place the
 * tenth null-hazard can be closed. `standingGrantBinding` is called exactly once in the module;
 * both builders take the narrowed `agentId: string` it yields, so a future edit cannot reach
 * `agentRuntimeTrustRules` without passing through this refusal.
 */
function buildStandingGrant(
  row: AgentRuntimeDecisionRow,
  decision: "allow_always" | "allow_run",
  actorUserId: string,
  nowDate: Date,
): typeof agentRuntimeTrustRules.$inferInsert {
  const binding = standingGrantBinding(row);
  if (binding === null) throw unprocessable(STANDING_GRANT_UNBOUND_REASON);
  return decision === "allow_run"
    ? buildRunTrustRuleInsert(row, binding, actorUserId)
    : buildTrustRuleInsert(row, binding, actorUserId, nowDate);
}

function isVisibleTimeoutFollowUp(row: AgentRuntimeDecisionRow) {
  return row.status === "cancelled" && (row.timeoutPolicy === "park_run" || row.timeoutPolicy === "escalate");
}

export type AgentRuntimeDecisionRow = typeof agentRuntimeDecisions.$inferSelect;
export type AgentRuntimeTrustRuleRow = typeof agentRuntimeTrustRules.$inferSelect;

export class RuntimeDecisionCancelledError extends Error {
  readonly decision: AgentRuntimeDecisionRow;

  constructor(decision: AgentRuntimeDecisionRow) {
    super(decision.relayError ?? "Runtime decision prompt was cancelled");
    this.name = "RuntimeDecisionCancelledError";
    this.decision = decision;
  }
}

type CreatePromptInput = {
  companyId: string;
  /**
   * BRW-004 (E8-F002) — NULL for a distributed job decision.
   *
   * A `browser_request` job has no `agents` row and no `heartbeat_runs` row; its binding
   * rides the fence-guarded `job_projection_receipts` row instead. The DB CHECK
   * `(agent_id IS NULL) = (run_id IS NULL)` makes the pair all-or-nothing, so these two are
   * either both set or both null and nothing in between reaches a reader.
   */
  agentId: string | null;
  runId: string | null;
  adapterType: string;
  adapterSessionId?: string | null;
  adapterSessionParams?: Record<string, unknown> | null;
  kind: RuntimeDecisionKind;
  nonce: string;
  title: string;
  summary?: string | null;
  promptText?: string | null;
  toolName?: string | null;
  command?: string | null;
  cwd?: string | null;
  path?: string | null;
  networkTarget?: string | null;
  riskClass?: string | null;
  options?: Array<Record<string, unknown>> | null;
  expiresAt?: Date | null;
  timeoutPolicy: RuntimeDecisionTimeoutPolicy;
};

type AnswerPromptInput = {
  companyId: string;
  decisionId: string;
  actorUserId: string;
  expectedSourceRevision: number;
  nonce: string;
  kind: RuntimeDecisionKind;
  decision?: RuntimeDecisionPermissionDecision;
  answer?: Record<string, unknown>;
  idempotencyKey?: string;
};

type RelayFailedInput = {
  companyId: string;
  decisionId: string;
  relayError: string;
};

type ExpireDueInput = {
  companyId?: string;
  limit: number;
};

type WaitForAnswerInput = {
  companyId: string;
  decisionId: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

type CreateTrustRuleInput = {
  companyId: string;
  /**
   * BRW-004 (E8-F002) — REQUIRED. Was `agentId?: string | null`, written through as `?? null`:
   * a second door onto the tenth null-hazard's unbound wildcard rule. It has zero production
   * callers (the routes expose only list + revoke; `internal-agent.ts` reaches a different
   * service), so narrowing it costs nothing and closes the door before it acquires one.
   */
  agentId: string;
  adapterType: string;
  toolName?: string | null;
  command?: string | null;
  commandHash?: string | null;
  pathScope?: string | null;
  networkScope?: string | null;
  riskClass?: string | null;
  expiresAt?: Date | null;
  createdByUserId: string;
};

type DecisionRepo = {
  createDecision(input: typeof agentRuntimeDecisions.$inferInsert): Promise<AgentRuntimeDecisionRow>;
  getDecision(companyId: string, decisionId: string): Promise<AgentRuntimeDecisionRow | null>;
  listActiveForRun(input: { companyId: string; runId: string }): Promise<AgentRuntimeDecisionRow[]>;
  /**
   * R1 zombie-decision guard: the current status of the run a prompt is being
   * raised for. Returns null when the run row is missing. createPrompt refuses
   * to mint a decision against a terminal (or missing) run.
   */
  getRunStatus(runId: string): Promise<string | null>;
  listTrustRules(input: { companyId: string; adapterType?: string; includeDisabled?: boolean }): Promise<AgentRuntimeTrustRuleRow[]>;
  createTrustRule(input: typeof agentRuntimeTrustRules.$inferInsert): Promise<AgentRuntimeTrustRuleRow>;
  revokeTrustRule(input: { companyId: string; ruleId: string }): Promise<AgentRuntimeTrustRuleRow | null>;
  markTrustRuleUsed(input: { ruleId: string; usedAt: Date }): Promise<void>;
  updateDecision(
    decisionId: string,
    patch: Partial<typeof agentRuntimeDecisions.$inferInsert>,
    guard?: { sourceRevision?: number; statuses?: RuntimeDecisionStatus[] },
  ): Promise<AgentRuntimeDecisionRow | null>;
  answerWithTrustRule(
    decisionId: string,
    patch: Partial<typeof agentRuntimeDecisions.$inferInsert>,
    guard: { sourceRevision: number; statuses: RuntimeDecisionStatus[] },
    trustRule: typeof agentRuntimeTrustRules.$inferInsert,
  ): Promise<{ decision: AgentRuntimeDecisionRow | null; rule: AgentRuntimeTrustRuleRow | null }>;
  listDueForExpiry(input: { companyId?: string; now: Date; limit: number }): Promise<AgentRuntimeDecisionRow[]>;
  /**
   * R2 stranded-answer sweep (P3-4): decisions in status answered/relay_failed
   * whose heartbeat run has already gone terminal. These are invisible to
   * listDueForExpiry (hard-scoped to created/shown) — the answer can never be
   * relayed because the run is dead, so the sweeper cancels + closes them. A
   * missing run row (INNER JOIN drops it) is covered by cancelActiveForRun on
   * the deleting side, so this only needs the terminal-run rows.
   */
  listStrandedAnswers(input: { companyId?: string; limit: number }): Promise<AgentRuntimeDecisionRow[]>;
};

type HubItemsApi = Pick<ReturnType<typeof hubItemsService>, "emit" | "reconcile">;

type ConnectorAutoAllowInput = {
  companyId: string;
  agentId: string;
  adapterType: string;
  toolName: string | null;
};

type ServiceDeps = {
  repo?: DecisionRepo;
  hubItems?: HubItemsApi;
  activityLogger?: (input: LogActivityInput) => Promise<void>;
  runCanceller?: (input: { companyId: string; runId: string; reason: string }) => Promise<void>;
  now?: () => Date;
  /**
   * FU-25: connector auto-allow probe. Returns true when a permission request is
   * for a tool owned by an ACTIVE connector assigned to this run's agent (or, for
   * Commander, any active connector). Injectable for tests; the production default
   * (below) resolves it against the DB via `isConnectorToolAutoAllowed`.
   */
  connectorAutoAllow?: (input: ConnectorAutoAllowInput) => Promise<boolean>;
};

function safeText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return redactSecretsInString(value);
}

function redactJsonSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactSecretsInString(value);
  if (Array.isArray(value)) return value.map((item) => redactJsonSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactJsonSecrets(item)]),
    );
  }
  return value;
}

function promptHash(input: Pick<CreatePromptInput, "kind" | "title" | "summary" | "promptText" | "command">) {
  return hashString(JSON.stringify({
      kind: input.kind,
      title: input.title,
      summary: input.summary ?? null,
      promptText: input.promptText ?? null,
      command: input.command ?? null,
    }));
}

function hashString(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The runtime-decision source identity.
 *
 * ★★ BRW-004 (E8-F002). `runId` became nullable, and a null rendered by template
 * interpolation would produce the literal string "null" in the key — an identity that WORKS
 * by accident and would break the first time anyone touched the template. The distributed
 * case gets an explicit sentinel instead. A UUID can never collide with it.
 *
 * ★★★ AND THIS FUNCTION IS DUPLICATED. `job-approval-bridge.ts` computes the same string in
 * its own `runtimeSourceIdentity`, bound to this one only by a comment saying they must be
 * byte-identical. Nothing checked that before; making `runId` nullable is exactly the change
 * that could have silently diverged them, so `runtime-decision-source-identity.test.ts` now
 * pins both implementations against the same vectors, INCLUDING the null case. Exported for
 * that test — a second implementation of an identity rule is a divergence waiting to happen,
 * and the only reason there are still two is that the bridge must not import the service.
 */
export const DISTRIBUTED_RUN_SENTINEL = "distributed";

export function runtimeDecisionSourceUniqueKey(input: {
  companyId: string;
  runId: string | null;
  nonce: string;
}) {
  return `runtime:${input.companyId}:${input.runId ?? DISTRIBUTED_RUN_SENTINEL}:${input.nonce}`;
}

function sourceUniqueKey(input: { companyId: string; runId: string | null; nonce: string }) {
  return runtimeDecisionSourceUniqueKey(input);
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandHash(command: string | null | undefined) {
  return command ? hashString(command) : null;
}

function jsonEquivalent(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function isIdempotentAnswerReplay(row: AgentRuntimeDecisionRow, input: AnswerPromptInput) {
  if (!input.idempotencyKey || row.answerIdempotencyKey !== input.idempotencyKey) return false;
  if (row.nonce !== input.nonce || row.kind !== input.kind) return false;
  if (input.kind === "permission") return row.decision === input.decision;
  return jsonEquivalent(row.answerPayload, input.answer);
}

function pathMatchesScope(path: string | null | undefined, scope: string | null) {
  if (!scope) return true;
  if (!path) return false;
  const normalizedPath = normalizePathForScopeMatch(path);
  const normalizedScope = normalizePathForScopeMatch(scope);
  if (!normalizedPath || !normalizedScope) return false;
  return normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
}

function normalizePathForScopeMatch(value: string) {
  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;
  return segments.join("/").replace(/\/+$/, "");
}

function networkMatchesScope(networkTarget: string | null | undefined, scope: string | null) {
  if (!scope) return true;
  return networkTarget === scope;
}

function hasConcreteTrustScope(input: {
  command?: string | null;
  commandHash?: string | null;
  path?: string | null;
  pathScope?: string | null;
  networkTarget?: string | null;
  networkScope?: string | null;
  riskClass?: string | null;
}) {
  return Boolean(
    input.command ||
    input.commandHash ||
    input.path ||
    input.pathScope ||
    input.networkTarget ||
    input.networkScope ||
    input.riskClass,
  );
}

function trustRuleMatchesPrompt(rule: AgentRuntimeTrustRuleRow, input: CreatePromptInput, now: Date) {
  if (!rule.enabled) return false;
  if (rule.expiresAt && rule.expiresAt.getTime() <= now.getTime()) return false;
  if (rule.companyId !== input.companyId) return false;
  if (rule.grantScope === "run" && rule.runId !== input.runId) return false;
  if (rule.grantScope !== "run" && rule.runId) return false;
  if (rule.adapterType !== input.adapterType) return false;
  // BRW-004 (E8-F002) — the READ half of the tenth null-hazard. This used to read
  // `rule.agentId && rule.agentId !== input.agentId`, i.e. a rule with no agent matched EVERY
  // prompt in the company. That branch was unreachable while `agent_runtime_decisions.agent_id`
  // was NOT NULL; the relaxation made it reachable through browser egress. `agent_id` on this
  // table is now NOT NULL, so the truthiness test protected nothing — and dropping it also means
  // an unbound prompt (`input.agentId === null`) matches no standing rule at all, which is the
  // same policy `standingGrantBinding` enforces on the write side.
  if (rule.agentId !== input.agentId) return false;
  if (rule.toolName && rule.toolName !== input.toolName) return false;
  if (rule.commandHash && rule.commandHash !== commandHash(input.command)) return false;
  if (!pathMatchesScope(input.path, rule.pathScope)) return false;
  if (!networkMatchesScope(input.networkTarget, rule.networkScope)) return false;
  if (rule.riskClass && rule.riskClass !== input.riskClass) return false;
  return true;
}

export function runtimeDecisionDetail(row: AgentRuntimeDecisionRow): RuntimeDecisionDetail {
  const allowRun = runtimeRunGrantEligibility(row);
  return {
    id: row.id,
    hubItemId: null,
    companyId: row.companyId,
    agentId: row.agentId,
    runId: row.runId,
    adapterType: row.adapterType as RuntimeDecisionDetail["adapterType"],
    adapterSessionId: row.adapterSessionId,
    kind: row.kind as RuntimeDecisionKind,
    status: row.status as RuntimeDecisionStatus,
    sourceRevision: row.sourceRevision,
    nonce: row.nonce,
    title: row.title,
    summary: row.summary,
    promptText: row.promptText,
    toolName: row.toolName,
    command: row.command,
    cwd: row.cwd,
    path: row.path,
    networkTarget: row.networkTarget,
    riskClass: row.riskClass,
    allowRunEligible: allowRun.eligible,
    allowRunReason: allowRun.reason,
    options: row.options as RuntimeDecisionDetail["options"],
    timeoutPolicy: row.timeoutPolicy as RuntimeDecisionTimeoutPolicy,
    expiresAt: toIso(row.expiresAt),
    answeredAt: toIso(row.answeredAt),
    relayedAt: toIso(row.relayedAt),
    relayError: row.relayError,
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
  };
}

function realRepo(db: Db): DecisionRepo {
  return {
    async createDecision(input) {
      return db
        .insert(agentRuntimeDecisions)
        .values(input)
        .onConflictDoUpdate({
          target: agentRuntimeDecisions.sourceUniqueKey,
          targetWhere: sql`source_unique_key is not null`,
          setWhere: sql`${agentRuntimeDecisions.status} in ('created', 'shown', 'relay_failed')`,
          set: {
            title: input.title,
            summary: input.summary ?? null,
            promptText: input.promptText ?? null,
            toolName: input.toolName ?? null,
            command: input.command ?? null,
            commandHash: input.commandHash ?? null,
            cwd: input.cwd ?? null,
            path: input.path ?? null,
            networkTarget: input.networkTarget ?? null,
            riskClass: input.riskClass ?? null,
            options: input.options ?? null,
            expiresAt: input.expiresAt ?? null,
            timeoutPolicy: input.timeoutPolicy,
            status: input.status,
            sourceRevision: sql`${agentRuntimeDecisions.sourceRevision} + 1`,
            decision: input.decision ?? null,
            answerIdempotencyKey: input.answerIdempotencyKey ?? null,
            answeredByUserId: input.answeredByUserId ?? null,
            answeredAt: input.answeredAt ?? null,
            updatedAt: new Date(),
          },
        })
        .returning()
        .then(async (rows) => {
          if (rows[0]) return rows[0];
          if (!input.sourceUniqueKey) {
            throw new Error("Runtime decision conflict fallback requires source_unique_key");
          }
          return db
            .select()
            .from(agentRuntimeDecisions)
            .where(eq(agentRuntimeDecisions.sourceUniqueKey, input.sourceUniqueKey))
            .limit(1)
            .then((existing) => existing[0]);
        });
    },
    async getDecision(companyId, decisionId) {
      return db
        .select()
        .from(agentRuntimeDecisions)
        .where(and(eq(agentRuntimeDecisions.id, decisionId), eq(agentRuntimeDecisions.companyId, companyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },
    async listActiveForRun(input) {
      return db
        .select()
        .from(agentRuntimeDecisions)
        .where(
          and(
            eq(agentRuntimeDecisions.companyId, input.companyId),
            eq(agentRuntimeDecisions.runId, input.runId),
            inArray(agentRuntimeDecisions.status, ["created", "shown", "answered", "relay_failed"]),
          ),
        );
    },
    async getRunStatus(runId) {
      return db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1)
        .then((rows) => rows[0]?.status ?? null);
    },
    async listTrustRules(input) {
      const conditions = [
        eq(agentRuntimeTrustRules.companyId, input.companyId),
      ];
      if (input.adapterType) conditions.push(eq(agentRuntimeTrustRules.adapterType, input.adapterType));
      if (!input.includeDisabled) conditions.push(eq(agentRuntimeTrustRules.enabled, true));
      return db.select().from(agentRuntimeTrustRules).where(and(...conditions));
    },
    async createTrustRule(input) {
      return db
        .insert(agentRuntimeTrustRules)
        .values(input)
        .returning()
        .then((rows) => rows[0]);
    },
    async revokeTrustRule(input) {
      return db
        .update(agentRuntimeTrustRules)
        .set({ enabled: false, updatedAt: new Date() })
        .where(and(eq(agentRuntimeTrustRules.companyId, input.companyId), eq(agentRuntimeTrustRules.id, input.ruleId)))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
    async markTrustRuleUsed(input) {
      await db
        .update(agentRuntimeTrustRules)
        .set({ lastUsedAt: input.usedAt, updatedAt: input.usedAt })
        .where(eq(agentRuntimeTrustRules.id, input.ruleId));
    },
    async updateDecision(decisionId, patch, guard) {
      const conditions = [eq(agentRuntimeDecisions.id, decisionId)];
      if (guard?.sourceRevision !== undefined) {
        conditions.push(eq(agentRuntimeDecisions.sourceRevision, guard.sourceRevision));
      }
      if (guard?.statuses?.length) {
        conditions.push(inArray(agentRuntimeDecisions.status, guard.statuses));
      }
      return db
        .update(agentRuntimeDecisions)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(...conditions))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
    async answerWithTrustRule(decisionId, patch, guard, trustRule) {
      return db.transaction(async (tx) => {
        const conditions = [
          eq(agentRuntimeDecisions.id, decisionId),
          eq(agentRuntimeDecisions.sourceRevision, guard.sourceRevision),
          inArray(agentRuntimeDecisions.status, guard.statuses),
        ];
        const [decision] = await tx
          .update(agentRuntimeDecisions)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(...conditions))
          .returning();
        if (!decision) return { decision: null, rule: null };
        const scopeConds = [
          eq(agentRuntimeTrustRules.companyId, trustRule.companyId),
          eq(agentRuntimeTrustRules.adapterType, trustRule.adapterType),
          eq(agentRuntimeTrustRules.enabled, true),
          eq(agentRuntimeTrustRules.grantScope, trustRule.grantScope ?? "persistent"),
          trustRule.runId
            ? eq(agentRuntimeTrustRules.runId, trustRule.runId)
            : isNull(agentRuntimeTrustRules.runId),
          trustRule.agentId
            ? eq(agentRuntimeTrustRules.agentId, trustRule.agentId)
            : isNull(agentRuntimeTrustRules.agentId),
          trustRule.toolName
            ? eq(agentRuntimeTrustRules.toolName, trustRule.toolName)
            : isNull(agentRuntimeTrustRules.toolName),
          trustRule.commandHash
            ? eq(agentRuntimeTrustRules.commandHash, trustRule.commandHash)
            : isNull(agentRuntimeTrustRules.commandHash),
          trustRule.pathScope
            ? eq(agentRuntimeTrustRules.pathScope, trustRule.pathScope)
            : isNull(agentRuntimeTrustRules.pathScope),
          trustRule.networkScope
            ? eq(agentRuntimeTrustRules.networkScope, trustRule.networkScope)
            : isNull(agentRuntimeTrustRules.networkScope),
          trustRule.riskClass
            ? eq(agentRuntimeTrustRules.riskClass, trustRule.riskClass)
            : isNull(agentRuntimeTrustRules.riskClass),
        ];
        const [existing] = await tx
          .select()
          .from(agentRuntimeTrustRules)
          .where(and(...scopeConds))
          .limit(1);
        let rule: AgentRuntimeTrustRuleRow;
        if (existing) {
          [rule] = await tx
            .update(agentRuntimeTrustRules)
            .set({ expiresAt: trustRule.expiresAt, enabled: true, updatedAt: new Date() })
            .where(eq(agentRuntimeTrustRules.id, existing.id))
            .returning();
        } else {
          [rule] = await tx.insert(agentRuntimeTrustRules).values(trustRule).returning();
        }
        return { decision, rule };
      });
    },
    async listDueForExpiry(input) {
      const conditions = [
        inArray(agentRuntimeDecisions.status, ["created", "shown"]),
        lte(agentRuntimeDecisions.expiresAt, input.now),
      ];
      if (input.companyId) conditions.push(eq(agentRuntimeDecisions.companyId, input.companyId));
      return db
        .select()
        .from(agentRuntimeDecisions)
        .where(and(...conditions))
        .orderBy(asc(agentRuntimeDecisions.expiresAt))
        .limit(input.limit);
    },
    /**
     * ★★★ BRW-004 (E8-F002) — THE HAZARD TYPESCRIPT CANNOT SEE.
     *
     * This is an INNER JOIN on `run_id`. Making that column nullable does not produce a type
     * error here, does not produce a runtime error, and does not produce a wrong row: it
     * SILENTLY EXCLUDES every distributed decision from the stranded-answer sweep. A hole,
     * not a crash — which is strictly worse, because nothing reports it.
     *
     * ★ It is CORRECT that they are excluded, and the join is left as the join. This sweep
     * exists to catch an answer whose HEARTBEAT RUN went terminal before the in-band relay
     * could deliver it (`index.ts`'s R2 sweep). A distributed decision has no heartbeat run
     * and no in-band relay, so this sweep has nothing to say about it.
     *
     * ★★ BUT THAT MEANS A DISTRIBUTED DECISION HAS NO STRANDED-ANSWER SWEEP AT ALL, and the
     * equivalent — noticing that the job/attempt went terminal before the queued
     * `runtime_decision_result` was delivered — does not exist anywhere yet. It cannot: no
     * control-plane hop delivers a control command to a running worker (BRW-004 terrain §4),
     * so there is no delivery to be stranded from. Tracked as E8-F004; the sweep belongs
     * beside JOB-015's delivery hop, not in front of it. Recorded here rather than left as an
     * unexplained absence, because an exclusion nobody wrote down is an exclusion nobody
     * finds.
     */
    async listStrandedAnswers(input) {
      const conditions = [
        inArray(agentRuntimeDecisions.status, ["answered", "relay_failed"]),
        inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
      ];
      if (input.companyId) conditions.push(eq(agentRuntimeDecisions.companyId, input.companyId));
      return db
        .select()
        .from(agentRuntimeDecisions)
        .innerJoin(heartbeatRuns, eq(agentRuntimeDecisions.runId, heartbeatRuns.id))
        .where(and(...conditions))
        .orderBy(asc(agentRuntimeDecisions.answeredAt))
        .limit(input.limit)
        .then((rows) => rows.map((row) => row.agent_runtime_decisions));
    },
  };
}

export function runtimeDecisionSourceSnapshot(row: AgentRuntimeDecisionRow | null): {
  terminal: boolean;
  title?: string | null;
  summary: string | null;
  permissionRevision: string | null;
} {
  if (!row) return { terminal: true, summary: null, permissionRevision: null };
  const status = row.status as RuntimeDecisionStatus;
  return {
    // BUG-2 (2026-07-04): terminality tracks TERMINAL_STATUSES exactly. The old
    // isVisibleTimeoutFollowUp carve-out kept parked/escalated timeouts open in
    // Waiting-on-you forever (phantom answerable items). Escalate-visibility
    // (Decisions #105/#106, mechanism amended) now lives in a notifications-lane
    // agent_error follow-up emitted by expireDuePrompts; the follow-up summary
    // branch below is kept so pre-close refreshes still surface the timeout text.
    terminal: TERMINAL_STATUSES.has(status),
    title: row.title,
    summary: isVisibleTimeoutFollowUp(row)
      ? row.relayError ?? row.summary ?? row.promptText ?? null
      : row.summary ?? row.promptText ?? row.relayError ?? null,
    permissionRevision: String(row.sourceRevision),
  };
}

type TimeoutOutcome = {
  patch: Partial<typeof agentRuntimeDecisions.$inferInsert>;
  cancelsRun: boolean;
  parked: boolean;
};

function resolveExplicitDefault(row: AgentRuntimeDecisionRow):
  | { decision: RuntimeDecisionPermissionDecision }
  | { answer: Record<string, unknown> }
  | null {
  const options = Array.isArray(row.options) ? row.options : [];
  const def = options.find(
    (o): o is Record<string, unknown> =>
      Boolean(o) && typeof o === "object" && (o as Record<string, unknown>).isDefault === true,
  );
  if (!def) return null;
  const value = def.value;
  if (row.kind === "permission") {
    return typeof value === "string" &&
      value !== "allow_always" &&
      (RUNTIME_DECISION_PERMISSION_DECISIONS as readonly string[]).includes(value)
      ? { decision: value as RuntimeDecisionPermissionDecision }
      : null;
  }
  return { answer: { selected: value ?? null } };
}

function fallbackPolicyOutcome(
  row: AgentRuntimeDecisionRow,
  policy: RuntimeDecisionTimeoutPolicy,
  bumpRev: number,
  nowDate: Date,
): TimeoutOutcome {
  if (row.kind === "permission" && policy === "deny") {
    return {
      patch: { status: "answered", decision: "deny", answeredAt: nowDate, sourceRevision: bumpRev },
      cancelsRun: false,
      parked: false,
    };
  }
  if (policy === "park_run" || policy === "escalate") {
    return {
      patch: {
        status: "cancelled",
        relayError: policy === "escalate"
          ? "timeout policy escalated the run"
          : "timeout policy parked the run",
        expiresAt: null,
        sourceRevision: bumpRev,
      },
      cancelsRun: true,
      parked: true,
    };
  }
  return {
    patch: {
      status: policy === "cancel_run" ? "cancelled" : "expired",
      relayError: policy === "cancel_run" ? "timeout policy cancelled the run" : undefined,
      sourceRevision: bumpRev,
    },
    cancelsRun: policy === "cancel_run",
    parked: false,
  };
}

function timeoutOutcome(row: AgentRuntimeDecisionRow, nowDate: Date): TimeoutOutcome {
  const bumpRev = row.sourceRevision + 1;
  if (row.timeoutPolicy === "continue_with_default") {
    const def = resolveExplicitDefault(row);
    if (def) {
      return {
        patch: {
          status: "answered",
          decision: "decision" in def ? def.decision : null,
          answerPayload: "answer" in def ? def.answer : null,
          answeredAt: nowDate,
          sourceRevision: bumpRev,
        },
        cancelsRun: false,
        parked: false,
      };
    }
    return fallbackPolicyOutcome(row, defaultTimeoutPolicy(row.kind as RuntimeDecisionKind), bumpRev, nowDate);
  }
  return fallbackPolicyOutcome(row, row.timeoutPolicy as RuntimeDecisionTimeoutPolicy, bumpRev, nowDate);
}

export function agentRuntimeDecisionService(db: Db, deps: ServiceDeps = {}) {
  const repo = deps.repo ?? realRepo(db);
  const hub = deps.hubItems ?? hubItemsService(db);
  const activityLogger = deps.activityLogger ?? ((input: LogActivityInput) => logActivity(db, input));
  const runCanceller = deps.runCanceller;
  const now = deps.now ?? (() => new Date());
  // FU-25 default: lazily import the DB-backed matcher only when a permission
  // request is actually connector-tool-shaped (the pure `parseConnectorServerName`
  // gate at the call site fires first), so pure unit tests and every
  // non-connector permission prompt never touch the loader or the DB.
  const connectorAutoAllow: (input: ConnectorAutoAllowInput) => Promise<boolean> =
    deps.connectorAutoAllow ??
    (async (input) => {
      const { isConnectorToolAutoAllowed } = await import("./mcp-connectors-loader.js");
      return isConnectorToolAutoAllowed(db, input);
    });

  async function emitHubItem(decision: AgentRuntimeDecisionRow) {
    return hub.emit({
      companyId: decision.companyId,
      semanticType: "agent_runtime_decision",
      sourceType: SOURCE_TYPE,
      sourceId: decision.id,
      title: decision.title,
      summary: decision.summary ?? decision.promptText ?? decision.relayError ?? null,
      // ★★ BRW-004 (E8-F002) — a TYPE CLAIM must not outlive its referent. `relatedEntityId`
      // and `sourceActorId` are nullable columns and `hub-items.ts:339` guards the ancestry
      // lookup, so a null does not crash — it produces a hub item that DECLARES
      // relatedEntityType "heartbeat_run" and sourceActorType "agent" while pointing at
      // neither. A row that lies quietly is worse than one that throws, so the type is
      // dropped with the id rather than left asserting a run that does not exist.
      ...(decision.runId !== null
        ? ({ relatedEntityType: "heartbeat_run", relatedEntityId: decision.runId } as const)
        : {}),
      ...(decision.agentId !== null
        ? ({ sourceActorType: "agent", sourceActorId: decision.agentId } as const)
        : {}),
      priority: decision.status === "relay_failed" ? "urgent" : "high",
      sourcePermissionRevision: String(decision.sourceRevision),
    });
  }

  // BUG-2 push-close: archive the projected waiting-lane hub item on every
  // terminal transition (relayed / expired / cancelled) instead of waiting for
  // the next GET-path sweep. Always call AFTER emitHubItem — emit refreshes the
  // final relayError onto the still-open row; the close does not depend on emit
  // side-effects (emit() is change-aware and skips no-op side-effects).
  async function closeProjectedHubItem(decision: AgentRuntimeDecisionRow) {
    try {
      await hub.reconcile(decision.companyId, {
        sourceType: SOURCE_TYPE,
        sourceId: decision.id,
      });
    } catch (err) {
      // Best-effort: the decision flip is already durable; the GET-path sweep
      // reconciles on the next read. Never poison the terminal transition.
      logger.warn({ err, decisionId: decision.id }, "runtime decision hub-item close failed");
    }
  }

  // R2 safety: flip a stranded decision (answer against a dead run, or an
  // answered/relay_failed row the sweep found orphaned) to cancelled with an
  // honest relayError, then close its projected waiting-lane hub item. Used by
  // both the answerPrompt liveness gate and sweepStrandedAnswers. The status
  // guard admits answered/relay_failed only (the two non-terminal stall states);
  // a concurrent cancel/relay wins and this no-ops.
  async function cancelStrandedDecision(row: AgentRuntimeDecisionRow, relayError: string) {
    const cancelled = await repo.updateDecision(row.id, {
      status: "cancelled",
      relayError: safeText(relayError),
      expiresAt: null,
      sourceRevision: row.sourceRevision + 1,
    }, {
      sourceRevision: row.sourceRevision,
      statuses: ["created", "shown", "answered", "relay_failed"],
    });
    if (!cancelled) return null;
    await activityLogger({
      companyId: cancelled.companyId,
      actorType: "system",
      actorId: "runtime_decision_stranded_answer",
      action: "runtime_decision.cancelled",
      entityType: "agent_runtime_decision",
      entityId: cancelled.id,
      agentId: cancelled.agentId,
      runId: cancelled.runId,
      details: { sourceRevision: row.sourceRevision, relayError, priorStatus: row.status },
    });
    await emitHubItem(cancelled);
    await closeProjectedHubItem(cancelled);
    return cancelled;
  }

  async function createPrompt(input: CreatePromptInput) {
    // R1 zombie-decision guard: refuse to mint a decision for a run that is
    // already terminal (or whose row is gone). A zombie CLI that survived a
    // cancel POSTs to the hook route → this createPrompt; throwing conflict here
    // makes the hook route's catch map it to a DENY, so the zombie's tools are
    // refused instead of minting decisions that later expire into agent_error
    // noise (and cannot resurrect the run — the setRunStatus latch blocks that).
    // ★★★ BRW-004 (E8-F002) — THE GUARD IS SKIPPED WHEN THERE IS NO RUN, and getting this
    // wrong would have been the ticket's worst defect. `getRunStatus(null)` finds no row, the
    // `runStatus == null` arm fires, and EVERY distributed browser decision would be refused
    // at creation as "run is terminal". The typecheck would have been perfectly green: the
    // parameter widens to `string | null` without complaint. The result would be an approval
    // feature that refuses 100% of its own prompts — a dead lever that looks exactly like a
    // working fail-closed guard, which is the failure this programme names its worst.
    //
    // A distributed decision's liveness is the JOB FENCE, checked by the bridge before this
    // is ever reached, not a heartbeat run. There is nothing here to check, so nothing is.
    if (input.runId !== null) {
      const runStatus = await repo.getRunStatus(input.runId);
      if (runStatus == null || TERMINAL_RUN_STATUSES.has(runStatus)) {
        throw conflict("run is terminal");
      }
    }

    const nowDate = now();
    const matchingTrustRule = input.kind === "permission"
      ? (await repo.listTrustRules({ companyId: input.companyId, adapterType: input.adapterType }))
        .find((rule) => trustRuleMatchesPrompt(rule, input, nowDate))
      : null;

    // Is this permission request for a connector-shaped tool? The pure
    // `parseConnectorServerName` gate short-circuits (no DB work) for
    // non-connector tools (Bash, mcp__aoa__*, malformed names) and reserved names.
    const isConnectorShaped =
      input.kind === "permission" && parseConnectorServerName(input.toolName) !== null;

    // FU-25 connector auto-allow + Codex-3 live-probe gate: a permission request
    // for a connector-shaped tool is auto-allowed ONLY when the LIVE connector
    // probe passes — the connector is ACTIVE, assigned to this run's agent (or any
    // active connector for Commander), and D7-admissible. This is a scoped grant,
    // never a global bypass.
    //
    // Codex-3: the probe is evaluated for EVERY connector-shaped tool, including
    // ones with a matching trust rule. A prior "always allow" trust rule can no
    // longer override a connector the founder has since DISABLED or UNASSIGNED —
    // for connector-shaped tools the live probe is a precondition, and the trust
    // rule only sets the grant SCOPE when the probe also passes. Non-connector
    // tools are unaffected: their trust-rule behavior is byte-identical.
    //
    // Fail-safe: any probe error is swallowed and treated as a probe MISS, so the
    // request falls through to the human → timeout path (deny direction) — a probe
    // error never allows, and never lets a stale trust rule allow either.
    let connectorProbePassed = false;
    // BRW-004 (E8-F002): the probe is scoped to an AGENT's connector configuration. A
    // distributed browser decision has no agent, so there is nothing to probe and the request
    // falls through to the human/timeout path — the deny direction, which is the correct
    // default for a scope that does not exist rather than one that failed to load.
    if (isConnectorShaped && input.agentId !== null) {
      try {
        connectorProbePassed = await connectorAutoAllow({
          companyId: input.companyId,
          agentId: input.agentId,
          adapterType: input.adapterType,
          toolName: input.toolName ?? null,
        });
      } catch (err) {
        connectorProbePassed = false;
        logger.warn(
          { err, companyId: input.companyId, agentId: input.agentId, toolName: input.toolName },
          "connector auto-allow probe failed; falling through to trust-rule/human decision",
        );
      }
    }

    // A trust rule is honored (mints an auto-answered ALLOW at its own scope) only
    // when it matches AND — for connector-shaped tools — the live connector probe
    // passes. This is the whole Codex-3 fix: a matching trust rule alone can no
    // longer auto-allow a connector-shaped tool whose connector is gone.
    const trustRuleHonored =
      matchingTrustRule != null && (!isConnectorShaped || connectorProbePassed);
    // A connector-only grant (no trust rule) mints `allow_once` — a single-call
    // allow that creates NO persistent trust rule (re-derived from connector state
    // each call).
    const connectorGrant = connectorProbePassed && !trustRuleHonored;
    const autoAllowed = trustRuleHonored || connectorGrant;
    const resolvedExpiresAt =
      input.expiresAt ?? new Date(nowDate.getTime() + defaultTtlMs(input.kind));
    const created = await repo.createDecision({
      companyId: input.companyId,
      agentId: input.agentId,
      runId: input.runId,
      adapterType: input.adapterType,
      adapterSessionId: input.adapterSessionId ?? null,
      adapterSessionParams: redactEventPayload(input.adapterSessionParams ?? null),
      kind: input.kind,
      status: autoAllowed ? "answered" : "created",
      nonce: input.nonce,
      sourceRevision: autoAllowed ? 1 : 0,
      promptHash: promptHash(input),
      sourceUniqueKey: sourceUniqueKey(input),
      title: safeText(input.title) ?? "Runtime decision",
      summary: safeText(input.summary),
      promptText: safeText(input.promptText),
      toolName: safeText(input.toolName),
      command: safeText(input.command),
      commandHash: commandHash(input.command),
      cwd: safeText(input.cwd),
      path: safeText(input.path),
      networkTarget: safeText(input.networkTarget),
      riskClass: input.riskClass ?? null,
      options: input.options ? redactJsonSecrets(input.options) as Array<Record<string, unknown>> : null,
      expiresAt: resolvedExpiresAt,
      timeoutPolicy: input.timeoutPolicy,
      decision: trustRuleHonored && matchingTrustRule
        ? matchingTrustRule.grantScope === "run" ? "allow_run" : "allow_always"
        : connectorGrant
          ? "allow_once"
          : null,
      answeredByUserId: trustRuleHonored && matchingTrustRule ? matchingTrustRule.createdByUserId ?? null : null,
      answeredAt: autoAllowed ? nowDate : null,
    });
    if (!autoAllowed && (TERMINAL_STATUSES.has(created.status as RuntimeDecisionStatus) || created.status === "answered")) {
      throw conflict("Runtime decision prompt already consumed for this nonce");
    }
    if (trustRuleHonored && matchingTrustRule) {
      await repo.markTrustRuleUsed({ ruleId: matchingTrustRule.id, usedAt: now() });
    }
    if (connectorGrant) {
      // Durable audit trail for a human-less allow: the grant is re-derived from
      // connector state on every call, so there is no trust-rule row to inspect —
      // this activity entry is the only record that the broker allowed it.
      await activityLogger({
        companyId: input.companyId,
        actorType: "system",
        actorId: "runtime_decision_connector_auto_allow",
        action: "runtime_decision.connector_auto_allowed",
        entityType: "agent_runtime_decision",
        entityId: created.id,
        agentId: input.agentId,
        runId: input.runId,
        details: { toolName: input.toolName ?? null, adapterType: input.adapterType },
      });
    }
    const hubItem = await emitHubItem(created);
    return { decision: created, hubItem };
  }

  async function createTrustRule(input: CreateTrustRuleInput) {
    if (!hasConcreteTrustScope(input)) {
      throw unprocessable("Allow always requires a concrete command, path, network, or risk scope");
    }
    const rule = await repo.createTrustRule({
      companyId: input.companyId,
      agentId: input.agentId,
      runId: null,
      grantScope: "persistent",
      adapterType: input.adapterType,
      toolName: input.toolName ?? null,
      commandHash: input.commandHash ?? commandHash(input.command),
      pathScope: input.pathScope ?? null,
      networkScope: input.networkScope ?? null,
      riskClass: input.riskClass ?? null,
      enabled: true,
      expiresAt: input.expiresAt ?? new Date(now().getTime() + TRUST_RULE_DEFAULT_TTL_MS),
      createdByUserId: input.createdByUserId,
    });
    await activityLogger({
      companyId: input.companyId,
      actorType: "user",
      actorId: input.createdByUserId,
      action: "runtime_decision_trust_rule.created",
      entityType: "agent_runtime_trust_rule",
      entityId: rule.id,
      details: {
        agentId: input.agentId,
        adapterType: input.adapterType,
        toolName: input.toolName ?? null,
        hasCommandScope: Boolean(input.command),
        pathScope: input.pathScope ?? null,
        networkScope: input.networkScope ?? null,
        riskClass: input.riskClass ?? null,
      },
    });
    return rule;
  }

  async function listTrustRules(input: { companyId: string; adapterType?: string; includeDisabled?: boolean }) {
    return repo.listTrustRules(input);
  }

  async function revokeTrustRule(input: { companyId: string; ruleId: string; actorUserId: string }) {
    const rule = await repo.revokeTrustRule({ companyId: input.companyId, ruleId: input.ruleId });
    if (!rule) throw notFound("Runtime decision trust rule not found");
    await activityLogger({
      companyId: input.companyId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "runtime_decision_trust_rule.revoked",
      entityType: "agent_runtime_trust_rule",
      entityId: rule.id,
      details: { adapterType: rule.adapterType, toolName: rule.toolName },
    });
    return rule;
  }

  async function getDetail(companyId: string, decisionId: string) {
    const row = await repo.getDecision(companyId, decisionId);
    if (!row) throw notFound("Runtime decision prompt not found");
    return runtimeDecisionDetail(row);
  }

  async function loadActive(companyId: string, decisionId: string) {
    const row = await repo.getDecision(companyId, decisionId);
    if (!row) throw notFound("Runtime decision prompt not found");
    if (!ACTIVE_STATUSES.has(row.status as RuntimeDecisionStatus)) {
      throw conflict("Runtime decision prompt is no longer actionable");
    }
    return row;
  }

  function assertAnswerMatches(row: AgentRuntimeDecisionRow, input: AnswerPromptInput) {
    if (row.nonce !== input.nonce) throw conflict("Runtime decision nonce mismatch");
    if (row.sourceRevision !== input.expectedSourceRevision) {
      throw conflict("Runtime decision source revision mismatch");
    }
    if (row.kind !== input.kind) throw conflict("Runtime decision kind mismatch");
    if (input.kind === "permission") {
      if (!input.decision || !RUNTIME_DECISION_PERMISSION_DECISIONS.includes(input.decision)) {
        throw unprocessable("Permission runtime decisions require an allow/deny decision");
      }
      return;
    }
    if (!input.answer || input.decision) {
      throw unprocessable("Work-question runtime decisions require an answer payload");
    }
  }

  async function answerPrompt(input: AnswerPromptInput) {
    const row = await repo.getDecision(input.companyId, input.decisionId);
    if (!row) throw notFound("Runtime decision prompt not found");
    if ((row.status === "answered" || row.status === "relayed") && isIdempotentAnswerReplay(row, input)) {
      return row;
    }
    if (!ACTIVE_STATUSES.has(row.status as RuntimeDecisionStatus)) {
      throw conflict("Runtime decision prompt is no longer actionable");
    }
    assertAnswerMatches(row, input);
    if (input.kind === "permission" && input.decision === "allow_always" && !hasConcreteTrustScope(row)) {
      throw unprocessable("Allow always requires a concrete command, path, network, or risk scope");
    }
    if (input.kind === "permission" && input.decision === "allow_run") {
      const eligibility = runtimeRunGrantEligibility(row);
      if (!eligibility.eligible) throw unprocessable(eligibility.reason ?? "Run access is unavailable for this action");
    }
    // ★★★ BRW-004 (E8-F002) — THE TENTH NULL-HAZARD. `hasConcreteTrustScope` above is satisfied
    // by `riskClass` OR `networkTarget` alone, and slice (c) sets both on every browser
    // navigation — so this is the line the guard below stands in front of. A standing grant
    // built from an UNBOUND decision would be scoped to no agent, and an unbound rule was a
    // company-wide wildcard. See `standingGrantBinding`.
    //
    // The trust rule is BUILT HERE rather than at the write site because building it IS the
    // admission check: there is exactly one call to `standingGrantBinding`, both builders demand
    // the narrowed `string` it returns, and so a later edit cannot write a rule without it.
    const trustRule =
      input.kind === "permission" && (input.decision === "allow_always" || input.decision === "allow_run")
        ? buildStandingGrant(row, input.decision, input.actorUserId, now())
        : null;
    // R2 answer-time liveness gate (safety fix): the answer is relayed to the
    // run in-band by the broker (heartbeat waitAndRelay). If the run already
    // went terminal (or its row is gone), recording "answered" would mint a
    // forever-stalled ghost — non-terminal, invisible to the expiry sweep, never
    // relayable. Instead, cancel the decision honestly and 409 so the founder
    // sees a real error rather than a phantom "answered" item.
    // ★★★ BRW-004 (E8-F002) — the ANSWER-side twin of the createPrompt guard, and just as
    // lethal: with a null `runId` the `runStatus == null` arm fires, so every founder answer
    // to a browser prompt would be cancelled-and-409'd. The prompt could be raised and never
    // answered. Skipped when there is no run, for the same reason: a distributed decision's
    // liveness is the job fence, and the in-band heartbeat relay this gate protects does not
    // exist for it.
    if (row.runId !== null) {
      const runStatus = await repo.getRunStatus(row.runId);
      if (runStatus == null || TERMINAL_RUN_STATUSES.has(runStatus)) {
        await cancelStrandedDecision(row, "run ended before the answer could be delivered");
        throw conflict("run ended before the answer could be delivered");
      }
    }
    const answerPatch: Partial<typeof agentRuntimeDecisions.$inferInsert> = {
      status: "answered",
      decision: input.kind === "permission" ? input.decision : null,
      answerPayload: input.kind === "work_question" ? input.answer : null,
      answerIdempotencyKey: input.idempotencyKey ?? null,
      answeredByUserId: input.actorUserId,
      answeredAt: now(),
      sourceRevision: row.sourceRevision + 1,
    };
    const guard = {
      sourceRevision: row.sourceRevision,
      statuses: ["created", "shown", "relay_failed"] as RuntimeDecisionStatus[],
    };

    let answered: AgentRuntimeDecisionRow | null;
    if (trustRule !== null) {
      const result = await repo.answerWithTrustRule(row.id, answerPatch, guard, trustRule);
      answered = result.decision;
      if (answered && result.rule) {
        await activityLogger({
          companyId: input.companyId,
          actorType: "user",
          actorId: input.actorUserId,
          action: input.decision === "allow_run"
            ? "runtime_decision_run_grant.created"
            : "runtime_decision_trust_rule.created",
          entityType: "agent_runtime_trust_rule",
          entityId: result.rule.id,
          runId: result.rule.runId ?? undefined,
          details: {
            agentId: result.rule.agentId,
            adapterType: result.rule.adapterType,
            toolName: result.rule.toolName,
            pathScope: result.rule.pathScope,
            networkScope: result.rule.networkScope,
            riskClass: result.rule.riskClass,
            expiresAt: result.rule.expiresAt?.toISOString() ?? null,
            grantScope: result.rule.grantScope,
            runId: result.rule.runId,
          },
        });
      }
    } else {
      answered = await repo.updateDecision(row.id, answerPatch, guard);
    }
    if (!answered) throw conflict("Runtime decision prompt was already answered");
    await activityLogger({
      companyId: row.companyId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "runtime_decision.answered",
      entityType: "agent_runtime_decision",
      entityId: row.id,
      agentId: row.agentId,
      runId: row.runId,
      details: {
        kind: row.kind,
        decision: input.kind === "permission" ? input.decision : null,
        sourceRevision: row.sourceRevision,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });
    await emitHubItem(answered);
    return answered;
  }

  async function waitForAnswer(input: WaitForAnswerInput) {
    const startedAt = Date.now();
    const pollIntervalMs = Math.max(0, input.pollIntervalMs ?? 1000);
    for (;;) {
      const row = await repo.getDecision(input.companyId, input.decisionId);
      if (!row) throw notFound("Runtime decision prompt not found");
      if (row.status === "answered") return row;
      if (row.status === "cancelled") {
        throw new RuntimeDecisionCancelledError(row);
      }
      if (TERMINAL_STATUSES.has(row.status as RuntimeDecisionStatus)) {
        throw conflict("Runtime decision prompt is no longer actionable");
      }
      if (input.timeoutMs != null && Date.now() - startedAt >= input.timeoutMs) {
        throw conflict("Timed out waiting for runtime decision answer");
      }
      await sleep(pollIntervalMs);
    }
  }

  async function markRelayFailed(input: RelayFailedInput) {
    const row = await loadActive(input.companyId, input.decisionId);
    const failed = await repo.updateDecision(row.id, {
      status: "relay_failed",
      relayError: safeText(input.relayError),
      sourceRevision: row.sourceRevision + 1,
    }, {
      sourceRevision: row.sourceRevision,
      statuses: ["answered"],
    });
    if (!failed) {
      return throwRelayTransitionConflict(input.companyId, input.decisionId, "Runtime decision prompt changed before relay failure could be recorded");
    }
    await activityLogger({
      companyId: failed.companyId,
      actorType: "system",
      actorId: "runtime_decision_relay",
      action: "runtime_decision.relay_failed",
      entityType: "agent_runtime_decision",
      entityId: failed.id,
      agentId: failed.agentId,
      runId: failed.runId,
      details: { sourceRevision: row.sourceRevision, relayError: input.relayError },
    });
    await emitHubItem(failed);
    return failed;
  }

  async function markRelayed(input: { companyId: string; decisionId: string }) {
    const row = await loadActive(input.companyId, input.decisionId);
    const relayed = await repo.updateDecision(row.id, {
      status: "relayed",
      relayedAt: now(),
      sourceRevision: row.sourceRevision + 1,
    }, {
      sourceRevision: row.sourceRevision,
      statuses: ["answered"],
    });
    if (!relayed) {
      return throwRelayTransitionConflict(input.companyId, input.decisionId, "Runtime decision prompt changed before relay could be recorded");
    }
    await activityLogger({
      companyId: relayed.companyId,
      actorType: "system",
      actorId: "runtime_decision_relay",
      action: "runtime_decision.relayed",
      entityType: "agent_runtime_decision",
      entityId: relayed.id,
      agentId: relayed.agentId,
      runId: relayed.runId,
      details: { sourceRevision: row.sourceRevision },
    });
    await emitHubItem(relayed);
    await closeProjectedHubItem(relayed);
    return relayed;
  }

  async function throwRelayTransitionConflict(companyId: string, decisionId: string, message: string): Promise<never> {
    const current = await repo.getDecision(companyId, decisionId);
    if (current?.status === "cancelled") {
      throw new RuntimeDecisionCancelledError(current);
    }
    throw conflict(message);
  }

  async function expireDuePrompts(input: ExpireDueInput) {
    const nowDate = now();
    const due = await repo.listDueForExpiry({ companyId: input.companyId, now: nowDate, limit: input.limit });
    let expired = 0;
    let processed = 0;
    for (const row of due) {
      const outcome = timeoutOutcome(row, nowDate);
      const updated = await repo.updateDecision(row.id, outcome.patch, {
        sourceRevision: row.sourceRevision,
        statuses: ["created", "shown"],
      });
      if (!updated) continue;
      processed += 1;
      await activityLogger({
        companyId: updated.companyId,
        actorType: "system",
        actorId: "runtime_decision_timeout",
        action: outcome.parked ? "runtime_decision.timeout_parked" : "runtime_decision.expired",
        entityType: "agent_runtime_decision",
        entityId: updated.id,
        agentId: updated.agentId,
        runId: updated.runId,
        details: { sourceRevision: row.sourceRevision, timeoutPolicy: row.timeoutPolicy },
      });
      await emitHubItem(updated);
      if (outcome.parked) {
        // Escalate-visible (Decisions #105/#106): the waiting-lane item closes, so
        // surface WHAT HAPPENED as a notifications-lane item instead.
        await hub.emit({
          companyId: updated.companyId,
          semanticType: "agent_error",
          sourceType: SOURCE_TYPE,
          sourceId: updated.id,
          title: `Permission request timed out: ${updated.title}`,
          summary: updated.relayError ?? "timeout policy parked the run",
          // Same rule as the projection above: no run, no "heartbeat_run" claim.
          ...(updated.runId !== null
            ? ({ relatedEntityType: "heartbeat_run", relatedEntityId: updated.runId } as const)
            : {}),
          ...(updated.agentId !== null
            ? ({ sourceActorType: "agent", sourceActorId: updated.agentId } as const)
            : {}),
          priority: "high",
        });
      }
      // Deny-timeout flips to "answered" (non-terminal) — the close is a safe
      // no-op there (reconcile refreshes, never archives a live source).
      await closeProjectedHubItem(updated);
      // BRW-004 (E8-F002): `cancelsRun` means cancel the HEARTBEAT run. A distributed decision
      // has none, and the injected canceller is `heartbeatService.cancelRun` — passing it a
      // null would be a cancellation aimed at nothing, silently swallowed by the catch below
      // and indistinguishable from a successful cancel. The distributed cancellation path is
      // the control command the bridge queues, which is JOB-015's to deliver.
      if (outcome.cancelsRun && updated.runId !== null) {
        try {
          await runCanceller?.({
            companyId: updated.companyId,
            runId: updated.runId,
            reason: updated.relayError ?? "runtime decision timeout policy cancelled the run",
          });
        } catch (err) {
          // Run may already be gone (FK cascade / purge); the decision row is
          // already flipped (durable effect). Log so a real DB failure during
          // cancellation isn't masked, but don't poison the batch.
          logger.warn({ err, runId: updated.runId }, "runtime decision timeout run cancellation failed");
        }
      }
      if (!outcome.parked) expired += 1;
    }
    return { expired, processed };
  }

  async function cancelActiveForRun(input: { companyId: string; runId: string; reason: string }) {
    const active = await repo.listActiveForRun({ companyId: input.companyId, runId: input.runId });
    let cancelled = 0;
    for (const row of active) {
      const updated = await repo.updateDecision(row.id, {
        status: "cancelled",
        relayError: safeText(input.reason),
        sourceRevision: row.sourceRevision + 1,
      }, {
        sourceRevision: row.sourceRevision,
        statuses: ["created", "shown", "answered", "relay_failed"],
      });
      if (!updated) continue;
      await activityLogger({
        companyId: updated.companyId,
        actorType: "system",
        actorId: "runtime_decision_run_cleanup",
        action: "runtime_decision.cancelled",
        entityType: "agent_runtime_decision",
        entityId: updated.id,
        agentId: updated.agentId,
        runId: updated.runId,
        details: { sourceRevision: row.sourceRevision, reason: input.reason },
      });
      await emitHubItem(updated);
      await closeProjectedHubItem(updated);
      cancelled += 1;
    }
    const runRules = (await repo.listTrustRules({ companyId: input.companyId, includeDisabled: false }))
      .filter((rule) => rule.grantScope === "run" && rule.runId === input.runId);
    for (const rule of runRules) {
      const revoked = await repo.revokeTrustRule({ companyId: input.companyId, ruleId: rule.id });
      if (!revoked) continue;
      await activityLogger({
        companyId: input.companyId,
        actorType: "system",
        actorId: "runtime_decision_run_cleanup",
        action: "runtime_decision_run_grant.expired",
        entityType: "agent_runtime_trust_rule",
        entityId: rule.id,
        runId: input.runId,
        details: { reason: input.reason },
      });
    }
    return { cancelled, expiredRunGrants: runRules.length };
  }

  // R2 stranded-answer sweep (P3-4): a decision that reached answered/relay_failed
  // but whose run went terminal before the broker could relay is invisible to the
  // expiry sweep (listDueForExpiry is hard-scoped to created/shown). Select those
  // rows joined to a terminal run and cancel + close each, so the founder's
  // waiting-lane item does not linger forever as an un-relayable ghost. Runs next
  // to expireDuePrompts on the same 30s interval.
  async function sweepStrandedAnswers(input: { companyId?: string; limit: number }) {
    const stranded = await repo.listStrandedAnswers({ companyId: input.companyId, limit: input.limit });
    let cancelled = 0;
    for (const row of stranded) {
      const result = await cancelStrandedDecision(row, "answer was never picked up by the run");
      if (result) cancelled += 1;
    }
    return { cancelled, processed: stranded.length };
  }

  return {
    createPrompt,
    createTrustRule,
    listTrustRules,
    revokeTrustRule,
    getDetail,
    answerPrompt,
    waitForAnswer,
    markRelayFailed,
    markRelayed,
    expireDuePrompts,
    sweepStrandedAnswers,
    cancelActiveForRun,
    emitHubItemForPrompt: emitHubItem,
  };
}
