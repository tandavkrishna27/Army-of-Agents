import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  costEvents,
  environments,
  issues,
  goals,
  memoryItems,
  companies,
  taskDependencies,
  issueAttachments,
  issueComments,
  assets,
  projects,
  companySkills,
  teamMembers,
  teamCoordinations,
  teams,
  discussions,
  executionWorkspaces,
  internalAgentConfig,
  workQuestions,
} from "@armyofagents/db";
import { resolveEnvironmentRuntimeConfig } from "./environment-resolver.js";
import {
  resolveExecutionTargetForRun,
  executionTargetToAdapterConfig,
} from "./execution-target-resolver.js";
import {
  mergeResolvedExecutionTarget,
  handleExecutionTargetRoutingError,
  resolveHeartbeatExecutionTargetOrganizationId,
} from "./heartbeat-execution-target.js";
import type { TrustBoundary } from "./cli-auth-topology.js";
import { assertUnsandboxedMultitenantAllowed } from "./unsandboxed-multitenant-guard.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import {
  claimQueuedRunsWithOrgCapacity,
  HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT,
  HEARTBEAT_MAX_CONCURRENT_RUNS_MAX,
  normalizeMaxConcurrentRuns,
  resolveCompanyOrganizationId,
  runClaimMirrorsBestEffort,
} from "./org-concurrency.js";
import type { EnvironmentAcquisitionResult } from "./environment-run-orchestrator.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { acquireExecutionContext } from "./acquire-execution-context.js";
import { instanceSettingsService } from "./instance-settings.js";
import { resolveWarmSandboxPreference, readAgentWarmOverride } from "./warm-sandbox-policy.js";
import { conflict, notFound, HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent, threadWorkingAgents, broadcastThreadPresence } from "./live-events.js";
import {
  buildCurrentTaskMarkdown,
  buildWakeCommentMarkdown,
  buildWorkQuestionContinuationMarkdown,
} from "./heartbeat-task-context.js";
import { bindHeartbeatWorkQuestionContinuation } from "./work-question-continuation-terminal.js";
import { postCrewFailureCard } from "./crew-failure-card.js";
import { relayCrewResult } from "./crew-result-relay.js";
import { buildTerminalRunHubEmit, emitHubItem } from "./hub-source-producers.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import { logActivity } from "./activity-log.js";
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterSessionCodec } from "../adapters/index.js";
import { getProviderStatus, type ProviderStatus } from "../adapters/provider-status.js";
import { realProviderStatusDeps } from "../adapters/provider-status-deps.js";
import { resolveRunScopedModel } from "./heartbeat-provider-resolution.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { parseObject, asBoolean, asNumber, appendWithCap, MAX_EXCERPT_BYTES, sanitizeForDb } from "../adapters/utils.js";
import { companySkillService } from "./company-skills.js";
import type { RuntimeSkillEntry } from "./company-skills.js";
import { buildPinnedMemorySkillEntries } from "./memory-skill-sync.js";
import { memoryService, type MultiPathSearchResult } from "./memory.js";
import { recordMemoryRetrievals } from "./memory-retrieval-audit.js";
import { actorForAgentRun, memoryAccessConditions } from "./memory-access-sql.js";
import { filterMemoryForActor } from "./memory-access.js";
import { resolveRunMemoryScope } from "./memory-run-scope.js";
import { buildAlwaysOnCore } from "./memory-core-block.js";
import { issueService as createIssueService } from "./issues.js";
import { quotaWindowsService } from "./quota-windows.js";
import { extractSkillMentionIds } from "@armyofagents/shared";
import {
  readAoaSkillSyncPreference,
  writeAoaSkillSyncPreference,
  signalRunningProcess,
} from "@armyofagents/adapter-utils/server-utils";
import type {
  AdapterRuntimeDecisionBroker,
  AdapterRuntimeDecisionPromptBase,
  AdapterRuntimePermissionDecision,
  AdapterRuntimeServiceReport,
  McpServerSpec,
} from "@armyofagents/adapter-utils";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import { buildRunInputBundle } from "./run-input-bundles.js";
import { redactAndCapPrompt } from "./prompt-snapshot.js";
import {
  cancelCrewRunsForAgent,
  cancelCrewRunsForCompany,
} from "./crew-cancellation.js";
import {
  agentRuntimeDecisionService,
  defaultTimeoutPolicy,
  RuntimeDecisionCancelledError,
  type AgentRuntimeDecisionRow,
} from "./agent-runtime-decisions.js";
import { resolveBridgeEntrypoint } from "./internal-agent/aoa-agents/bridge-path.js";
import {
  ORG_HEARTBEAT_ENABLED_CAPABILITIES,
  ORG_HEARTBEAT_TOOL_ALLOWLIST,
  prepareHeartbeatMcpDelivery,
  resolveHeartbeatEffectiveAutonomy,
} from "./heartbeat-mcp.js";
import { loadConnectorEgressHosts, resolveAgentConnectors } from "./mcp-connectors-loader.js";
import { adapterSupportsConnectors } from "./mcp-connectors.js";

export {
  cancelCrewRunsForAgent,
  cancelCrewRunsForCompany,
} from "./crew-cancellation.js";

import { setSecretResolver } from "../adapters/api-common.js";
import { secretService } from "./secrets.js";
import {
  resolveRuntimeSessionParamsForWorkspace,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRun,
} from "./heartbeat-session.js";
import {
  resolveExecutionWorkspacePolicyInputs,
  resolveWorkspaceForRun as resolveWorkspaceForRunShared,
} from "./workspace-resolution.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { outputDetectionService } from "./output-detection.js";
import { collectSandboxDiff, type SandboxFileMovementRunner } from "./sandbox-file-movement.js";
import {
  mayUseLegacySubscriptionHome,
  resolveAgentSubscriptionEnvironment,
} from "./provider-credential-bindings.js";
import { postRunSummaryComment } from "./run-summary-comment.js";
import { emitSandboxPreviewTaskOutput } from "./task-output-emitters.js";
import {
  buildWorkspaceReadyComment,
  cleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
} from "./workspace-runtime.js";
import {
  buildPreviewDetectionText,
  createLivePreviewDetectionScheduler,
  detectPreviewRuntimeServiceReports,
  extractLoopbackPreviewUrls,
  shouldDetectAoaAppPreviews,
} from "./runtime-service-preview-detection.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { selectConcurrentPersistedExecutionWorkspace } from "./execution-workspace-race.js";
import { workspaceOperationService } from "./workspace-operations.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  resolveDeliverableWorkspaceMode,
} from "./execution-workspace-policy.js";
import {
  findActiveThreadWorkspace,
  resolveThreadDeliverableWorkspace,
} from "./heartbeat-thread-workspace.js";
import { finalizeHeartbeatWorkQuestionContinuation } from "./work-question-continuation-terminal.js";
import {
  hasSessionCompactionThresholds,
  resolveAdapterExecutionTarget,
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "@armyofagents/adapter-utils";
import { resolveCheapFallbackModel } from "./cheap-fallback.js";
import { isCheapRecoveryWake, resolveRecoveryCheapModel } from "./recovery/model-profile-hint.js";
import {
  buildHeartbeatRunStopMetadata,
  mergeHeartbeatRunStopMetadata,
  normalizeMaxTurnStopReason,
} from "./heartbeat-stop-metadata.js";
import { productivityReviewService } from "./productivity-review.js";
import { recoveryService } from "./recovery/service.js";
import type { ServerAdapterModule } from "../adapters/types.js";
import {
  mintRuntimeHookToken,
  registerRuntimeHook,
  deregisterRuntimeHook,
  deregisterRuntimeHooksForRun,
} from "./runtime-hook-registry.js";
import {
  RUNTIME_HOOK_BLOCK_TIMEOUT_SEC,
  RUNTIME_HOOK_PATH,
} from "@armyofagents/adapter-utils";
import { resolveRuntimeDecisionRoutingEnabled } from "./runtime-decision-routing-flag.js";

/**
 * Resolve the base URL the claude_local PreToolUse runtime-permission hook
 * (W5c HTTP hook bridge) uses to call back into the control plane.
 *
 * Host-local (unsandboxed) runs can reach the control plane over loopback, so
 * the `http://127.0.0.1:${port}` fallback is preserved exactly when `apiUrl`
 * is empty — this keeps desktop behavior unchanged.
 *
 * Brokered (sandboxed, e.g. E2B) runs execute inside a VM that cannot reach
 * the host's loopback interface — for those, a routable `AOA_API_URL` is
 * REQUIRED. Rather than silently minting an unreachable loopback URL, this
 * throws (fail-before-spend).
 *
 * `apiUrl` is expected to already be `.trim()`ed by the caller (mirrors the
 * existing inlined `process.env.AOA_API_URL?.trim() || ...` call sites).
 */
export function resolveRuntimeHookBaseUrl(input: {
  apiUrl: string;
  port: string;
  brokered: boolean;
}): string {
  const { apiUrl, port, brokered } = input;
  if (brokered) {
    if (!apiUrl) {
      throw new Error("AOA_API_URL required for sandboxed runtime hook");
    }
    if (isLoopbackApiUrl(apiUrl)) {
      // A brokered run executes in a VM that cannot reach the host loopback, so a
      // localhost/127.0.0.1 base URL means the sandbox can NEVER reach the broker.
      // Fail before spending a sandbox rather than silently failing every MCP call.
      throw new Error(
        `AOA_API_URL for a sandboxed (brokered) run must be reachable from the sandbox VM, ` +
          `but is a loopback URL (${apiUrl}). On cloud_auth set a public AOA_API_URL / auth.publicBaseUrl.`,
      );
    }
    return apiUrl;
  }
  return apiUrl || `http://127.0.0.1:${port}`;
}

/** A brokered sandbox VM cannot reach these hosts on the control plane. */
export function isLoopbackApiUrl(apiUrl: string): boolean {
  let host: string;
  try {
    host = new URL(apiUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false; // unparseable → not our job to validate syntax here
  }
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host.startsWith("127.") ||
    host.endsWith(".localhost")
  );
}

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
export {
  HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT,
  HEARTBEAT_MAX_CONCURRENT_RUNS_MAX,
  normalizeMaxConcurrentRuns,
};
export const MAX_TURN_CONTINUATION_RETRY_REASON = "max_turn_continuation";
export const MAX_TURN_CONTINUATION_WAKE_REASON = "max_turn_continuation_retry";
export const MAX_TURN_CONTINUATION_MAX_ATTEMPTS = 2;
export const MAX_TURN_CONTINUATION_DELAY_MS = 1_000;
// R1 zombie-run teardown: once a run reaches one of these statuses it is final.
// setRunStatus latches on them so a zombie hook POST (markRunWaiting → 'running')
// or a late adapter completion cannot resurrect a cancelled/failed run. The only
// writes allowed after a terminal transition are metadata-only patches that keep
// the SAME status (e.g. the cancelled→cancelled usageJson/excerpt persistence in
// the completion + error paths).
export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * Pure decision for the setRunStatus terminal-latch fallback branch (R1).
 *
 * Called only when the guarded conditional UPDATE matched no row — i.e. the run
 * is already terminal (or missing). Given the requested status, the patch, and
 * the current (terminal) status, decide what write to apply:
 *
 *   - `"metadata"`: strip `status` from the patch and apply the remaining fields
 *     WITHOUT changing status, and WITHOUT re-firing the live event / terminal
 *     hub emit. Covers BOTH the legitimate cancelled→cancelled metadata write
 *     (usageJson / log excerpts persist — P2-1) and the blocked cancelled→running
 *     / cancelled→failed resurrection (status stays terminal).
 *   - `"noop"`: a pure status flip against a terminal row with no other fields —
 *     nothing to persist.
 *
 * Never returns "write": once the row is terminal, the status is latched.
 */
const NON_CONTRADICTORY_TERMINAL_METADATA_KEYS = new Set([
  "usageJson",
  "stdoutExcerpt",
  "stderrExcerpt",
  "logBytes",
  "logSha256",
  "logCompressed",
]);

export function resolveTerminalLatchFallback(
  patch: Record<string, unknown> | undefined,
  context?: { requestedStatus?: string; currentStatus?: string | null },
): { action: "metadata"; metadataPatch: Record<string, unknown> } | { action: "noop" } {
  const metadataPatch: Record<string, unknown> = patch ? { ...patch } : {};
  delete metadataPatch.status;
  if (Object.keys(metadataPatch).length === 0) return { action: "noop" };

  const requestedStatus = context?.requestedStatus;
  const currentStatus = context?.currentStatus ?? null;
  if (
    requestedStatus &&
    currentStatus &&
    isTerminalRunStatus(requestedStatus) &&
    isTerminalRunStatus(currentStatus) &&
    requestedStatus !== currentStatus
  ) {
    const safePatch = Object.fromEntries(
      Object.entries(metadataPatch).filter(([key]) => NON_CONTRADICTORY_TERMINAL_METADATA_KEYS.has(key)),
    );
    if (Object.keys(safePatch).length === 0) return { action: "noop" };
    return { action: "metadata", metadataPatch: safePatch };
  }

  return { action: "metadata", metadataPatch };
}

const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
const DEFERRED_WAKE_CONTEXT_KEY = "_aoaWakeContext";
// Context key set during executeRun when the harness pre-claims the issue via
// issueService.checkout. Downstream (renderAoaWakePrompt) reads this from the
// wake payload to suppress the redundant /issues/{id}/checkout agent call.
const AOA_HARNESS_CHECKOUT_KEY = "aoaHarnessCheckedOut";

export function classifyCompletedRunLiveness(input: { outcome: string; waitingQuestionId?: string | null }) {
  if (input.waitingQuestionId) {
    return {
      livenessState: "waiting_on_human",
      livenessReason: "work_question",
      nextAction: `work_question:${input.waitingQuestionId}`,
    };
  }
  if (input.outcome === "succeeded") {
    return { livenessState: "advanced", livenessReason: "adapter_succeeded" };
  }
  return { livenessState: "stalled", livenessReason: "adapter_did_not_succeed" };
}

// T5: both moved to ./workspace-resolution.js so the crew runner can reuse the
// same resolution. Re-exported here because existing callers (projects.ts,
// aoa-sentinel-compat.test.ts) import isRepoOnlySentinel from this module.
export { isRepoOnlySentinel } from "./workspace-resolution.js";

const startLocksByAgent = new Map<string, Promise<void>>();

/**
 * Returns true when the thrown error is a checkout-conflict from
 * issueService.checkout (HTTP 409 "Issue checkout conflict").
 * Exported so unit tests can import it directly.
 */
export function isCheckoutConflictError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 409 &&
    error.message === "Issue checkout conflict"
  );
}

function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

// D1: RAW resolver — does NOT apply the D1 unsandboxed-multitenant gate.
// Production dispatch sinks MUST call `resolveGuardedAdapterExecutionContext`;
// direct use is only for isolated hardening unit tests. Named `...Unguarded` so a
// future 4th dispatch sink cannot grab the canonical-looking name and silently
// bypass the gate.
export function resolveAdapterExecutionContextUnguarded(
  config: unknown,
  adapter: Pick<ServerAdapterModule, "getRuntimeCommandSpec">,
  // Whether this run executes on SHARED multi-tenant infra. Threaded to the
  // execution-target SINK so a tenant-authored adapterConfig.executionTarget
  // (free-form z.record) cannot weaken the docker sandbox on shared infra
  // (P5 sink-level hardening — closes the --add-host SSRF route + sandbox escape).
  // Fail-closed DEFAULT `true`: a caller that forgets to resolve the boundary
  // hardens rather than exposes. The two production callers (heartbeat run loop +
  // crew runner) pass the resolved trust boundary explicitly.
  multiTenant = true,
) {
  const adapterConfigObject = parseObject(config);
  const executionTarget = resolveAdapterExecutionTarget(adapterConfigObject.executionTarget, multiTenant);
  const runtimeCommandSpec = adapter.getRuntimeCommandSpec?.(adapterConfigObject) ?? null;
  return { executionTarget, runtimeCommandSpec };
}

// D1: resolve the run's execution target AND apply the unsandboxed multi-tenant
// gate in one call, so every dispatch sink (org-agent heartbeat + crew runner)
// gets identical refuse/allow behavior. NOTE the two signals are intentionally
// DECOUPLED (see the ★ signal correction): hardening keys off
// `trustBoundary === "multi_tenant"` (broad — also neutralizes a tenant-authored
// docker target on an `authenticated` self-host, a safe no-op on a local target),
// while the REFUSAL keys off `tenantIsolationEnforced` (cloud_auth only). This
// keeps `authenticated` self-hosters running (hardening no-ops on their local
// target; the guard does not fire) while cloud_auth refuses.
export function resolveGuardedAdapterExecutionContext(
  config: unknown,
  adapter: Pick<ServerAdapterModule, "getRuntimeCommandSpec">,
  opts: { trustBoundary: TrustBoundary; tenantIsolationEnforced: boolean; sink: string },
) {
  const resolved = resolveAdapterExecutionContextUnguarded(
    config,
    adapter,
    opts.trustBoundary === "multi_tenant",
  );
  assertUnsandboxedMultitenantAllowed(resolved.executionTarget, {
    tenantIsolationEnforced: opts.tenantIsolationEnforced,
    sink: opts.sink,
  });
  return resolved;
}

type HeartbeatRuntimeDecisionEvent = {
  eventType: string;
  stream: "system";
  level: "info" | "warn" | "error";
  message: string;
  payload?: Record<string, unknown>;
};

type HeartbeatRuntimeDecisionService = Pick<
  ReturnType<typeof agentRuntimeDecisionService>,
  "createPrompt" | "waitForAnswer" | "markRelayed" | "markRelayFailed"
>;

type HeartbeatRuntimeDecisionBrokerInput = {
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId">;
  agent: Pick<typeof agents.$inferSelect, "id" | "companyId" | "name" | "adapterType">;
  runtime: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    taskKey: string | null;
  };
  runtimeDecisions: HeartbeatRuntimeDecisionService;
  appendRunEvent: (event: HeartbeatRuntimeDecisionEvent) => Promise<void>;
  markRunWaiting: (decision: AgentRuntimeDecisionRow) => Promise<void>;
  clearRunWaiting: (decision: AgentRuntimeDecisionRow) => Promise<void>;
  recordWait?: (kind: "permission" | "work_question", durationMs: number) => Promise<void>;
  pollIntervalMs?: number;
};

export function calculateRunAccounting(input: {
  startedAt: Date | string | null;
  finishedAt: Date | string;
  humanQuestionWaitMs: number;
  runtimePermissionWaitMs: number;
  humanWaitOccurredOutsideRun: boolean;
}) {
  const startedMs = input.startedAt ? new Date(input.startedAt).getTime() : new Date(input.finishedAt).getTime();
  const finishedMs = new Date(input.finishedAt).getTime();
  const runWallClockMs = Math.max(0, finishedMs - startedMs);
  const humanQuestionWaitMs = Math.max(0, Math.trunc(input.humanQuestionWaitMs));
  const runtimePermissionWaitMs = Math.max(0, Math.trunc(input.runtimePermissionWaitMs));
  const inlineHumanWaitMs = input.humanWaitOccurredOutsideRun ? 0 : humanQuestionWaitMs;
  return {
    activeExecutionMs: Math.max(0, runWallClockMs - runtimePermissionWaitMs - inlineHumanWaitMs),
    humanQuestionWaitMs,
    runtimePermissionWaitMs,
    totalWallClockMs: runWallClockMs + (input.humanWaitOccurredOutsideRun ? humanQuestionWaitMs : 0),
  };
}

function normalizeRuntimeDecisionExpiresAt(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function relayErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createHeartbeatRuntimeDecisionBroker(
  input: HeartbeatRuntimeDecisionBrokerInput,
): AdapterRuntimeDecisionBroker {
  const adapterType = input.agent.adapterType ?? "process";
  const adapterSessionId = input.runtime.sessionDisplayId ?? input.runtime.sessionId ?? null;

  async function createPrompt(kind: "permission" | "work_question", prompt: AdapterRuntimeDecisionPromptBase) {
    const { decision } = await input.runtimeDecisions.createPrompt({
      companyId: input.run.companyId,
      agentId: input.agent.id,
      runId: input.run.id,
      adapterType,
      adapterSessionId,
      adapterSessionParams: input.runtime.sessionParams,
      kind,
      nonce: prompt.nonce ?? randomUUID(),
      title: prompt.title,
      summary: prompt.summary,
      promptText: prompt.promptText,
      toolName: prompt.toolName,
      command: prompt.command,
      cwd: prompt.cwd,
      path: prompt.path,
      networkTarget: prompt.networkTarget,
      riskClass: prompt.riskClass,
      options: prompt.options,
      expiresAt: normalizeRuntimeDecisionExpiresAt(prompt.expiresAt),
      timeoutPolicy: prompt.timeoutPolicy ?? defaultTimeoutPolicy(kind),
    });

    await input.appendRunEvent({
      eventType: "runtime_decision.prompt_created",
      stream: "system",
      level: "info",
      message: "runtime decision prompt created",
      payload: {
        decisionId: decision.id,
        kind,
        nonce: decision.nonce,
        sourceRevision: decision.sourceRevision,
      },
    });
    await input.markRunWaiting(decision);
    return decision;
  }

  async function waitAndRelay(decision: AgentRuntimeDecisionRow) {
    const waitStartedAt = Date.now();
    let answered: AgentRuntimeDecisionRow;
    try {
      answered = await input.runtimeDecisions.waitForAnswer({
        companyId: input.run.companyId,
        decisionId: decision.id,
        pollIntervalMs: input.pollIntervalMs,
      });
    } finally {
      await input.recordWait?.(decision.kind as "permission" | "work_question", Date.now() - waitStartedAt);
    }
    await input.appendRunEvent({
      eventType: "runtime_decision.prompt_answered",
      stream: "system",
      level: "info",
      message: "runtime decision prompt answered",
      payload: {
        decisionId: answered.id,
        kind: answered.kind,
        sourceRevision: answered.sourceRevision,
      },
    });

    try {
      const relayed = await input.runtimeDecisions.markRelayed({
        companyId: input.run.companyId,
        decisionId: decision.id,
      });
      await input.appendRunEvent({
        eventType: "runtime_decision.relayed",
        stream: "system",
        level: "info",
        message: "runtime decision answer relayed",
        payload: {
          decisionId: relayed.id,
          kind: relayed.kind,
          sourceRevision: relayed.sourceRevision,
        },
      });
      await input.clearRunWaiting(relayed);
      return relayed;
    } catch (error) {
      if (error instanceof RuntimeDecisionCancelledError) {
        throw error;
      }
      await input.runtimeDecisions.markRelayFailed({
        companyId: input.run.companyId,
        decisionId: decision.id,
        relayError: relayErrorMessage(error),
      });
      await input.appendRunEvent({
        eventType: "runtime_decision.relay_failed",
        stream: "system",
        level: "error",
        message: "runtime decision answer relay failed",
        payload: {
          decisionId: decision.id,
          error: relayErrorMessage(error),
        },
      });
      throw error;
    }
  }

  function isTimeoutError(error: unknown): boolean {
    // agent-runtime-decisions.waitForAnswer throws conflict("Timed out ...")
    // (HttpError 409) when its bounded wait elapses.
    return (
      error instanceof HttpError &&
      error.status === 409 &&
      error.message.startsWith("Timed out waiting for runtime decision answer")
    );
  }

  return {
    async requestPermission(prompt) {
      const created = await createPrompt("permission", prompt);
      const relayed = await waitAndRelay(created);
      if (!relayed.decision) throw conflict("Permission runtime decision was answered without a decision");
      return {
        kind: "permission",
        decisionId: created.id,
        decision: (relayed.decision === "allow_run" ? "allow_always" : relayed.decision) as AdapterRuntimePermissionDecision,
        sourceRevision: relayed.sourceRevision,
      };
    },
    async requestPermissionBounded(prompt, timeoutMs) {
      const created = await createPrompt("permission", prompt);
      let answered: AgentRuntimeDecisionRow;
      const waitStartedAt = Date.now();
      try {
        answered = await input.runtimeDecisions.waitForAnswer({
          companyId: input.run.companyId,
          decisionId: created.id,
          timeoutMs,
        });
      } catch (error) {
        if (isTimeoutError(error)) {
          // CRITICAL INVARIANT: do NOT call markRelayed on timeout. Leave the
          // row for the W5a expiry sweep. Because waitForAnswer settles exactly
          // once and markRelayed is only reached on the success branch below, a
          // late answer after this return can never trigger a stale relay.
          await input.appendRunEvent({
            eventType: "runtime_decision.prompt_timed_out",
            stream: "system",
            level: "warn",
            message: "runtime decision prompt timed out",
            payload: { decisionId: created.id, kind: "permission", timeoutMs },
          });
          return { timedOut: true };
        }
        // RuntimeDecisionCancelledError (and any other error) → propagate.
        throw error;
      } finally {
        await input.recordWait?.("permission", Date.now() - waitStartedAt);
      }

      await input.appendRunEvent({
        eventType: "runtime_decision.prompt_answered",
        stream: "system",
        level: "info",
        message: "runtime decision prompt answered",
        payload: {
          decisionId: answered.id,
          kind: answered.kind,
          sourceRevision: answered.sourceRevision,
        },
      });

      const relayed = await input.runtimeDecisions.markRelayed({
        companyId: input.run.companyId,
        decisionId: created.id,
      });
      await input.appendRunEvent({
        eventType: "runtime_decision.relayed",
        stream: "system",
        level: "info",
        message: "runtime decision answer relayed",
        payload: {
          decisionId: relayed.id,
          kind: relayed.kind,
          sourceRevision: relayed.sourceRevision,
        },
      });
      await input.clearRunWaiting(relayed);

      if (!relayed.decision) throw conflict("Permission runtime decision was answered without a decision");
      return {
        kind: "permission",
        decisionId: created.id,
        decision: (relayed.decision === "allow_run" ? "allow_always" : relayed.decision) as AdapterRuntimePermissionDecision,
        sourceRevision: relayed.sourceRevision,
      };
    },
    async askWorkQuestion(prompt) {
      const created = await createPrompt("work_question", prompt);
      const relayed = await waitAndRelay(created);
      return {
        kind: "work_question",
        decisionId: created.id,
        answer: relayed.answerPayload ?? {},
        sourceRevision: relayed.sourceRevision,
      };
    },
  };
}

export function applyEnvironmentRuntimeTarget(
  config: Record<string, unknown>,
  environmentRuntime: { target: Record<string, unknown> | null },
): Record<string, unknown> {
  return environmentRuntime.target
    ? {
        ...config,
        executionTarget: environmentRuntime.target,
      }
    : config;
}

export function applyEnvironmentAcquisitionConfig(
  config: Record<string, unknown>,
  acquisition: Pick<EnvironmentAcquisitionResult, "configPatch"> | null,
): Record<string, unknown> {
  const configPatch = parseObject(acquisition?.configPatch);
  return Object.keys(configPatch).length > 0
    ? {
        ...config,
        ...configPatch,
      }
    : config;
}

async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  const run = previous.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
  beforeIssueWakeCommit?: (
    tx: Db,
    continuation: { id: string | null; wakeupRequestId: string | null },
  ) => Promise<void>;
}

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function resolveAdapterManagedRuntimeExecutionWorkspaceId(input: {
  persistedExecutionWorkspace: { id?: unknown } | null | undefined;
  issue: { executionWorkspaceId?: unknown } | null | undefined;
}): string | null {
  return readNonEmptyString(input.persistedExecutionWorkspace?.id)
    ?? readNonEmptyString(input.issue?.executionWorkspaceId)
    ?? null;
}

export function shouldUsePersistedExecutionWorkspaceForRun(input: {
  issueExecutionWorkspaceId?: unknown;
  issueExecutionWorkspacePreference?: unknown;
  hasIssueScopedExecutionWorkspace: boolean;
  existingExecutionWorkspaceStatus?: string | null;
}): boolean {
  if (!input.existingExecutionWorkspaceStatus || !["active", "idle", "in_review"].includes(input.existingExecutionWorkspaceStatus)) {
    return false;
  }
  return (
    Boolean(readNonEmptyString(input.issueExecutionWorkspaceId)) ||
    input.issueExecutionWorkspacePreference === "reuse_existing" ||
    input.hasIssueScopedExecutionWorkspace
  );
}

function normalizeRuntimeServiceUrlKey(value: unknown): string | null {
  const raw = readNonEmptyString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.pathname === "" || url.pathname === "/") && !url.search && !url.hash) {
      url.pathname = "/";
      return url.toString();
    }
    return url.toString();
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

export function mergeAdapterRuntimeServiceReports(input: {
  adapterReports: AdapterRuntimeServiceReport[];
  detectedReports: AdapterRuntimeServiceReport[];
}): AdapterRuntimeServiceReport[] {
  const reports = [...input.adapterReports];
  const knownUrls = new Set(
    reports
      .map((service) => normalizeRuntimeServiceUrlKey(service.url))
      .filter((url): url is string => Boolean(url)),
  );
  for (const service of input.detectedReports) {
    const url = normalizeRuntimeServiceUrlKey(service.url);
    if (url && knownUrls.has(url)) continue;
    if (url) knownUrls.add(url);
    reports.push(service);
  }
  return reports;
}

export function resolveOutputDetectionCwd(input: {
  adapterExecutionCwd?: string | null;
  effectiveCwd?: string | null;
}): string | null {
  const adapterCwd =
    typeof input.adapterExecutionCwd === "string" && input.adapterExecutionCwd.trim().length > 0
      ? input.adapterExecutionCwd.trim()
      : null;
  const effectiveCwd =
    typeof input.effectiveCwd === "string" && input.effectiveCwd.trim().length > 0
      ? input.effectiveCwd.trim()
      : null;
  return adapterCwd ?? effectiveCwd;
}

function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
}

function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

export {
  resolveRuntimeSessionParamsForWorkspace,
  shouldResetTaskSessionForWake,
  type ResolvedWorkspaceForRun,
} from "./heartbeat-session.js";

function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";

  const wakeSource = readNonEmptyString(contextSnapshot?.wakeSource);
  if (wakeSource === "timer") return "wake source is timer";

  const wakeTriggerDetail = readNonEmptyString(contextSnapshot?.wakeTriggerDetail);
  if (wakeSource === "on_demand" && wakeTriggerDetail === "manual") {
    return "this is a manual invoke";
  }
  return null;
}

function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload = readNonEmptyString(payload?.["issueId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const commentId = deriveCommentId(incoming, null);
  if (commentId) {
    merged.commentId = commentId;
    merged.wakeCommentId = commentId;
  }
  return merged;
}

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

function readNonNegativeInteger(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

export function nextMaxTurnContinuationAttempt(run: {
  scheduledRetryAttempt?: number | null;
  continuationAttempt?: number | null;
  contextSnapshot?: unknown;
}) {
  const context = parseObject(run.contextSnapshot);
  const current = Math.max(
    readNonNegativeInteger(run.scheduledRetryAttempt),
    readNonNegativeInteger(run.continuationAttempt),
    readNonNegativeInteger(context.scheduledRetryAttempt),
    readNonNegativeInteger(context.continuationAttempt),
  );
  return current + 1;
}

export function buildMaxTurnContinuationRetryContext(input: {
  sourceRunId: string;
  issueId: string;
  attempt: number;
  contextSnapshot?: unknown;
}) {
  return {
    ...parseObject(input.contextSnapshot),
    retryOfRunId: input.sourceRunId,
    retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
    scheduledRetryAttempt: input.attempt,
    continuationAttempt: input.attempt,
    wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
    issueId: input.issueId,
    taskId: input.issueId,
    resumeIntent: true,
  };
}

export function classifyScheduledRetryGate(input: {
  issue: { status: string; assigneeAgentId?: string | null } | null;
  agentId: string;
}): "issue_cancelled" | "issue_reassigned" | "issue_not_in_progress" | null {
  if (!input.issue) return "issue_not_in_progress";
  if (input.issue.status === "cancelled") return "issue_cancelled";
  if (input.issue.assigneeAgentId !== input.agentId) return "issue_reassigned";
  if (input.issue.status !== "in_progress") return "issue_not_in_progress";
  return null;
}

function isCancellableIssueExecutionStatus(status: string) {
  return status === "queued" || status === "scheduled_retry";
}

function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

function getAdapterSessionCodec(adapterType: string) {
  const adapter = getServerAdapter(adapterType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  previousRunId: string | null;
};

const heartbeatRunListResultColumns = {
  resultSummary: sql<string | null>`left(${heartbeatRuns.resultJson} ->> 'summary', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS})`.as("resultSummary"),
  resultResult: sql<string | null>`left(${heartbeatRuns.resultJson} ->> 'result', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS})`.as("resultResult"),
  resultMessage: sql<string | null>`left(${heartbeatRuns.resultJson} ->> 'message', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS})`.as("resultMessage"),
  resultError: sql<string | null>`left(${heartbeatRuns.resultJson} ->> 'error', ${HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS})`.as("resultError"),
  resultTotalCostUsd: sql<string | null>`${heartbeatRuns.resultJson} ->> 'total_cost_usd'`.as("resultTotalCostUsd"),
  resultCostUsd: sql<string | null>`${heartbeatRuns.resultJson} ->> 'cost_usd'`.as("resultCostUsd"),
  resultCostUsdCamel: sql<string | null>`${heartbeatRuns.resultJson} ->> 'costUsd'`.as("resultCostUsdCamel"),
} as const;

function readRawUsageTotals(usageJson: unknown): UsageTotals | null {
  const parsed = parseObject(usageJson);
  if (Object.keys(parsed).length === 0) return null;

  const inputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0))),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawCachedInputTokens, asNumber(parsed.cachedInputTokens, 0))),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0))),
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

function summarizeHeartbeatRunListResultJson(input: {
  summary?: string | null;
  result?: string | null;
  message?: string | null;
  error?: string | null;
  totalCostUsd?: string | null;
  costUsd?: string | null;
  costUsdCamel?: string | null;
}): Record<string, unknown> | null {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of [
    ["summary", input.summary],
    ["result", input.result],
    ["message", input.message],
    ["error", input.error],
  ] as const) {
    const normalized = readNonEmptyString(value);
    if (normalized) summary[key] = normalized;
  }

  for (const [key, value] of [
    ["total_cost_usd", input.totalCostUsd],
    ["cost_usd", input.costUsd],
    ["costUsd", input.costUsdCamel],
  ] as const) {
    const normalized = readNonEmptyString(value);
    if (!normalized) continue;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) summary[key] = parsed;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

function formatCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

export function parseSessionCompactionPolicy(agent: typeof agents.$inferSelect): SessionCompactionPolicy {
  return resolveSessionCompactionPolicy(agent.adapterType, agent.runtimeConfig).policy;
}

// ---------------------------------------------------------------------------
// Run-scoped mentioned-skill helpers (Task 17 upstream resync)
// ---------------------------------------------------------------------------

/**
 * Collect all unique skill IDs referenced via skill:// mention links across
 * an array of nullable markdown strings (issue title + description + comments).
 */
export function extractMentionedSkillIdsFromSources(
  sources: Array<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    for (const id of extractSkillMentionIds(src)) seen.add(id);
  }
  return [...seen];
}

/**
 * Look up the skill keys for any skill-mention IDs found in the issue title,
 * description, and comments. Returns an empty array when no issue is active.
 */
async function resolveRunScopedMentionedSkillKeys(
  db: Db,
  companyId: string,
  issueId: string | null,
): Promise<string[]> {
  if (!issueId) return [];

  const [issueRow] = await db
    .select({ title: issues.title, description: issues.description })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .limit(1);
  if (!issueRow) return [];

  const commentRows = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId));

  const sources = [
    issueRow.title,
    issueRow.description,
    ...commentRows.map((c) => c.body),
  ];
  const mentionedIds = extractMentionedSkillIdsFromSources(sources);
  if (mentionedIds.length === 0) return [];

  const rows = await db
    .select({ key: companySkills.key })
    .from(companySkills)
    .where(
      and(
        eq(companySkills.companyId, companyId),
        inArray(companySkills.id, mentionedIds),
      ),
    );

  return rows.map((r) => r.key);
}

/**
 * Merge run-scoped mentioned skill keys into the adapter config's
 * aoaSkillSync.desiredSkills (preserving any existing selections).
 */
export function applyRunScopedMentionedSkillKeys<T extends Record<string, unknown>>(
  config: T,
  skillKeys: string[],
): T {
  if (skillKeys.length === 0) return config;
  const existing = readAoaSkillSyncPreference(config);
  const merged = Array.from(new Set([...(existing.desiredSkills ?? []), ...skillKeys]));
  return writeAoaSkillSyncPreference(config, merged) as T;
}

const MAX_TEAMS_PER_AGENT_HEARTBEAT = 10;

/**
 * Build skill-shaped entries from team coordinations the assigned agent belongs to.
 *
 * Returns [] when:
 *   - The company has not enabled teams (companies.enableTeams = false).
 *   - The agent has no team memberships.
 *   - No published coordinations exist for those teams.
 *
 * Throws on DB error. Callers MUST wrap in try/catch — failures here cannot
 * propagate to break the heartbeat run. See the call site in heartbeat for
 * the canonical try/catch + sanitized warn-log pattern.
 *
 * Each returned entry is a synthetic skill that adapters materialize as a
 * markdown file in skillsDir alongside the agent's normal skills. The CLI
 * discovers and loads them via its skill mechanism.
 */
export async function buildTeamCoordinationSkillEntries(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<RuntimeSkillEntry[]> {
  const companyRow = await db
    .select({ enableTeams: companies.enableTeams })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0]);

  if (!companyRow?.enableTeams) return [];

  const memberships = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.agentId, agentId))
    .limit(MAX_TEAMS_PER_AGENT_HEARTBEAT);

  if (memberships.length >= MAX_TEAMS_PER_AGENT_HEARTBEAT) {
    // The cap is observable but doesn't fail the run. If this fires regularly,
    // the cap should be raised or write-time validation should reject the (N+1)th
    // team_members insert.
    logger.warn(
      { companyId, agentId, cap: MAX_TEAMS_PER_AGENT_HEARTBEAT },
      "agent has reached team-coordination cap; further team coords (if any) will not be injected this run",
    );
  }

  if (memberships.length === 0) return [];
  const teamIds = memberships.map((m) => m.teamId);

  const coords = await db
    .select({
      teamId: teamCoordinations.teamId,
      markdown: teamCoordinations.markdown,
      trustLevel: teamCoordinations.trustLevel,
    })
    .from(teamCoordinations)
    .innerJoin(teams, eq(teamCoordinations.teamId, teams.id))
    .where(
      and(
        inArray(teamCoordinations.teamId, teamIds),
        eq(teamCoordinations.status, "published"),
        // P1-D defense-in-depth: even if a coordination row escapes the
        // archive cascade in teamsService.archive (data drift, manual SQL,
        // future bug), the team-level archive status hides it from injection.
        ne(teams.status, "archived"),
      ),
    );

  if (coords.length === 0) return [];

  const teamRows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(inArray(teams.id, teamIds));
  const teamNameById = new Map(teamRows.map((t) => [t.id, t.name]));

  // "Team" fallback covers a race where a team is deleted between the
  // memberships and teams queries — schema cascade makes this rare but possible.
  return coords.map((c) => {
    const teamName = teamNameById.get(c.teamId) ?? "Team";
    // Prepend YAML frontmatter so Claude Code's skill-discovery mechanism
    // registers the file correctly. Without `name` + `description`, the CLI
    // either skips the file or registers it without enough metadata for the
    // agent to know when to load it.
    //
    // Founder-authored coordination markdown (from team-scaffolder + the
    // CoordinationEditor UI) does NOT include frontmatter — they're authoring
    // a team contract, not a Claude skill. We synthesize the frontmatter here.
    const frontmatter = [
      "---",
      `name: team-coord-${c.teamId}`,
      "description: >",
      `  Team coordination contract for the ${teamName} team. Read this any time`,
      "  you need to understand how this team handles work, member roles, routing",
      "  rules, escalation paths, or coordination conventions. Always relevant when",
      "  working on tasks assigned via this team or coordinating with team members.",
      "---",
      "",
      "",
    ].join("\n");
    return {
      key: `team-coord-${c.teamId}`,
      name: `${teamName} Coordination`,
      markdown: frontmatter + c.markdown,
      trustLevel: c.trustLevel,
    };
  });
}

export function heartbeatService(db: Db) {
  const runLogStore = getRunLogStore();
  const secretsSvc = secretService(db);
  const outputDetector = outputDetectionService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);

  // Register the secret resolver so API adapters can resolve API keys
  setSecretResolver((companyId, name) =>
    secretsSvc.resolveByName(companyId, name, {
      consumerType: "system",
      consumerId: `adapter-secret:${name}`,
      actorType: "system",
      configPath: `provider.${name}`,
    }),
  );

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getTaskSession(
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.adapterType, adapterType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ) {
    if (taskKey) {
      const codec = getAdapterSessionCodec(agent.adapterType);
      const existingTaskSession = await getTaskSession(
        agent.companyId,
        agent.id,
        agent.adapterType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      return truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );
    }

    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun?.sessionId ?? null;
  }

  const CONTEXT_MODE_LIMITS: Record<string, number> = { minimal: 3, standard: 10, full: 25 };

  async function fetchMemoryContext(
    companyId: string,
    issueId: string | null,
    contextMode: string = "standard",
    auditContext?: { agentId?: string | null; runId?: string | null },
  ) {
    const itemLimit = CONTEXT_MODE_LIMITS[contextMode] ?? 10;

    // Fetch company info, including vision/mission when present.
    const company = await db
      .select({ name: companies.name, description: companies.description })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);

    // Resolve task text + scope (department + goal + project type) used by the
    // semantic + keyword pathways and the RBAC/scope gate.
    let issueText: string | null = null;
    let issueScope: {
      projectId: string | null;
      projectType: string | null;
      goalId: string | null;
    } | null = null;
    // Current goal title for the always-on core (P1-T6). Joined here (the select
    // already leftJoins projects) so the core can name the goal without an extra
    // query. Left join ⇒ null when the task has no goal — the core omits the line.
    let goalTitle: string | null = null;
    if (issueId) {
      const issueRow = await db
        .select({
          title: issues.title,
          description: issues.description,
          projectId: issues.projectId,
          goalId: issues.goalId,
          projectType: projects.type,
          goalTitle: goals.title,
        })
        .from(issues)
        .leftJoin(projects, eq(projects.id, issues.projectId))
        .leftJoin(goals, eq(goals.id, issues.goalId))
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (issueRow) {
        issueText = [issueRow.title, issueRow.description].filter(Boolean).join("\n");
        issueScope = {
          projectId: issueRow.projectId,
          projectType: issueRow.projectType ?? null,
          goalId: issueRow.goalId,
        };
        goalTitle = issueRow.goalTitle ?? null;
      }
    }

    // RBAC + scope gate (enterprise memory model, P1-T3): resolve the running
    // agent's actor and derive the task's department + goal scope so the ORG path
    // fetches only memory this agent is entitled to and relevant to (was a
    // company-wide, goal-less dump). agentId can be absent on some wake types —
    // then we skip the actor gate and retain today's unfiltered behavior.
    const actor = auditContext?.agentId
      ? await actorForAgentRun(db, companyId, auditContext.agentId)
      : null;
    const scope = resolveRunMemoryScope(issueScope);

    // Multi-pathway retrieval: semantic + keyword + temporal fused via RRF,
    // then trust-weighted (validationCount + recency). Replaces the old manual
    // pgvector query + preference-category fallback with a single unified call.
    const memorySvc = memoryService(db);
    const rawItems: MultiPathSearchResult[] = await memorySvc
      .searchMultiPath(companyId, issueText ?? "", {
        limit: itemLimit,
        ...scope,
        ...(actor ? { accessConditions: memoryAccessConditions(db, actor) } : {}),
      })
      .catch((err) => {
        logger.warn(
          { companyId, issueId, err },
          "searchMultiPath failed in fetchMemoryContext; returning empty memory",
        );
        return [] as MultiPathSearchResult[];
      });
    // Safety net: even with the in-SQL conditions, never hand an actor a row it
    // can't see (post-fetch filter mirrors the SQL gate — P0 memory-access.ts).
    const items = actor ? filterMemoryForActor(rawItems, actor) : rawItems;

    // Audit: fire-and-forget — one row per item → memory_retrievals table.
    // Powers the "Auto-retrieved" group in the workspace Memory section.
    if (items.length > 0 && issueId) {
      recordMemoryRetrievals(db, {
        companyId,
        agentId: auditContext?.agentId ?? null,
        runId: auditContext?.runId ?? null,
        taskId: issueId,
        triggeredBy: "auto",
        query: issueText ?? null,
        items: items.map((item, i) => ({
          id: item.id,
          rank: i + 1,
          similarityScore: item.similarity,
          shownToAgent: true,
        })),
      }).catch(() => {});
    }

    // Batch-touch accessedAt so temporal pathway recency decay stays accurate
    const servedIds = items.map((item) => item.id);
    if (servedIds.length > 0) {
      db.update(memoryItems)
        .set({ accessedAt: new Date() })
        .where(inArray(memoryItems.id, servedIds))
        .execute()
        .catch((err) => {
          logger.warn({ err, servedIds }, "Failed to update accessedAt for served memory items");
        });
    }

    return {
      company: company ? { name: company.name, description: company.description } : null,
      memory: items.map((item) => ({
        title: item.title,
        content: item.content,
        category: item.category,
        tags: item.tags ?? [],
      })),
      // Current goal title for the always-on core (P1-T6); null when the task has
      // no goal or there is no task on this wake.
      goalTitle,
    };
  }

  /**
   * Fetch completed dependency tasks and their attachments for agent context.
   * Returns the 5 most recently completed dependencies with attachment metadata.
   */
  async function fetchDependencyOutputs(companyId: string, issueId: string) {
    // Get dependencies (upstream blocking tasks) for this issue
    const deps = await db
      .select({
        dependencyIssueId: taskDependencies.dependencyIssueId,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        updatedAt: issues.updatedAt,
      })
      .from(taskDependencies)
      .innerJoin(issues, eq(issues.id, taskDependencies.dependencyIssueId))
      .where(
        and(
          eq(taskDependencies.companyId, companyId),
          eq(taskDependencies.dependentIssueId, issueId),
          eq(issues.status, "done"),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(5);

    if (deps.length === 0) return [];

    // Fetch attachments for all completed dependency tasks in one query
    const depIssueIds = deps.map((d) => d.dependencyIssueId);
    const attachmentRows = await db
      .select({
        issueId: issueAttachments.issueId,
        assetId: assets.id,
        originalFilename: assets.originalFilename,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        objectKey: assets.objectKey,
        provider: assets.provider,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
      .where(
        and(
          eq(issueAttachments.companyId, companyId),
          inArray(issueAttachments.issueId, depIssueIds),
        ),
      );

    // Group attachments by issueId
    const attachmentsByIssue = new Map<string, typeof attachmentRows>();
    for (const row of attachmentRows) {
      const existing = attachmentsByIssue.get(row.issueId) ?? [];
      existing.push(row);
      attachmentsByIssue.set(row.issueId, existing);
    }

    return deps.map((dep) => {
      const depAttachments = attachmentsByIssue.get(dep.dependencyIssueId) ?? [];
      return {
        taskTitle: dep.title,
        taskDescription: dep.description,
        status: dep.status,
        attachments: depAttachments.map((a) => ({
          filename: a.originalFilename ?? a.objectKey,
          contentType: a.contentType,
          byteSize: a.byteSize,
          provider: a.provider,
          objectKey: a.objectKey,
        })),
      };
    });
  }

  // T5: the resolution body now lives in ./workspace-resolution.js so the CREW
  // runner can reuse it verbatim (Decision #110 clause 7 — crew runs had no
  // workspace at all and fell through to process.cwd(), the AoA repo). This
  // closure stays as the db-bound call shape so every org call site is
  // byte-identical to before the extraction.
  async function resolveWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null },
  ): Promise<ResolvedWorkspaceForRun> {
    return resolveWorkspaceForRunShared(db, agent, context, previousSessionParams, opts);
  }

  async function upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    const existing = await getTaskSession(
      input.companyId,
      input.agentId,
      input.adapterType,
      input.taskKey,
    );
    if (existing) {
      return db
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    return db
      .insert(agentTaskSessions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearTaskSessions(
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) {
    const conditions = [
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) {
      conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
    }
    if (opts?.adapterType) {
      conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
    }

    return db
      .delete(agentTaskSessions)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows.length);
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;

    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    // R1 terminal-status latch. The status write is guarded to NOT overwrite a
    // row that is already terminal — a conditional UPDATE that only matches rows
    // whose current status is NOT one of TERMINAL_RUN_STATUSES. This is the
    // atomic check: a live run (running/queued/…) matches and transitions
    // normally; a run that a concurrent cancel already flipped to terminal does
    // NOT match, so the status is never resurrected.
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(heartbeatRuns.id, runId),
          notInArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES as unknown as string[]),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (!updated) {
      // Guard miss: either the row is gone, or it is already terminal. Read it.
      const current = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!current) return null;

      // The row is terminal. Apply a metadata-only patch (status stripped) and
      // SKIP the live-event + terminal hub emit. This keeps the legitimate
      // cancelled→cancelled metadata writes (usageJson / log excerpts) working
      // (P2-1) while blocking cancelled→running / cancelled→failed resurrection.
      const fallback = resolveTerminalLatchFallback(patch as Record<string, unknown> | undefined, {
        requestedStatus: status,
        currentStatus: current.status,
      });
      if (fallback.action === "noop") {
        // Pure status flip against a terminal row (no metadata) — nothing to do.
        return null;
      }
      await db
        .update(heartbeatRuns)
        .set({ ...fallback.metadataPatch, updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId))
        .returning()
        .then((rows) => rows[0] ?? current);
      return null;
    }

    if (updated) {
      if (isTerminalRunStatus(updated.status)) {
        try {
          await finalizeHeartbeatWorkQuestionContinuation(db, {
            companyId: updated.companyId,
            runId: updated.id,
            status: updated.status as "succeeded" | "failed" | "cancelled" | "timed_out",
            error: updated.error ?? null,
          });
        } catch (err) {
          logger.warn({ err, runId: updated.id }, "work-question continuation terminal callback failed");
        }
      }

      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: updated.id,
          agentId: updated.agentId,
          status: updated.status,
          invocationSource: updated.invocationSource,
          triggerDetail: updated.triggerDetail,
          error: updated.error ?? null,
          errorCode: updated.errorCode ?? null,
          startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
          finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
        },
      });

      // Event-driven failed/timed-out hub items at the single terminal-status
      // chokepoint. Successful exits stay in run history; their questions,
      // reviews, and task transitions already have durable attention surfaces.
      // Failures route through the SAME builder as
      // the legacy sidebar-badges scan (byte-identical rows → the change-aware
      // emit dedupes instead of ping-ponging). Best-effort try/catch mirrors
      // relayCrewResult: a hub failure (e.g. resolveOwner "no human owner")
      // must NEVER fail a run.
      if (["succeeded", "failed", "timed_out"].includes(updated.status)) {
        try {
          const agentRow = await db
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, updated.agentId))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          const emitArgs = buildTerminalRunHubEmit({
            id: updated.id,
            companyId: updated.companyId,
            agentId: updated.agentId,
            agentName: agentRow?.name ?? null,
            status: updated.status,
            error: updated.error ?? null,
            updatedAt: updated.updatedAt,
          });
          if (emitArgs) await emitHubItem(db, emitArgs);
        } catch (err) {
          logger.warn({ err, runId: updated.id }, "terminal-run hub emit failed (non-fatal)");
        }
      }
    }

    return updated;
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
  }

  async function resolveTerminalRunAccounting(
    run: typeof heartbeatRuns.$inferSelect,
    finishedAt: Date,
  ) {
    const current = await getRun(run.id) ?? run;
    const context = parseObject(current.contextSnapshot);
    return calculateRunAccounting({
      startedAt: current.startedAt,
      finishedAt,
      humanQuestionWaitMs: current.humanQuestionWaitMs,
      runtimePermissionWaitMs: current.runtimePermissionWaitMs,
      humanWaitOccurredOutsideRun: context.source === "work_question_continuation",
    });
  }

  async function cancelRuntimeDecisionPromptsForRun(
    run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">,
    reason: string,
  ) {
    try {
      await agentRuntimeDecisionService(db).cancelActiveForRun({
        companyId: run.companyId,
        runId: run.id,
        reason,
      });
    } catch (err) {
      logger.warn({ err, runId: run.id }, "failed to cancel runtime decision prompts for terminal run");
    }
  }

  async function hasIncompleteDependencies(companyId: string, issueId: string) {
    const blocked = await db
      .select({ id: taskDependencies.dependencyIssueId })
      .from(taskDependencies)
      .innerJoin(issues, eq(issues.id, taskDependencies.dependencyIssueId))
      .where(
        and(
          eq(taskDependencies.companyId, companyId),
          eq(taskDependencies.dependentIssueId, issueId),
          ne(issues.status, "done"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(blocked);
  }

  async function scheduleBoundedRetryForRun(
    sourceRun: typeof heartbeatRuns.$inferSelect,
    opts: { now?: Date } = {},
  ) {
    const contextSnapshot = parseObject(sourceRun.contextSnapshot);
    const issueId = readNonEmptyString(contextSnapshot.issueId) ?? readNonEmptyString(contextSnapshot.taskId);
    if (!issueId) return null;

    const attempt = nextMaxTurnContinuationAttempt(sourceRun);
    if (attempt > MAX_TURN_CONTINUATION_MAX_ATTEMPTS) return null;

    const agent = await getAgent(sourceRun.agentId);
    if (
      !agent ||
      agent.companyId !== sourceRun.companyId ||
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      return null;
    }

    const issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, sourceRun.companyId)))
      .then((rows) => rows[0] ?? null);

    if (classifyScheduledRetryGate({ issue, agentId: sourceRun.agentId })) return null;
    if (await hasIncompleteDependencies(sourceRun.companyId, issueId)) return null;
    if (
      await productivityReviewService(db).isProductivityReviewContinuationHoldActive({
        companyId: sourceRun.companyId,
        issueId,
        agentId: sourceRun.agentId,
      })
    ) {
      await logActivity(db, {
        companyId: sourceRun.companyId,
        actorType: "system",
        actorId: "recovery",
        action: "issue.recovery_continuation_exhausted",
        entityType: "issue",
        entityId: issueId,
        agentId: sourceRun.agentId,
        runId: sourceRun.id,
        details: { reason: "productivity_review_hold" },
      });
      return null;
    }

    const now = opts.now ?? new Date();
    const dueAt = new Date(now.getTime() + MAX_TURN_CONTINUATION_DELAY_MS);
    const retryContext = buildMaxTurnContinuationRetryContext({
      sourceRunId: sourceRun.id,
      issueId,
      attempt,
      contextSnapshot,
    });
    const idempotencyKey = [
      MAX_TURN_CONTINUATION_WAKE_REASON,
      issueId,
      sourceRun.id,
      String(attempt),
    ].join(":");
    const existingStatuses = ["scheduled_retry", "queued", "deferred_issue_execution", "claimed", "completed"];

    const readExistingWakeRun = async () => {
      const existingWake = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, sourceRun.companyId),
            eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
            inArray(agentWakeupRequests.status, existingStatuses),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existingWake?.runId) return null;
      return getRun(existingWake.runId);
    };

    try {
      return await db.transaction(async (tx) => {
        const existingWake = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, sourceRun.companyId),
              eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
              inArray(agentWakeupRequests.status, existingStatuses),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (existingWake?.runId) {
          return tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, existingWake.runId))
            .then((rows) => rows[0] ?? null);
        }

        const wakeupRequest = existingWake ?? await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: sourceRun.companyId,
            agentId: sourceRun.agentId,
            source: "on_demand",
            triggerDetail: "recovery.max_turn_continuation",
            reason: MAX_TURN_CONTINUATION_WAKE_REASON,
            payload: retryContext,
            status: "scheduled_retry",
            idempotencyKey,
          })
          .returning()
          .then((rows) => rows[0]);

        const sessionBefore = await resolveSessionBeforeForWakeup(agent, runTaskKey(sourceRun));
        const scheduledRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: sourceRun.companyId,
            agentId: sourceRun.agentId,
            invocationSource: "on_demand",
            triggerDetail: "recovery.max_turn_continuation",
            status: "scheduled_retry",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: retryContext,
            sessionIdBefore: sessionBefore,
            retryOfRunId: sourceRun.id,
            scheduledRetryAt: dueAt,
            scheduledRetryAttempt: attempt,
            scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
            continuationAttempt: attempt,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: scheduledRun.id,
            payload: retryContext,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        await tx
          .update(issues)
          .set({
            executionRunId: scheduledRun.id,
            executionAgentNameKey: normalizeAgentNameKey(agent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(and(eq(issues.id, issueId), eq(issues.companyId, sourceRun.companyId)));

        return scheduledRun;
      });
    } catch (err) {
      const existingRun = await readExistingWakeRun();
      if (existingRun) return existingRun;
      throw err;
    }
  }

  async function promoteDueScheduledRetries(now = new Date()) {
    const dueRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.status, "scheduled_retry"), lte(heartbeatRuns.scheduledRetryAt, now)))
      .orderBy(asc(heartbeatRuns.scheduledRetryAt), asc(heartbeatRuns.createdAt));

    let promoted = 0;
    let cancelled = 0;

    for (const dueRun of dueRuns) {
      const contextSnapshot = parseObject(dueRun.contextSnapshot);
      const issueId = readNonEmptyString(contextSnapshot.issueId) ?? readNonEmptyString(contextSnapshot.taskId);
      const issue = issueId
        ? await db
          .select({
            id: issues.id,
            companyId: issues.companyId,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, dueRun.companyId)))
          .then((rows) => rows[0] ?? null)
        : null;
      const invalidation = classifyScheduledRetryGate({ issue, agentId: dueRun.agentId });

      if (invalidation || !issueId) {
        await db.transaction(async (tx) => {
          await tx
            .update(heartbeatRuns)
            .set({
              status: "cancelled",
              finishedAt: now,
              errorCode: invalidation ?? "issue_not_in_progress",
              error: "Scheduled retry cancelled because the issue is no longer eligible",
              updatedAt: now,
            })
            .where(and(eq(heartbeatRuns.id, dueRun.id), eq(heartbeatRuns.status, "scheduled_retry")));

          if (dueRun.wakeupRequestId) {
            await tx
              .update(agentWakeupRequests)
              .set({
                status: "cancelled",
                finishedAt: now,
                error: "Scheduled retry cancelled because the issue is no longer eligible",
                updatedAt: now,
              })
              .where(eq(agentWakeupRequests.id, dueRun.wakeupRequestId));
          }

          if (issue?.executionRunId === dueRun.id) {
            await tx
              .update(issues)
              .set({
                executionRunId: null,
                executionAgentNameKey: null,
                executionLockedAt: null,
                updatedAt: now,
              })
              .where(eq(issues.id, issue.id));
          }
        });
        cancelled += 1;
        continue;
      }

      await db.transaction(async (tx) => {
        await tx
          .update(heartbeatRuns)
          .set({ status: "queued", updatedAt: now })
          .where(and(eq(heartbeatRuns.id, dueRun.id), eq(heartbeatRuns.status, "scheduled_retry")));
        if (dueRun.wakeupRequestId) {
          await tx
            .update(agentWakeupRequests)
            .set({ status: "queued", updatedAt: now })
            .where(eq(agentWakeupRequests.id, dueRun.wakeupRequestId));
        }
      });
      promoted += 1;

      publishLiveEvent({
        companyId: dueRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: dueRun.id,
          agentId: dueRun.agentId,
          invocationSource: dueRun.invocationSource,
          triggerDetail: dueRun.triggerDetail,
          wakeupRequestId: dueRun.wakeupRequestId,
        },
      });
      await dispatchQueuedRunsAfterAgentSignal(dueRun.agentId);
    }

    return { checked: dueRuns.length, promoted, cancelled };
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: event.message,
      payload: event.payload,
    });

    publishLiveEvent({
      companyId: run.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: event.message ?? null,
        payload: event.payload ?? null,
      },
    });
  }

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, true),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    };
  }

  async function countRunningRunsForAgent(agentId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
    return Number(count ?? 0);
  }

  async function claimQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    if (run.status !== "queued") return run;
    const claimedAt = new Date();
    const claimed = await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? claimedAt,
        updatedAt: claimedAt,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    await publishQueuedRunClaim(claimed, claimedAt);
    return claimed;
  }

  async function publishQueuedRunClaim(
    claimed: typeof heartbeatRuns.$inferSelect,
    claimedAt = new Date(),
  ) {
    publishLiveEvent({
      companyId: claimed.companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: claimed.id,
        agentId: claimed.agentId,
        status: claimed.status,
        invocationSource: claimed.invocationSource,
        triggerDetail: claimed.triggerDetail,
        error: claimed.error ?? null,
        errorCode: claimed.errorCode ?? null,
        startedAt: claimed.startedAt ? new Date(claimed.startedAt).toISOString() : null,
        finishedAt: claimed.finishedAt ? new Date(claimed.finishedAt).toISOString() : null,
      },
    });

    await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
  }

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }

    const runningCount = await countRunningRunsForAgent(agentId);
    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" || outcome === "cancelled"
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt
            ? new Date(updated.lastHeartbeatAt).toISOString()
            : null,
          outcome,
        },
      });
    }
  }

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const now = new Date();

    // Find all runs in "queued" or "running" state
    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));

    const reaped: string[] = [];

    for (const run of activeRuns) {
      if (runningProcesses.has(run.id)) continue;

      // A-H6: In the periodic path, never reap a "queued" run. A queued run has
      // no child process to lose — it is legitimately waiting behind the
      // per-agent concurrency clamp (HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1),
      // so its absence from runningProcesses is expected, not an orphan. The
      // startup reap path (staleThresholdMs === 0) must still fail queued rows,
      // because after a restart the map is genuinely empty and a queued row may
      // be a crash remnant.
      if (staleThresholdMs > 0 && run.status === "queued") continue;

      // Apply staleness threshold to avoid false positives
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      await setRunStatus(run.id, "failed", {
        error: "Process lost -- server may have restarted",
        errorCode: "process_lost",
        finishedAt: now,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: "Process lost -- server may have restarted",
      });
      await cancelRuntimeDecisionPromptsForRun(run, "run failed");
      await executionWorkspacesSvc.releaseWorkspaceRunsForRun(run.id);
      await releaseRuntimeServicesForRun(run.id).catch(() => undefined);
      await environmentRuntimeService(db).releaseRunLeases(run.id).catch(() => undefined);
      const updatedRun = await getRun(run.id);
      if (updatedRun) {
        await appendRunEvent(updatedRun, 1, {
          eventType: "lifecycle",
          stream: "system",
          level: "error",
          message: "Process lost -- server may have restarted",
        });
        await releaseIssueExecutionAndPromote(updatedRun);
      }
      await finalizeAgentStatus(run.agentId, "failed");
      await dispatchQueuedRunsAfterAgentSignal(run.agentId);
      // No runningProcesses.delete here: this branch is guarded by
      // `if (runningProcesses.has(run.id)) continue` above, so there is nothing
      // to delete. Deregistration is owned by spawnTrackedChild's close/error
      // listeners (R1 zombie-run teardown).
      reaped.push(run.id);
    }

    // Heal leases left by a previous server version or a crash that happened
    // after the run became terminal but before its finally block completed.
    // releaseWorkspaceRunsForRun is ownership-fenced, so a reclaimed lease is
    // never cleared by this late cleanup.
    const lockedWorkspaceOwners = await db
      .select({ activeRunId: executionWorkspaces.activeRunId })
      .from(executionWorkspaces)
      .where(sql`${executionWorkspaces.activeRunId} IS NOT NULL`);
    for (const ownerRunId of new Set(
      lockedWorkspaceOwners
        .map((row) => row.activeRunId)
        .filter((value): value is string => Boolean(value)),
    )) {
      const owner = await getRun(ownerRunId);
      if (!owner || isTerminalRunStatus(owner.status)) {
        await executionWorkspacesSvc.releaseWorkspaceRunsForRun(ownerRunId);
      }
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  // ── Run summary comments (Decision #88) ─────────────────────────
  async function createRunSummaryComment(input: {
    agent: typeof agents.$inferSelect;
    run: typeof heartbeatRuns.$inferSelect;
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
    adapterResult: AdapterExecutionResult;
    issueId: string | null;
    detectedFiles: Array<{ path: string; type?: string }>;
  }) {
    const { agent, run, outcome, adapterResult, issueId, detectedFiles } = input;

    const startedAt = run.startedAt ?? run.createdAt;
    const finishedAt = run.finishedAt ?? new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    // Delegates to the shared writer so heartbeat (ORG) and the crew runner use ONE
    // implementation (opt-out check, formatRunSummary, issue_comments insert, issues.updatedAt).
    await postRunSummaryComment(db, {
      companyId: agent.companyId,
      issueId,
      agentName: agent.name,
      runtimeConfig: agent.runtimeConfig as Record<string, unknown> | null | undefined,
      outcome,
      runId: run.id,
      durationMs,
      inputTokens: adapterResult.usage?.inputTokens ?? null,
      outputTokens: adapterResult.usage?.outputTokens ?? null,
      costUsd: adapterResult.costUsd ?? null,
      errorMessage: adapterResult.errorMessage ?? null,
      detectedFiles,
    });
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
  ) {
    await ensureRuntimeState(agent);
    const usage = result.usage;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const additionalCostCents = Math.max(0, Math.round((result.costUsd ?? 0) * 100));
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;

    await db
      .update(agentRuntimeState)
      .set({
        adapterType: agent.adapterType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: result.errorMessage ?? null,
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

    if (additionalCostCents > 0 || hasTokenUsage) {
      await db.insert(costEvents).values({
        companyId: agent.companyId,
        agentId: agent.id,
        provider: result.provider ?? "unknown",
        model: result.model ?? "unknown",
        inputTokens,
        outputTokens,
        costCents: additionalCostCents,
        occurredAt: new Date(),
      });
    }

    if (additionalCostCents > 0) {
      await db
        .update(agents)
        .set({
          spentMonthlyCents: sql`${agents.spentMonthlyCents} + ${additionalCostCents}`,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agent.id));

      // Budget alert checks
      if (agent.budgetMonthlyCents > 0) {
        await checkBudgetAlerts(agent, run);
      }
    }
  }

  async function checkBudgetAlerts(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
  ) {
    // Sum cost_events for this agent in the current calendar month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [result] = await db
      .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)` })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.agentId, agent.id),
          gt(costEvents.occurredAt, monthStart),
        ),
      );

    const totalSpent = Number(result?.total ?? 0);
    const budget = agent.budgetMonthlyCents;
    const ratio = totalSpent / budget;

    if (ratio >= 1) {
      // At or over 100% — pause the agent and log budget_exceeded
      await db
        .update(agents)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(agents.id, agent.id));

      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "system",
        actorId: "budget-monitor",
        action: "budget.exceeded",
        entityType: "agent",
        entityId: agent.id,
        agentId: agent.id,
        runId: run.id,
        details: {
          totalSpentCents: totalSpent,
          budgetCents: budget,
          percentUsed: Math.round(ratio * 100),
        },
      });

      logger.warn(
        { agentId: agent.id, totalSpentCents: totalSpent, budgetCents: budget },
        "agent budget exceeded — agent paused",
      );
    } else if (ratio >= 0.8) {
      // At or over 80% — log budget_warning
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "system",
        actorId: "budget-monitor",
        action: "budget.warning",
        entityType: "agent",
        entityId: agent.id,
        agentId: agent.id,
        runId: run.id,
        details: {
          totalSpentCents: totalSpent,
          budgetCents: budget,
          percentUsed: Math.round(ratio * 100),
        },
      });

      logger.info(
        { agentId: agent.id, totalSpentCents: totalSpent, budgetCents: budget },
        "agent budget warning — 80% threshold reached",
      );
    }
  }

  async function startQueuedRunsForSingleAgent(agentId: string, expectedOrganizationId?: string) {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];

      if (tenantIsolationEnforced()) {
        const organizationId = await resolveCompanyOrganizationId(db, agent.companyId);
        if (!organizationId) {
          throw new Error(`Cloud heartbeat run cannot resolve an Organization for company ${agent.companyId}.`);
        }
        if (expectedOrganizationId && organizationId !== expectedOrganizationId) return [];
        const cloudClaims = await claimQueuedRunsWithOrgCapacity(db, {
          organizationId,
        });
        await runClaimMirrorsBestEffort(
          cloudClaims,
          publishQueuedRunClaim,
          (err, claimedRun) => {
            logger.warn(
              { err, runId: claimedRun.id },
              "queued heartbeat claim mirror failed; launching committed run",
            );
          },
        );
        if (cloudClaims.length === 0) return [];

        for (const claimedRun of cloudClaims) {
          void executeRun(claimedRun.id).catch(async (err) => {
            logger.error({ err, runId: claimedRun.id }, "queued heartbeat execution failed");
            const current = await getRun(claimedRun.id);
            if (!current) return;

            await executionWorkspacesSvc.releaseWorkspaceRunsForRun(current.id);
            await releaseRuntimeServicesForRun(current.id).catch(() => undefined);
            await environmentRuntimeService(db).releaseRunLeases(current.id).catch(() => undefined);

            if (current.status === "queued" || current.status === "running") {
              const message = err instanceof Error ? err.message : String(err);
              const failed = await setRunStatus(current.id, "failed", {
                error: message,
                errorCode: "pre_spawn_failed",
                finishedAt: new Date(),
              });
              await setWakeupStatus(current.wakeupRequestId, "failed", {
                finishedAt: new Date(),
                error: message,
              });
              await cancelRuntimeDecisionPromptsForRun(current, "run failed");
              if (failed) {
                await appendRunEvent(failed, 1, {
                  eventType: "lifecycle",
                  stream: "system",
                  level: "error",
                  message,
                });
                await releaseIssueExecutionAndPromote(failed);
              }
              await finalizeAgentStatus(current.agentId, "failed");
            }

            await dispatchQueuedRunsAfterAgentSignal(current.agentId);
          });
        }
        return cloudClaims;
      }

      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);

      // Self-hosted keeps the pre-Phase-5 per-agent-only path. The sentinel
      // Organization must not impose a hosted quota on a local instance.
      if (availableSlots <= 0) return [];

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .orderBy(asc(heartbeatRuns.createdAt))
        .limit(availableSlots);
      if (queuedRuns.length === 0) return [];

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of queuedRuns) {
        const claimed = await claimQueuedRun(queuedRun);
        if (claimed) claimedRuns.push(claimed);
      }
      if (claimedRuns.length === 0) return [];

      for (const claimedRun of claimedRuns) {
        void executeRun(claimedRun.id).catch(async (err) => {
          logger.error({ err, runId: claimedRun.id }, "queued heartbeat execution failed");
          const current = await getRun(claimedRun.id);
          if (!current) return;

          await executionWorkspacesSvc.releaseWorkspaceRunsForRun(current.id);
          await releaseRuntimeServicesForRun(current.id).catch(() => undefined);
          await environmentRuntimeService(db).releaseRunLeases(current.id).catch(() => undefined);

          if (current.status === "queued" || current.status === "running") {
            const message = err instanceof Error ? err.message : String(err);
            const failed = await setRunStatus(current.id, "failed", {
              error: message,
              errorCode: "pre_spawn_failed",
              finishedAt: new Date(),
            });
            await setWakeupStatus(current.wakeupRequestId, "failed", {
              finishedAt: new Date(),
              error: message,
            });
            await cancelRuntimeDecisionPromptsForRun(current, "run failed");
            if (failed) {
              await appendRunEvent(failed, 1, {
                eventType: "lifecycle",
                stream: "system",
                level: "error",
                message,
              });
              await releaseIssueExecutionAndPromote(failed);
            }
            await finalizeAgentStatus(current.agentId, "failed");
          }

          await dispatchQueuedRunsAfterAgentSignal(current.agentId);
        });
      }
      return claimedRuns;
    });
  }

  async function dispatchQueuedRunsAfterAgentSignal(agentId: string) {
    if (!tenantIsolationEnforced()) {
      return startQueuedRunsForSingleAgent(agentId);
    }

    const triggerAgent = await getAgent(agentId);
    if (!triggerAgent) return [];
    const organizationId = await resolveCompanyOrganizationId(db, triggerAgent.companyId);
    if (!organizationId) {
      throw new Error(`Cloud heartbeat run cannot resolve an Organization for company ${triggerAgent.companyId}.`);
    }

    // The cloud claimant scans the Organization queue once, skips capped
    // agents, and fills shared capacity in global FIFO order under the
    // Organization advisory lock. The trigger agent only supplies the local
    // in-process lock; claims may belong to any agent in this Organization.
    return startQueuedRunsForSingleAgent(agentId, organizationId);
  }

  async function getLatestRunForSession(
    agentId: string,
    sessionId: string,
    opts?: { excludeRunId?: string | null },
  ) {
    const conditions = [
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.sessionIdAfter, sessionId),
    ];
    if (opts?.excludeRunId) {
      conditions.push(sql`${heartbeatRuns.id} <> ${opts.excludeRunId}`);
    }
    return db
      .select({
        id: heartbeatRuns.id,
        usageJson: heartbeatRuns.usageJson,
      })
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getOldestRunForSession(agentId: string, sessionId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function evaluateSessionCompaction(input: {
    agent: typeof agents.$inferSelect;
    sessionId: string | null;
    issueId: string | null;
  }): Promise<SessionCompactionDecision> {
    const { agent, sessionId, issueId } = input;
    if (!sessionId) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const policy = parseSessionCompactionPolicy(agent);
    if (!policy.enabled || !hasSessionCompactionThresholds(policy)) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const fetchLimit = Math.max(policy.maxSessionRuns > 0 ? policy.maxSessionRuns + 1 : 0, 4);
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
        usageJson: heartbeatRuns.usageJson,
        error: heartbeatRuns.error,
        ...heartbeatRunListResultColumns,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(fetchLimit);

    if (runs.length === 0) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const latestRun = runs[0] ?? null;
    const oldestRun =
      policy.maxSessionAgeHours > 0
        ? await getOldestRunForSession(agent.id, sessionId)
        : runs[runs.length - 1] ?? latestRun;
    const latestRawUsage = readRawUsageTotals(latestRun?.usageJson);
    const sessionAgeHours =
      latestRun && oldestRun
        ? Math.max(
            0,
            (new Date(latestRun.createdAt).getTime() - new Date(oldestRun.createdAt).getTime()) / (1000 * 60 * 60),
          )
        : 0;

    let reason: string | null = null;
    if (policy.maxSessionRuns > 0 && runs.length > policy.maxSessionRuns) {
      reason = `session exceeded ${policy.maxSessionRuns} runs`;
    } else if (
      policy.maxRawInputTokens > 0 &&
      latestRawUsage &&
      latestRawUsage.inputTokens >= policy.maxRawInputTokens
    ) {
      reason =
        `session raw input reached ${formatCount(latestRawUsage.inputTokens)} tokens ` +
        `(threshold ${formatCount(policy.maxRawInputTokens)})`;
    } else if (policy.maxSessionAgeHours > 0 && sessionAgeHours >= policy.maxSessionAgeHours) {
      reason = `session age reached ${Math.floor(sessionAgeHours)} hours`;
    }

    if (!reason || !latestRun) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: latestRun?.id ?? null,
      };
    }

    const latestSummary = summarizeHeartbeatRunListResultJson({
      summary: latestRun?.resultSummary,
      result: latestRun?.resultResult,
      message: latestRun?.resultMessage,
      error: latestRun?.resultError,
      totalCostUsd: latestRun?.resultTotalCostUsd,
      costUsd: latestRun?.resultCostUsd,
      costUsdCamel: latestRun?.resultCostUsdCamel,
    });
    const latestTextSummary =
      readNonEmptyString(latestSummary?.summary) ??
      readNonEmptyString(latestSummary?.result) ??
      readNonEmptyString(latestSummary?.message) ??
      readNonEmptyString(latestRun.error);

    const handoffMarkdown = [
      "AoA session handoff:",
      `- Previous session: ${sessionId}`,
      issueId ? `- Issue: ${issueId}` : "",
      `- Rotation reason: ${reason}`,
      latestTextSummary ? `- Last run summary: ${latestTextSummary}` : "",
      "Continue from the current task state. Rebuild only the minimum context you need.",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      rotate: true,
      reason,
      handoffMarkdown,
      previousRunId: latestRun.id,
    };
  }

  async function executeRun(runId: string) {
    let run = await getRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (run.status === "queued") {
      const claimed = await claimQueuedRun(run);
      if (!claimed) {
        // Another worker has already claimed or finalized this run.
        return;
      }
      run = claimed;
    }

    const agent = await getAgent(run.agentId);
    if (!agent) {
      await setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      const failedRun = await getRun(runId);
      if (failedRun) await releaseIssueExecutionAndPromote(failedRun);
      return;
    }

    const runtime = await ensureRuntimeState(agent);
    const context = parseObject(run.contextSnapshot);
    const taskKey = deriveTaskKey(context, null);
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const issueId = readNonEmptyString(context.issueId);
    const issueContext = issueId
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
            status: issues.status,
            priority: issues.priority,
            projectId: issues.projectId,
            executionWorkspaceId: issues.executionWorkspaceId,
            executionWorkspacePreference: issues.executionWorkspacePreference,
            executionWorkspaceSettings: issues.executionWorkspaceSettings,
            executionEnvironmentId: issues.executionEnvironmentId,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
            workMode: issues.workMode,
            sourceDiscussionId: issues.sourceDiscussionId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    if (issueContext) {
      // Review F11 (2026-07-16): a comment-driven wake ("Send & wake" from
      // the chatbar/Comments tab, or an @mention) must carry the triggering
      // comment IN the prompt — the agent otherwise never sees the message
      // unless it happens to fetch comments via MCP tools. Best-effort: a
      // missing/deleted comment simply omits the section.
      const wakeCommentIdForPrompt =
        readNonEmptyString(context.wakeCommentId) ?? readNonEmptyString(context.commentId);
      let wakeCommentSection: string | null = null;
      if (wakeCommentIdForPrompt) {
        try {
          const commentRow = await db
            .select({
              body: issueComments.body,
              authorAgentId: issueComments.authorAgentId,
              authorUserId: issueComments.authorUserId,
            })
            .from(issueComments)
            .where(
              and(
                eq(issueComments.id, wakeCommentIdForPrompt),
                eq(issueComments.issueId, issueContext.id),
              ),
            )
            .then((rows) => rows[0] ?? null);
          if (commentRow) {
            let authorLabel = "the board";
            if (commentRow.authorAgentId) {
              const authorAgent = await db
                .select({ name: agents.name })
                .from(agents)
                .where(eq(agents.id, commentRow.authorAgentId))
                .then((rows) => rows[0] ?? null);
              authorLabel = authorAgent ? `agent ${authorAgent.name}` : "another agent";
            } else if (commentRow.authorUserId) {
              authorLabel = "a teammate";
            }
            wakeCommentSection = buildWakeCommentMarkdown({
              body: commentRow.body,
              authorLabel,
              reason: readNonEmptyString(context.wakeReason),
            });
          }
        } catch (err) {
          logger.warn(
            { err, wakeCommentId: wakeCommentIdForPrompt },
            "failed to inline wake comment into run prompt",
          );
        }
      }
      const currentTaskMarkdown = [
        buildCurrentTaskMarkdown(issueContext),
        wakeCommentSection,
        buildWorkQuestionContinuationMarkdown(context.continuationEnvelope),
      ].filter((section): section is string => Boolean(section)).join("\n\n");
      context.currentTask = {
        id: issueContext.id,
        identifier: issueContext.identifier,
        title: issueContext.title,
        description: issueContext.description,
        status: issueContext.status,
        priority: issueContext.priority,
        workMode: issueContext.workMode,
      };
      context.currentTaskMarkdown = currentTaskMarkdown;
    }
    // ── Auto-checkout for scoped wakes (T22 / PR #3538 upstream) ────────────
    // When the wake is scoped to an issue and the wake reason is comment-driven,
    // pre-claim the issue server-side before the adapter runs so the agent
    // prompt can skip the redundant /api/issues/{id}/checkout round-trip.
    // Best-effort: any failure (conflict or other) is caught and logged.
    if (
      issueId &&
      issueContext &&
      issueContext.assigneeAgentId === agent.id
    ) {
      const wakeReason = readNonEmptyString(context.wakeReason);
      // Mirror the shouldAutoCheckoutIssueForWake: only fire for
      // comment-driven wakes; skip execution_* and issue_comment_mentioned.
      const shouldAutoCheckout =
        wakeReason !== null &&
        wakeReason !== "issue_comment_mentioned" &&
        !wakeReason.startsWith("execution_") &&
        (
          issueContext.assigneeAgentId === agent.id
        );
      if (shouldAutoCheckout) {
        try {
          const issueSvc = createIssueService(db);
          await issueSvc.checkout(issueId, agent.id, ["todo", "backlog", "blocked", "in_progress"], run.id);
          context[AOA_HARNESS_CHECKOUT_KEY] = true;
          logger.info(
            { runId: run.id, issueId, agentId: agent.id },
            "[heartbeat] Harness pre-checked out issue for scoped wake",
          );
        } catch (err) {
          if (isCheckoutConflictError(err)) {
            logger.info(
              { runId: run.id, issueId },
              "[heartbeat] Harness checkout skipped — already claimed",
            );
          } else {
            logger.warn(
              { runId: run.id, issueId, err },
              "[heartbeat] Harness checkout failed — continuing without pre-claim",
            );
          }
          context[AOA_HARNESS_CHECKOUT_KEY] = false;
        }
        context.checkedOutByHarness = context[AOA_HARNESS_CHECKOUT_KEY] === true;
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    const issueAssigneeOverrides =
      issueContext && issueContext.assigneeAgentId === agent.id
        ? parseIssueAssigneeAdapterOverrides(
            issueContext.assigneeAdapterOverrides,
          )
        : null;
    const taskSession = taskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, taskKey)
      : null;
    const resetTaskSession = shouldResetTaskSessionForWake(context);
    const sessionResetReason = describeSessionResetReason(context);
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const previousSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null),
    );
    // ── Execution workspace policy resolution ─────────────────────────
    // Shared with the crew runner via resolveExecutionWorkspacePolicyInputs.
    // Heartbeat-specific inputs (divergences): the assignee legacy override is
    // passed through, projectEnv is returned for the env merge below, and the
    // returned policy/settings feed buildExecutionWorkspaceAdapterConfig.
    const contextProjectId = readNonEmptyString(context.projectId);
    const executionProjectId = issueContext?.projectId ?? contextProjectId;
    const {
      isolatedWorkspacesEnabled,
      issueExecutionWorkspaceSettings,
      projectExecutionWorkspacePolicy,
      projectEnv,
      executionWorkspaceMode,
    } = await resolveExecutionWorkspacePolicyInputs(db, {
      companyId: agent.companyId,
      executionProjectId,
      rawIssueExecutionWorkspaceSettings: issueContext?.executionWorkspaceSettings ?? null,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const resolvedWorkspace = await resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: executionWorkspaceMode !== "agent_default" },
    );

    // ── Execution workspace adapter config ──────────────────────────
    const config = parseObject(agent.adapterConfig);
    const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig({
      agentConfig: config,
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      mode: executionWorkspaceMode,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const mergedConfig = issueAssigneeOverrides?.adapterConfig
      ? { ...workspaceManagedConfig, ...issueAssigneeOverrides.adapterConfig }
      : workspaceManagedConfig;
    // ── Environment envVars resolution ──────────────────────────────────────
    // Priority: issue.executionEnvironmentId > agent.defaultEnvironmentId > none.
    // Scoped by companyId to prevent cross-tenant leakage.
    const environmentRuntime = await resolveEnvironmentRuntimeConfig(db, {
      executionEnvironmentId: issueContext?.executionEnvironmentId ?? null,
      defaultEnvironmentId: agent.defaultEnvironmentId ?? null,
      companyId: agent.companyId,
    });
    const environmentEnvVars = environmentRuntime.envVars;
    // ── Env merge: project baseline → environment envVars → agent adapterConfig.env ──
    // Merge order (lowest to highest priority):
    //   1. projectEnv       (project/department baseline)
    //   2. environmentEnvVars (named environment — NEW)
    //   3. mergedConfig.env (agent adapterConfig.env — wins last)
    const mergedConfigWithProjectEnv = projectEnv
      ? {
          ...mergedConfig,
          env: {
            ...(projectEnv as Record<string, unknown>),
            ...environmentEnvVars,
            ...parseObject(mergedConfig.env),
          },
        }
      : Object.keys(environmentEnvVars).length > 0
        ? {
            ...mergedConfig,
            env: {
              ...environmentEnvVars,
              ...parseObject(mergedConfig.env),
            },
          }
        : mergedConfig;
    const mergedConfigWithEnvironmentTarget = applyEnvironmentRuntimeTarget(
      mergedConfigWithProjectEnv,
      environmentRuntime,
    );

    const secretActorContext = {
      actorType: "agent" as const,
      actorId: agent.id,
      issueId: issueContext?.id ?? null,
      heartbeatRunId: run.id,
    };
    const projectEnvRecord = projectEnv ? parseObject(projectEnv) : null;
    const agentEnvRecord = parseObject(mergedConfig.env);
    const envSourceRecords = {
      project: {} as Record<string, unknown>,
      environment: {} as Record<string, unknown>,
      agent: {} as Record<string, unknown>,
    };
    const winningEnvSource = new Map<string, keyof typeof envSourceRecords>();
    for (const [source, values] of [
      ["project", projectEnvRecord],
      ["environment", environmentEnvVars],
      ["agent", agentEnvRecord],
    ] as const) {
      for (const [key, value] of Object.entries(values ?? {})) {
        const previousSource = winningEnvSource.get(key);
        if (previousSource) delete envSourceRecords[previousSource][key];
        winningEnvSource.set(key, source);
        envSourceRecords[source][key] = value;
      }
    }
    const resolvedEnv = {
      ...(executionProjectId
        ? await secretsSvc.resolveEnvBindings(agent.companyId, envSourceRecords.project, {
            consumerType: "project",
            consumerId: executionProjectId,
            ...secretActorContext,
          })
        : {}),
      ...(environmentRuntime.environmentId
        ? await secretsSvc.resolveEnvBindings(agent.companyId, envSourceRecords.environment, {
            consumerType: "environment",
            consumerId: environmentRuntime.environmentId,
            ...secretActorContext,
          })
        : {}),
      ...(await secretsSvc.resolveEnvBindings(agent.companyId, envSourceRecords.agent, {
        consumerType: "agent",
        consumerId: agent.id,
        ...secretActorContext,
      })),
    };
    // Resolution chain step 2 (design D4): the company-level provider key, applied
    // ONLY where nothing above already supplied that env var.
    //
    // The org-agent heartbeat does not go through
    // `secretsSvc.resolveAdapterConfigForRuntime` — it assembles `resolvedEnv`
    // itself from three scope-specific `resolveEnvBindings` calls (project ->
    // environment -> agent, later winning) so it can track which scope won each
    // key. So the fallback has to be applied here explicitly; the shared helper
    // is the same one that method uses, so the precedence rule is identical.
    //
    // Everything in `resolvedEnv` — project and environment scopes included, not
    // just the agent's own binding — outranks the company default, which is what
    // "the company key is the LAST stop before the host CLI's own login" means.
    // Unified provider-credential resolution (Phase 4). The org heartbeat keeps its
    // bespoke 3-scope `resolvedEnv` assembly above (project → environment → agent),
    // then routes the company-key fallback THROUGH the resolver so the new
    // provider_connections model wins when an assignment exists and the legacy
    // ladder (company-key + subscription-home) stays byte-identical otherwise.
    // Plan's stale local names (`heartbeatDeploymentMode`/`heartbeatDeploymentExposure`)
    // do NOT exist here; deployment mode/exposure come from loadConfig() (the same
    // source providers.ts uses to build the CLI-auth topology).
    const { resolveProviderCredential, applyResolvedCredential, toExecutionTargetHint } =
      await import("./provider-resolution.js");
    const { buildResolveDeps } = await import("./provider-resolution-deps.js");
    const { resolveCliAuthTopology } = await import("./cli-auth-topology.js");
    const { loadConfig: loadHeartbeatDeployConfig } = await import("../config.js");
    const heartbeatDeployConfig = loadHeartbeatDeployConfig();
    const hbTopology = resolveCliAuthTopology({
      deploymentMode: heartbeatDeployConfig.deploymentMode,
      deploymentExposure: heartbeatDeployConfig.deploymentExposure,
    });
    const hbProviderId =
      agent.adapterType === "codex_local"
        ? "openai"
        : agent.adapterType === "claude_local"
          ? "anthropic"
          : agent.adapterType;
    const hbDeps = {
      ...buildResolveDeps(db, hbTopology),
      legacyResolveConfig: async (cfg: Record<string, unknown>) =>
        secretsSvc.applyCompanyKeyFallbackForRuntime(
          agent.companyId,
          agent.adapterType,
          cfg,
          { consumerType: "agent", consumerId: agent.id, ...secretActorContext },
        ),
      // The former standalone subscription block (was heartbeat.ts :3991-4035)
      // becomes the legacy subscription fallback, preserving the
      // mayUseLegacySubscriptionHome semantics for unmigrated companies.
      legacySubscriptionEnv: async (postLegacyEnv: Record<string, string>) => {
        // Multi-tenant fail-closed: the legacy subscription-home fallback is a SECOND
        // resolution path, parallel to the new-model connection backstop. A founder's
        // legacy personal_subscription credential + binding SURVIVE a self-hosted →
        // multi_tenant data-dir cutover (the backfill/login gates only stop NEW rows,
        // they do not delete preserved ones), so this path must ALSO refuse to inject
        // a host-tied CLI login on a shared host. (resolveAgentSubscriptionEnvironment
        // also fails closed on trustBoundary === "multi_tenant" as the chokepoint.)
        if (hbTopology.trustBoundary === "multi_tenant") return null;
        if (hbProviderId !== "openai" && hbProviderId !== "anthropic") return null;
        // Read the POST-company-key env (the resolver passes it in) so the
        // "company key present ⇒ skip subscription home" short-circuit matches the
        // pre-P4 ordering. Reading the raw pre-fallback `resolvedEnv` here would add
        // a CODEX_HOME/CLAUDE_CONFIG_DIR redirect on top of a company key for an
        // unmigrated company that has BOTH — a strangler-faithfulness regression.
        const cfgEnv = postLegacyEnv;
        const apiKeyName = hbProviderId === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
        if (typeof cfgEnv[apiKeyName] === "string" && cfgEnv[apiKeyName].trim().length > 0) {
          return null;
        }
        const scopedRequired = /^(1|true|yes)$/i.test(
          process.env.AOA_SCOPED_CLI_AUTH?.trim() ?? "",
        );
        // ── P5 REBASE TARGET ──────────────────────────────────────────────────
        // The dedicated-target throw relocated here from the deleted standalone
        // subscription block. Phase 5 must rebase its "dedicated-target throw
        // replacement" onto THIS local-target branch (and/or the resolver's
        // execution-target seam) — NOT the deleted :3991-4035 block, which is gone.
        const targetConfig = parseObject(
          (mergedConfigWithEnvironmentTarget as Record<string, unknown>).executionTarget,
        );
        const targetType = typeof targetConfig.type === "string" ? targetConfig.type : "local";
        if (targetType !== "local" && scopedRequired) {
          throw new Error(
            "Governed subscription credentials currently require the dedicated local execution target.",
          );
        }
        if (targetType !== "local") return null;
        try {
          const boundEnv = await resolveAgentSubscriptionEnvironment(db, {
            companyId: agent.companyId,
            agentId: agent.id,
            provider: hbProviderId,
            executionTargetId: process.env.AOA_EXECUTION_TARGET_ID?.trim() || "control-plane",
            trustBoundary: hbTopology.trustBoundary,
          });
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(boundEnv)) if (typeof v === "string") out[k] = v;
          return out;
        } catch (error) {
          if (!mayUseLegacySubscriptionHome(error, scopedRequired)) throw error;
          return null;
        }
      },
    };
    const hbResolved = await resolveProviderCredential(
      db,
      {
        // organizationId null keeps org_default rows INERT (candidateMatchesScope
        // fails closed on a null org id — M1). Threading the company's real
        // organization_id here to activate org_default resolution is a follow-up;
        // company_default + agent_override already work with null.
        organizationId: null,
        companyId: agent.companyId,
        agentId: agent.id,
        actorKind: "org",
        adapterType: agent.adapterType,
        provider: hbProviderId,
        executionTargetId: process.env.AOA_EXECUTION_TARGET_ID?.trim() || "control-plane",
        currentEnv: resolvedEnv as Record<string, string>,
        context: { consumerType: "agent", consumerId: agent.id, ...secretActorContext },
      },
      hbDeps,
    );
    let resolvedConfig = applyResolvedCredential(
      { ...mergedConfigWithEnvironmentTarget, env: resolvedEnv } as Record<string, unknown>,
      hbResolved,
    ) as Record<string, unknown>;

    // P4→P5 SEAM (wired). Normalize the resolution for Phase 5's execution-target
    // selector. P5 Task 9 will read `p4CredentialHint.credentialKind` +
    // `p4CredentialHint.executionTargetSlug` instead of querying provider_credentials
    // directly. There is no P5 run-context object on this branch yet, so it is a
    // run-scoped LOCAL here (logged for observability) — a follow-up attaches it to
    // the run context P5 threads. No field is fabricated on an unrelated object.
    const p4CredentialHint = toExecutionTargetHint(hbResolved);
    logger.debug(
      { companyId: agent.companyId, agentId: agent.id, runId: run.id, p4CredentialHint },
      "heartbeat: P4→P5 credential hint resolved (run-scope local; attach to P5 run context as a follow-up)",
    );

    // ── P5 Task 9: route this run to the credential-appropriate execution target ──
    // Consume P4's normalized seam (p4CredentialHint) directly — do NOT re-read
    // provider_credentials. Business key ("company_api_key") → shared pool;
    // "personal_subscription" → its pinned dedicated target (fail-closed on a slug
    // mismatch). The resolver gate at provider-resolution.ts:327 skips
    // personal_subscription candidates when !selfHostedSingleTenant, so
    // credentialKind is NEVER "personal_subscription" on a shared host. That gate
    // does NOT, however, make the null-target local fallback below self-hosted-only:
    // a company_api_key run on SHARED infra whose org has no pooled_gvisor target
    // configured (DEFAULT-OFF gVisor) also resolves to null and falls back to the
    // local driver — on shared infra. Closing that shared-infra-no-pool fallback is
    // a separate guard (tracked as D1), NOT added here. When no execution target is
    // configured (DEFAULT-OFF gVisor / self-hosted single tenant) the resolver
    // returns null → the run keeps its existing (environment or local)
    // executionTarget untouched (config reference preserved). Routing is best-effort:
    // a routing error (e.g. an unavailable environment pin) logs and falls back to
    // local rather than failing the run.
    const executionTargetOrganizationId = await resolveHeartbeatExecutionTargetOrganizationId(db, {
      companyId: agent.companyId,
      tenantIsolationEnforced: tenantIsolationEnforced(),
    });
    const routedExecutionTarget = await resolveExecutionTargetForRun(db, {
      organizationId: executionTargetOrganizationId,
      companyId: agent.companyId,
      credentialKind: p4CredentialHint.credentialKind,
      executionTargetSlug: p4CredentialHint.executionTargetSlug,
      pinnedTargetId: environmentRuntime.executionTargetId ?? null,
    }).catch((error) => {
      const hasExplicitPin = environmentRuntime.executionTargetId != null;
      // Decision #117 §4: an explicit pin OR a personal_subscription run must fail
      // closed. Both re-raise below (via handleExecutionTargetRoutingError) into the
      // run crash-path — never silently fall back to the local host.
      const failsClosed = hasExplicitPin || p4CredentialHint.credentialKind === "personal_subscription";
      if (failsClosed) {
        logger.error(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            pinnedTargetId: environmentRuntime.executionTargetId ?? null,
            credentialKind: p4CredentialHint.credentialKind,
            error: error instanceof Error ? error.message : String(error),
          },
          "heartbeat: execution target unavailable — failing closed",
        );
      } else {
        logger.debug(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "heartbeat: execution-target routing fell back to local",
        );
      }
      return handleExecutionTargetRoutingError(error, {
        hasExplicitPin,
        credentialKind: p4CredentialHint.credentialKind,
      });
    });
    resolvedConfig = mergeResolvedExecutionTarget(
      resolvedConfig,
      routedExecutionTarget
        ? executionTargetToAdapterConfig(
            routedExecutionTarget,
            // Deployment-mode-aware hardening: only weaken-proof the sandbox on SHARED
            // infra. On the founder's own box (self-hosted single_user/single_tenant)
            // the target config is trusted and honored (local MCP bridge + custom
            // network/isolation). hbTopology is already resolved above (:3081).
            hbTopology.trustBoundary === "multi_tenant",
          )
        : null,
    );

    // ── Issue ref for execution workspace ───────────────────────────
    const issueRef = issueContext
      ? {
          id: issueContext.id,
          identifier: issueContext.identifier,
          title: issueContext.title,
          projectId: issueContext.projectId,
          executionWorkspaceId: issueContext.executionWorkspaceId,
          executionWorkspacePreference: issueContext.executionWorkspacePreference,
        }
      : null;

    // ── Realize execution workspace (gated by isolatedWorkspacesEnabled) ──
    let persistedExecutionWorkspace: Awaited<ReturnType<typeof executionWorkspacesSvc.create>> | null = null;
    let executionWorkspaceWarnings: string[] = [];
    let effectiveCwd = resolvedWorkspace.cwd;
    let realizedWorkspace: Awaited<ReturnType<typeof realizeExecutionWorkspace>> | null = null;

    // Lock state for thread-scoped workspaces (P1-T8 slice 4).
    // Set when the thread workspace lock is claimed; released unconditionally
    // in the outer finally block so the lock is always freed even on error.
    let threadWorkspaceLock: { workspaceId: string; runId: string } | null = null;

    // P2-T1: mark this agent as "working" on the source thread (deliverable
    // tasks only — issue.sourceDiscussionId set). Thread-scoped presence so the
    // chat shows "<Agent> working" on the right thread. Cleared in the finally
    // below. Best-effort: a presence failure must never break the run.
    const presenceThreadId: string | null = issueContext?.sourceDiscussionId ?? null;
    if (presenceThreadId) {
      try {
        threadWorkingAgents.add(presenceThreadId, agent.id, agent.name);
        broadcastThreadPresence(agent.companyId, presenceThreadId, Date.now());
      } catch (presenceErr) {
        logger.warn({ err: presenceErr, threadId: presenceThreadId, agentId: agent.id }, "P2-T1: failed to set working presence");
      }
    }

    if (isolatedWorkspacesEnabled) {
      // ── Thread-scoped workspace branch (P1-T8 slice 4) ────────────────────
      // Activated ONLY when ALL of these are true:
      //   1. The task is a deliverable (sourceDiscussionId is set on the issue)
      //   2. The existing workspace gate is already on (isolatedWorkspacesEnabled above)
      //   3. resolveDeliverableWorkspaceMode returns "reuse_thread"
      //
      // Non-deliverable tasks (no sourceDiscussionId) skip this block entirely
      // and fall through to the existing path below — ZERO behavioural change.
      const taskSourceDiscussionId = issueContext?.sourceDiscussionId ?? null;
      const realizeBaseForThread = {
        baseCwd: resolvedWorkspace.cwd,
        source: resolvedWorkspace.source,
        projectId: resolvedWorkspace.projectId,
        workspaceId: resolvedWorkspace.workspaceId,
        repoUrl: resolvedWorkspace.repoUrl,
        repoRef: resolvedWorkspace.repoRef,
      };
      const deliverableMode = taskSourceDiscussionId
        ? resolveDeliverableWorkspaceMode({
            intent: undefined,
            threadHasWorkspace: false, // determined lazily; mode is the same either way
          })
        : null;

      if (taskSourceDiscussionId && deliverableMode === "reuse_thread") {
        // Thread-scoped workspace: look up, provision (if needed), lock, reset.
        const threadOutcome = await resolveThreadDeliverableWorkspace({
          db,
          executionWorkspacesSvc,
          companyId: agent.companyId,
          sourceDiscussionId: taskSourceDiscussionId,
          runId: run.id,
          resolvedProjectId: executionProjectId ?? null,
          realizeBase: realizeBaseForThread,
          resolvedConfig,
          agent: { id: agent.id, name: agent.name, companyId: agent.companyId },
          recorder: workspaceOperationsSvc.createRecorder({
            companyId: agent.companyId,
            heartbeatRunId: run.id,
            executionWorkspaceId: null,
          }),
        });

        if (threadOutcome.kind === "workspace_busy") {
          // Another run is in this thread workspace right now.  Fail this run
          // cleanly so the heartbeat catch path releases the issue lock and
          // the task becomes retriggerable on the next wakeup.
          throw new Error(threadOutcome.reason);
        }

        // Lock acquired — record it for the finally block.
        threadWorkspaceLock = { workspaceId: threadOutcome.persistedWorkspaceId, runId: run.id };

        effectiveCwd = threadOutcome.realizedWorkspace.cwd;
        executionWorkspaceWarnings = threadOutcome.realizedWorkspace.warnings;
        realizedWorkspace = threadOutcome.realizedWorkspace;

        // Persist / update the thread workspace row with latest run state.
        if (executionProjectId) {
          persistedExecutionWorkspace = threadOutcome.existingWorkspaceRow
            ? await executionWorkspacesSvc.update(threadOutcome.persistedWorkspaceId, {
                cwd: threadOutcome.realizedWorkspace.cwd,
                repoUrl: threadOutcome.realizedWorkspace.repoUrl,
                baseRef: threadOutcome.realizedWorkspace.repoRef,
                branchName: threadOutcome.realizedWorkspace.branchName,
                providerType: threadOutcome.realizedWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
                providerRef: threadOutcome.realizedWorkspace.worktreePath,
                status: "active",
                lastUsedAt: new Date(),
                metadata: {
                  ...(threadOutcome.existingWorkspaceRow.metadata ?? {}),
                  source: threadOutcome.realizedWorkspace.source,
                  createdByRuntime: threadOutcome.created,
                },
              })
            : null;
        }

        // Populate context with execution workspace details (mirrors existing path).
        context.aoaWorkspace = {
          cwd: threadOutcome.realizedWorkspace.cwd,
          source: threadOutcome.realizedWorkspace.source,
          mode: executionWorkspaceMode,
          strategy: threadOutcome.realizedWorkspace.strategy,
          projectId: threadOutcome.realizedWorkspace.projectId,
          workspaceId: threadOutcome.realizedWorkspace.workspaceId,
          repoUrl: threadOutcome.realizedWorkspace.repoUrl,
          repoRef: threadOutcome.realizedWorkspace.repoRef,
          branchName: threadOutcome.realizedWorkspace.branchName,
          worktreePath: threadOutcome.realizedWorkspace.worktreePath,
          agentHome: await (async () => {
            const home = resolveDefaultAgentWorkspaceDir(agent.id);
            await fs.mkdir(home, { recursive: true });
            return home;
          })(),
        };

        if (threadOutcome.realizedWorkspace.projectId && !readNonEmptyString(context.projectId)) {
          context.projectId = threadOutcome.realizedWorkspace.projectId;
        }

        if (issueId && persistedExecutionWorkspace) {
          const nextIssueWorkspaceMode = issueExecutionWorkspaceModeForPersistedWorkspace(persistedExecutionWorkspace.mode);
          const shouldSwitchIssueToExistingWorkspace =
            issueRef?.executionWorkspacePreference === "reuse_existing" ||
            executionWorkspaceMode === "isolated_workspace" ||
            executionWorkspaceMode === "operator_branch";
          const nextIssuePatch: Record<string, unknown> = {};
          if (issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
            nextIssuePatch.executionWorkspaceId = persistedExecutionWorkspace.id;
          }
          if (shouldSwitchIssueToExistingWorkspace) {
            nextIssuePatch.executionWorkspacePreference = "reuse_existing";
            nextIssuePatch.executionWorkspaceSettings = {
              ...(issueExecutionWorkspaceSettings ?? {}),
              mode: nextIssueWorkspaceMode,
            };
          }
          if (Object.keys(nextIssuePatch).length > 0) {
            await db
              .update(issues)
              .set({ ...nextIssuePatch, updatedAt: new Date() })
              .where(eq(issues.id, issueId));
          }
        }

        if (persistedExecutionWorkspace) {
          context.executionWorkspaceId = persistedExecutionWorkspace.id;
          await db
            .update(heartbeatRuns)
            .set({
              contextSnapshot: context,
              updatedAt: new Date(),
            })
            .where(eq(heartbeatRuns.id, run.id));
        }

        // Skip the rest of the isolatedWorkspacesEnabled block (existing path).
        // Fall through to context.aoaWorkspaces assignment below.
      } else {
      // ── Existing per-task workspace path (UNCHANGED) ──────────────────────
      const issueScopedExecutionWorkspace =
        issueRef?.id && !issueRef.executionWorkspaceId
          ? (await executionWorkspacesSvc.list(agent.companyId, {
              issueId: issueRef.id,
              reuseEligible: true,
            }))[0] ?? null
          : null;
      const existingExecutionWorkspace =
        issueRef?.executionWorkspaceId
          ? await executionWorkspacesSvc.getById(issueRef.executionWorkspaceId)
          : issueScopedExecutionWorkspace;
      const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
        companyId: agent.companyId,
        heartbeatRunId: run.id,
        executionWorkspaceId: existingExecutionWorkspace?.id ?? null,
      });
      // Short-circuit: if issue prefers reusing an existing workspace, build the
      // realized descriptor from the persisted row instead of re-provisioning.
      const shouldReuseExisting = shouldUsePersistedExecutionWorkspaceForRun({
        issueExecutionWorkspaceId: issueRef?.executionWorkspaceId,
        issueExecutionWorkspacePreference: issueRef?.executionWorkspacePreference,
        hasIssueScopedExecutionWorkspace: Boolean(issueScopedExecutionWorkspace),
        existingExecutionWorkspaceStatus: existingExecutionWorkspace?.status ?? null,
      });
      const realizeBase = {
        baseCwd: resolvedWorkspace.cwd,
        source: resolvedWorkspace.source,
        projectId: resolvedWorkspace.projectId,
        workspaceId: resolvedWorkspace.workspaceId,
        repoUrl: resolvedWorkspace.repoUrl,
        repoRef: resolvedWorkspace.repoRef,
      };
      const executionWorkspace = shouldReuseExisting && existingExecutionWorkspace
        ? await ensurePersistedExecutionWorkspaceAvailable(
            existingExecutionWorkspace,
            realizeBase,
            workspaceOperationRecorder,
          )
        : await realizeExecutionWorkspace({
            base: realizeBase,
            config: resolvedConfig,
            issue: issueRef,
            agent: {
              id: agent.id,
              name: agent.name,
              companyId: agent.companyId,
            },
            recorder: workspaceOperationRecorder,
          });
      effectiveCwd = executionWorkspace.cwd;
      executionWorkspaceWarnings = executionWorkspace.warnings;
      realizedWorkspace = executionWorkspace;
      const resolvedProjectId = executionWorkspace.projectId ?? issueRef?.projectId ?? executionProjectId ?? null;
      const resolvedProjectWorkspaceId = resolvedWorkspace.workspaceId ?? null;
      const concurrentlyPersistedExecutionWorkspace =
        !shouldReuseExisting && issueRef?.id && !executionWorkspace.created
          ? selectConcurrentPersistedExecutionWorkspace({
              realizedWorkspace: executionWorkspace,
              candidates: await executionWorkspacesSvc.list(agent.companyId, {
                issueId: issueRef.id,
                reuseEligible: true,
              }),
            })
          : null;
      const workspaceToUpdate = shouldReuseExisting && existingExecutionWorkspace
        ? existingExecutionWorkspace
        : concurrentlyPersistedExecutionWorkspace;

      // Snapshot the workspace config at creation so it survives across runs
      // (provisionCommand / teardownCommand / cleanupCommand / workspaceRuntime).
      // desiredState / serviceStates remain null placeholders for Task 7.
      const workspaceStrategyObject = parseObject(workspaceManagedConfig.workspaceStrategy);
      const workspaceRuntimeObject = parseObject(workspaceManagedConfig.workspaceRuntime);
      const configSnapshot = {
        provisionCommand: typeof workspaceStrategyObject.provisionCommand === "string"
          ? workspaceStrategyObject.provisionCommand
          : null,
        teardownCommand: typeof workspaceStrategyObject.teardownCommand === "string"
          ? workspaceStrategyObject.teardownCommand
          : null,
        cleanupCommand: typeof workspaceStrategyObject.cleanupCommand === "string"
          ? workspaceStrategyObject.cleanupCommand
          : null,
        workspaceRuntime: Object.keys(workspaceRuntimeObject).length > 0 ? workspaceRuntimeObject : null,
        desiredState: null as "running" | "stopped" | null,
        serviceStates: null as Record<string, "running" | "stopped"> | null,
      };
      const hasConfigSnapshot = configSnapshot.provisionCommand !== null
        || configSnapshot.teardownCommand !== null
        || configSnapshot.cleanupCommand !== null
        || configSnapshot.workspaceRuntime !== null;

      // ── Persist execution workspace ─────────────────────────────────
      try {
        persistedExecutionWorkspace = workspaceToUpdate
          ? workspaceToUpdate.updatedAt
            ? await executionWorkspacesSvc.updateIfVersion(workspaceToUpdate.id, workspaceToUpdate.updatedAt, {
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: executionWorkspace.branchName,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              status: "active",
              lastUsedAt: new Date(),
              metadata: {
                ...(workspaceToUpdate.metadata ?? {}),
                source: executionWorkspace.source,
                createdByRuntime: executionWorkspace.created,
              },
              }, ["active", "idle", "in_review"])
            : null
          : resolvedProjectId
            ? await executionWorkspacesSvc.createTaskOwnedIdempotent({
                companyId: agent.companyId,
                projectId: resolvedProjectId,
                projectWorkspaceId: resolvedProjectWorkspaceId,
                sourceIssueId: issueRef?.id ?? null,
                mode:
                  executionWorkspaceMode === "isolated_workspace"
                    ? "isolated_workspace"
                    : executionWorkspaceMode === "operator_branch"
                      ? "operator_branch"
                      : executionWorkspaceMode === "agent_default"
                        ? "adapter_managed"
                        : "shared_workspace",
                strategyType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
                name: executionWorkspace.branchName ?? issueRef?.identifier ?? `workspace-${agent.id.slice(0, 8)}`,
                status: "active",
                cwd: executionWorkspace.cwd,
                repoUrl: executionWorkspace.repoUrl,
                baseRef: executionWorkspace.repoRef,
                branchName: executionWorkspace.branchName,
                providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
                providerRef: executionWorkspace.worktreePath,
                lastUsedAt: new Date(),
                openedAt: new Date(),
                metadata: {
                  source: executionWorkspace.source,
                  createdByRuntime: executionWorkspace.created,
                  ...(hasConfigSnapshot ? { config: configSnapshot } : {}),
                },
              })
            : null;
        if (workspaceToUpdate && !persistedExecutionWorkspace) {
          const reFetched = await executionWorkspacesSvc.getById(workspaceToUpdate.id);
          if (reFetched && reFetched.status !== "archived") {
            persistedExecutionWorkspace = await executionWorkspacesSvc.update(workspaceToUpdate.id, {
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: executionWorkspace.branchName,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              status: "active",
              lastUsedAt: new Date(),
              metadata: {
                ...(reFetched.metadata ?? {}),
                source: executionWorkspace.source,
                createdByRuntime: executionWorkspace.created,
              },
            });
          }
        }
        if (workspaceToUpdate && !persistedExecutionWorkspace) {
          throw new Error("Execution workspace changed or became unavailable before the run could claim it");
        }
      } catch (error) {
        if (executionWorkspace.created) {
          try {
            await cleanupExecutionWorkspaceArtifacts({
              workspace: {
                id: existingExecutionWorkspace?.id ?? `transient-${run.id}`,
                cwd: executionWorkspace.cwd,
                providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
                providerRef: executionWorkspace.worktreePath,
                branchName: executionWorkspace.branchName,
                repoUrl: executionWorkspace.repoUrl,
                baseRef: executionWorkspace.repoRef,
                projectId: resolvedProjectId,
                projectWorkspaceId: resolvedProjectWorkspaceId,
                sourceIssueId: issueRef?.id ?? null,
                metadata: {
                  createdByRuntime: true,
                  source: executionWorkspace.source,
                },
              },
              projectWorkspace: {
                cwd: resolvedWorkspace.cwd,
                cleanupCommand: null,
              },
              cleanupCommand: configSnapshot.cleanupCommand,
              teardownCommand: projectExecutionWorkspacePolicy?.workspaceStrategy?.teardownCommand ?? null,
              recorder: workspaceOperationRecorder,
            });
          } catch (cleanupError) {
            logger.warn(
              {
                runId: run.id,
                issueId,
                executionWorkspaceCwd: executionWorkspace.cwd,
                cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              },
              "Failed to cleanup realized execution workspace after persistence failure",
            );
          }
        }
        throw error;
      }
      await workspaceOperationRecorder.attachExecutionWorkspaceId(persistedExecutionWorkspace?.id ?? null);

      // ── Reconcile old execution workspace ───────────────────────────
      if (
        existingExecutionWorkspace &&
        persistedExecutionWorkspace &&
        existingExecutionWorkspace.id !== persistedExecutionWorkspace.id &&
        existingExecutionWorkspace.status === "active"
      ) {
        await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
          status: "idle",
          cleanupReason: null,
        });
      }

      // ── Update issue with execution workspace link ──────────────────
      if (issueId && persistedExecutionWorkspace) {
        const nextIssueWorkspaceMode = issueExecutionWorkspaceModeForPersistedWorkspace(persistedExecutionWorkspace.mode);
        const shouldSwitchIssueToExistingWorkspace =
          issueRef?.executionWorkspacePreference === "reuse_existing" ||
          executionWorkspaceMode === "isolated_workspace" ||
          executionWorkspaceMode === "operator_branch";
        const nextIssuePatch: Record<string, unknown> = {};
        if (issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
          nextIssuePatch.executionWorkspaceId = persistedExecutionWorkspace.id;
        }
        if (shouldSwitchIssueToExistingWorkspace) {
          nextIssuePatch.executionWorkspacePreference = "reuse_existing";
          nextIssuePatch.executionWorkspaceSettings = {
            ...(issueExecutionWorkspaceSettings ?? {}),
            mode: nextIssueWorkspaceMode,
          };
        }
        if (Object.keys(nextIssuePatch).length > 0) {
          await db
            .update(issues)
            .set({ ...nextIssuePatch, updatedAt: new Date() })
            .where(eq(issues.id, issueId));
        }
      }

      // ── Snapshot execution workspace into run context ────────────────
      if (persistedExecutionWorkspace) {
        context.executionWorkspaceId = persistedExecutionWorkspace.id;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
      }

      // ── Populate context with execution workspace details ───────────
      context.aoaWorkspace = {
        cwd: executionWorkspace.cwd,
        source: executionWorkspace.source,
        mode: executionWorkspaceMode,
        strategy: executionWorkspace.strategy,
        projectId: executionWorkspace.projectId,
        workspaceId: executionWorkspace.workspaceId,
        repoUrl: executionWorkspace.repoUrl,
        repoRef: executionWorkspace.repoRef,
        branchName: executionWorkspace.branchName,
        worktreePath: executionWorkspace.worktreePath,
        agentHome: await (async () => {
          const home = resolveDefaultAgentWorkspaceDir(agent.id);
          await fs.mkdir(home, { recursive: true });
          return home;
        })(),
      };

      if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
        context.projectId = executionWorkspace.projectId;
      }
      } // end else (existing per-task workspace path)
    } else {
      // ── Isolated workspaces disabled — use resolvedWorkspace directly ──
      context.aoaWorkspace = {
        cwd: resolvedWorkspace.cwd,
        source: resolvedWorkspace.source,
        mode: executionWorkspaceMode,
        strategy: "project_primary" as const,
        projectId: resolvedWorkspace.projectId,
        workspaceId: resolvedWorkspace.workspaceId,
        repoUrl: resolvedWorkspace.repoUrl,
        repoRef: resolvedWorkspace.repoRef,
        branchName: null,
        worktreePath: null,
        agentHome: await (async () => {
          const home = resolveDefaultAgentWorkspaceDir(agent.id);
          await fs.mkdir(home, { recursive: true });
          return home;
        })(),
      };

      if (resolvedWorkspace.projectId && !readNonEmptyString(context.projectId)) {
        context.projectId = resolvedWorkspace.projectId;
      }
    }
    context.aoaWorkspaces = resolvedWorkspace.workspaceHints;

    // ── Session resolution with effective workspace cwd ──────────────
    const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
      agentId: agent.id,
      previousSessionParams,
      resolvedWorkspace: {
        ...resolvedWorkspace,
        cwd: effectiveCwd,
      },
    });
    const runtimeSessionParams = runtimeSessionResolution.sessionParams;
    const runtimeWorkspaceWarnings = [
      ...resolvedWorkspace.warnings,
      ...executionWorkspaceWarnings,
      ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
      ...(resetTaskSession && sessionResetReason
        ? [
            taskKey
              ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
              : `Skipping saved session resume because ${sessionResetReason}.`,
          ]
        : []),
    ];

    // ── Runtime service intents ─────────────────────────────────────
    const runtimeServiceIntents = (() => {
      const runtimeConfig = parseObject(resolvedConfig.workspaceRuntime);
      return Array.isArray(runtimeConfig.services)
        ? runtimeConfig.services.filter(
            (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
          )
        : [];
    })();
    if (runtimeServiceIntents.length > 0) {
      context.aoaRuntimeServiceIntents = runtimeServiceIntents;
    } else {
      delete context.aoaRuntimeServiceIntents;
    }

    // Enrich context with memory items and company info for the agent
    // Memory injection is enabled by default; agents can opt-out via runtimeConfig.injectCompanyContext = false
    const agentRc = parseObject(agent.runtimeConfig);
    const injectCompanyContext = agentRc.injectCompanyContext !== false;
    if (injectCompanyContext) {
      try {
        const agentContextMode = (agentRc.contextMode as string) ?? "standard";
        const memoryContext = await fetchMemoryContext(
          agent.companyId,
          issueId,
          agentContextMode,
          { agentId: agent.id, runId: run.id },
        );
        if (memoryContext.company) {
          context.company = memoryContext.company;
        }
        if (memoryContext.memory.length > 0) {
          context.memory = memoryContext.memory;
        }
        // Always-on core (P1-T6, scenario O5): a tiny deterministic block —
        // role + current goal + a "call memory.search" pointer — set on EVERY
        // run independent of retrieval ranking/limit, so an agent never starts
        // without knowing its role and that a searchable company brain exists.
        // Set unconditionally (not gated on memory results); mirrors the sibling
        // context.memory contract.
        context.memory_core = buildAlwaysOnCore({
          agentRole: agent.role ?? agent.name ?? null,
          goalTitle: memoryContext.goalTitle,
        });
      } catch (err) {
        logger.warn(
          { companyId: agent.companyId, agentId: agent.id, runId: run.id, err },
          "Failed to fetch memory context for agent run; continuing without memory enrichment",
        );
      }
    }

    // Enrich context with completed dependency task outputs
    if (issueId) {
      try {
        const depOutputs = await fetchDependencyOutputs(agent.companyId, issueId);
        if (depOutputs.length > 0) {
          context.dependency_outputs = depOutputs;
        }
      } catch (err) {
        logger.warn(
          { companyId: agent.companyId, agentId: agent.id, runId: run.id, issueId, err },
          "Failed to fetch dependency outputs for agent run; continuing without dependency context",
        );
      }
    }

    if (issueId) {
      try {
        const runInputBundle = await buildRunInputBundle({
          db,
          companyId: agent.companyId,
          issueId,
          cwd: effectiveCwd,
        });
        if (runInputBundle.inputs.length > 0 || runInputBundle.skipped.length > 0) {
          context.runInputBundle = runInputBundle;
          const existingTaskMarkdown =
            typeof context.currentTaskMarkdown === "string" ? context.currentTaskMarkdown : "";
          context.currentTaskMarkdown = [existingTaskMarkdown, runInputBundle.markdown]
            .filter((section) => section.trim().length > 0)
            .join("\n\n");
        }
      } catch (err) {
        logger.warn(
          { companyId: agent.companyId, agentId: agent.id, runId: run.id, issueId, err },
          "Failed to build run input bundle for agent run; continuing without selected context",
        );
      }
    }

    const runtimeSessionFallback = taskKey || resetTaskSession ? null : runtime.sessionId;
    let previousSessionDisplayId = truncateDisplayId(
      taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    let runtimeSessionIdForAdapter =
      readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback;
    let runtimeSessionParamsForAdapter = runtimeSessionParams;

    const sessionCompaction = await evaluateSessionCompaction({
      agent,
      sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
      issueId,
    });
    if (sessionCompaction.rotate) {
      context.aoaSessionHandoffMarkdown = sessionCompaction.handoffMarkdown;
      context.aoaSessionRotationReason = sessionCompaction.reason;
      context.aoaPreviousSessionId = previousSessionDisplayId ?? runtimeSessionIdForAdapter;
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      if (sessionCompaction.reason) {
        runtimeWorkspaceWarnings.push(
          `Starting a fresh session because ${sessionCompaction.reason}.`,
        );
      }
    } else {
      delete context.aoaSessionHandoffMarkdown;
      delete context.aoaSessionRotationReason;
      delete context.aoaPreviousSessionId;
    }

    const runtimeForAdapter = {
      sessionId: runtimeSessionIdForAdapter,
      sessionParams: runtimeSessionParamsForAdapter,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };

    let seq = 1;
    let handle: RunLogHandle | null = null;
    let stdoutExcerpt = "";
    let stderrExcerpt = "";

    try {
      const startedAt = run.startedAt ?? new Date();
      const runningWithSession = await db
        .update(heartbeatRuns)
        .set({
          startedAt,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (runningWithSession) run = runningWithSession;

      const runningAgent = await db
        .update(agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (runningAgent) {
        publishLiveEvent({
          companyId: runningAgent.companyId,
          type: "agent.status",
          payload: {
            agentId: runningAgent.id,
            status: runningAgent.status,
            outcome: "running",
          },
        });
      }

      const currentRun = run;
      await appendRunEvent(currentRun, seq++, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
      });

      handle = await runLogStore.begin({
        companyId: run.companyId,
        agentId: run.agentId,
        runId,
      });

      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));

      const onLog = async (stream: "stdout" | "stderr" | "system", chunk: string) => {
        if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, chunk);
        if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, chunk);

        if (handle) {
          await runLogStore.append(handle, {
            stream,
            chunk,
            ts: new Date().toISOString(),
          });
        }

        const payloadChunk =
          chunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? chunk.slice(chunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : chunk;

        publishLiveEvent({
          companyId: run.companyId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            stream,
            chunk: payloadChunk,
            truncated: payloadChunk.length !== chunk.length,
          },
        });
      };
      for (const warning of runtimeWorkspaceWarnings) {
        await onLog("stderr", `[aoa] ${warning}\n`);
      }

      // ── Runtime services (ensureRuntimeServicesForRun) ──────────────
      // R3 (Wave 2 review): acquireExecutionContext is now called
      // UNCONDITIONALLY for every org run, mirroring crew's runner.ts
      // pattern (`environmentId: agent.defaultEnvironmentId ?? null`)
      // exactly. It used to be gated INSIDE `if (environmentRuntime
      // .environmentId)` (true only for a PINNED task/agent env) — an org
      // agent with NO pinned env never reached this call, never resolved
      // the U1 platform default, and ran UNSANDBOXED on the host, which the
      // U8 D1 guard then refuses on cloud_auth. Passing
      // `environmentRuntime.environmentId ?? null` keeps the pinned path
      // byte-identical (non-null -> acquireForRun resolves that pin
      // directly, same as before) and adds the unpinned path: null ->
      // acquireForRun's orchestrator resolves the materialized
      // platform-default E2B sandbox on cloud_auth (S1/U1b), or throws
      // `environment_not_found` on desktop/local_trusted, which
      // acquireExecutionContext catches and returns `{ sandbox: null }` —
      // byte-identical to today's local/desktop behavior (see the S1
      // contract doc-comment on acquire-execution-context.ts). The lease is
      // still tagged `heartbeatRunId: run.id`, so the existing org reaper
      // (`environmentRuntimeService(db).releaseRunLeases(run.id)` in the
      // run's `finally`, unconditional regardless of pinned/platform-default)
      // reaps a platform-default lease exactly like a pinned one — no leak.
      // orgAcquired is captured for U4b to read (mcpParams.brokered) before
      // prepareHeartbeatMcpDelivery.
      //
      // U11: a PRE-acquire, best-effort estimate of the hosts this run's
      // connectors might need, fed into the acquire's egressAllowlist. Real
      // connector resolution (further below) happens AFTER this acquire
      // (its own sandboxTarget input comes FROM orgAcquired), so the actual
      // delivered set cannot be known yet — this is deliberately optimistic
      // (see loadConnectorEgressHosts' doc-comment) and never throws.
      const orgEgressHosts = adapterSupportsConnectors(agent.adapterType)
        ? await loadConnectorEgressHosts(db, { companyId: agent.companyId, agentId: agent.id })
        : [];
      // U7.5 — resolve the warm-reuse decision for this org run. `functionType`
      // comes from the run's project (`projects.function_type`); warm defaults
      // on for `software_development` gated by the instance baseline, unless the
      // per-agent `runtimeConfig.warmWorkspace` override forces it either way.
      // The pure resolver (`resolveWarmSandboxPreference`, U7.2) is the single
      // source of truth so org/crew/Commander cannot drift.
      let orgFunctionType: string | null = null;
      if (executionProjectId) {
        const [projectRow] = await db
          .select({ functionType: projects.functionType })
          .from(projects)
          .where(eq(projects.id, executionProjectId))
          .limit(1);
        orgFunctionType = projectRow?.functionType ?? null;
      }
      const orgWarmDecision = resolveWarmSandboxPreference({
        runType: "org",
        functionType: orgFunctionType,
        agentWarmOverride: readAgentWarmOverride(agent.runtimeConfig),
        instanceDefaultWarmForSoftwareDev:
          (await instanceSettingsService(db).getExperimental()).warmSandboxDefaultForSoftwareDev,
      });
      const orgAcquired = await acquireExecutionContext(db, {
        runIdentity: {
          companyId: agent.companyId,
          agentId: agent.id,
          runId: run.id,
          adapterType: agent.adapterType,
        },
        // functionType now resolved above for warm; kept on runIdentity's agentId
        // is the warm key. This field stays null (the resolver already consumed
        // the real functionType) — behavior-neutral for the acquire itself.
        functionType: orgFunctionType,
        warmPreference: orgWarmDecision.warm,
        worktree: persistedExecutionWorkspace
          ? { id: persistedExecutionWorkspace.id, mode: persistedExecutionWorkspace.mode }
          : null,
        environmentId: environmentRuntime.environmentId ?? null, // pinned env, or null -> platform default (R3)
        issueId,
        heartbeatRunId: run.id,
        egressAllowlist: orgEgressHosts,
      });
      // U4b: heartbeatMcpParams.brokered (built further below, before
      // prepareHeartbeatMcpDelivery) reads orgAcquired.sandbox?.environment
      // .driver captured here.
      //
      // R3: applyEnvironmentAcquisitionConfig is now unconditional too — it
      // is a documented no-op (returns `resolvedConfig` by the SAME
      // reference, unchanged) when `orgAcquired.sandbox` is null, which is
      // exactly the desktop/local_trusted case, so that path stays
      // byte-identical. When `orgAcquired.sandbox` IS non-null (pinned OR
      // platform-default), its configPatch is spread here LAST — after
      // `mergedConfigWithEnvironmentTarget`'s `environmentRuntime.target`
      // (pinned-env only, applied far above) and after the P5 shared-pool
      // `routedExecutionTarget` (`mergeResolvedExecutionTarget`, also
      // applied above) — so the acquired sandbox's executionTarget is
      // always the authoritative, LAST-applied one; a pinned env's
      // `environmentRuntime.target` and `orgAcquired.sandbox`'s configPatch
      // both derive from the SAME resolved environment row so they already
      // agree there. This last-applied-wins ordering is unchanged from
      // before R3 (it applied whenever the old gate was true) — it is just
      // no longer conditional on a pin existing.
      const resolvedConfigWithEnvironmentAcquisition = applyEnvironmentAcquisitionConfig(
        resolvedConfig,
        orgAcquired.sandbox,
      );

      const adapterEnv = Object.fromEntries(
        Object.entries(parseObject(resolvedConfigWithEnvironmentAcquisition.env)).filter(
          (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      );
      let runtimeServices: Awaited<ReturnType<typeof ensureRuntimeServicesForRun>> = [];
      if (isolatedWorkspacesEnabled && realizedWorkspace) {
        runtimeServices = await ensureRuntimeServicesForRun({
          db,
          runId: run.id,
          agent: {
            id: agent.id,
            name: agent.name,
            companyId: agent.companyId,
          },
          issue: issueRef,
          workspace: realizedWorkspace,
          executionWorkspaceId: persistedExecutionWorkspace?.id ?? issueRef?.executionWorkspaceId ?? null,
          config: resolvedConfigWithEnvironmentAcquisition,
          adapterEnv,
          onLog,
          activationGuard: persistedExecutionWorkspace
            ? async () => {
                const current = await executionWorkspacesSvc.getById(persistedExecutionWorkspace!.id);
                return Boolean(
                  current &&
                  ["active", "idle", "in_review"].includes(current.status) &&
                  String(current.updatedAt) === String(persistedExecutionWorkspace!.updatedAt)
                );
              }
            : undefined,
        });
        if (runtimeServices.length > 0) {
          context.aoaRuntimeServices = runtimeServices;
          context.aoaRuntimePrimaryUrl =
            runtimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
          await db
            .update(heartbeatRuns)
            .set({
              contextSnapshot: context,
              updatedAt: new Date(),
            })
            .where(eq(heartbeatRuns.id, run.id));
        }
        if (issueId && runtimeServices.some((service) => !service.reused)) {
          try {
            await db.insert(issueComments).values({
              companyId: agent.companyId,
              issueId,
              authorAgentId: agent.id,
              authorUserId: null,
              body: buildWorkspaceReadyComment({
                workspace: realizedWorkspace,
                runtimeServices,
              }),
            });
          } catch (err) {
            await onLog(
              "stderr",
              `[aoa] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
      }

      const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: meta as unknown as Record<string, unknown>,
        });
      };

      const adapter = getServerAdapter(agent.adapterType);
      const authToken = adapter.supportsLocalAgentJwt
        ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, run.id)
        : null;
      if (adapter.supportsLocalAgentJwt && !authToken) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            adapterType: agent.adapterType,
          },
          "local agent jwt secret missing or invalid; running without injected AOA_API_KEY",
        );
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.auth.warning",
          stream: "system",
          level: "warn",
          message: "Agent API auth was not injected for this local run.",
          payload: {
            adapterType: agent.adapterType,
            reason: "local_agent_jwt_missing",
          },
        });
      }
      // Fetch company skills attached to this agent and inject into context
      try {
        const skillSvc = companySkillService(db);
        const agentSkills = await skillSvc.listRuntimeSkillEntries(agent.companyId, agent.id);
        logger.info(
          { companyId: agent.companyId, agentId: agent.id, runId: run.id, skillCount: agentSkills.length, skillKeys: agentSkills.map(s => s.key) },
          "Fetched company skills for agent run",
        );
        if (agentSkills.length > 0) {
          context.skills = agentSkills;
        }
      } catch (err) {
        logger.warn(
          { companyId: agent.companyId, agentId: agent.id, runId: run.id, err },
          "Failed to fetch company skills for agent run; continuing without skill injection",
        );
      }

      // Inject team coordinations as skill-shaped entries into context.skills.
      // Adapters already materialize context.skills as files in skillsDir, so the
      // CLI discovers team coordinations via its skill mechanism — no adapter
      // changes needed.
      //
      // SAFETY:
      //   1. Feature-flag gate (companies.enableTeams) is the first query inside try.
      //   2. try/catch isolates failures — never breaks the heartbeat run.
      //   3. Append-only merge into context.skills — preserves any prior skills.
      //   4. Sanitized error logging — never logs raw err (may contain SQL/credentials).
      try {
        const teamCoordEntries = await buildTeamCoordinationSkillEntries(
          db,
          agent.companyId,
          agent.id,
        );
        if (teamCoordEntries.length > 0) {
          const prior = context.skills;
          const existing: RuntimeSkillEntry[] = Array.isArray(prior) ? (prior as RuntimeSkillEntry[]) : [];
          context.skills = [...existing, ...teamCoordEntries];
          logger.info(
            {
              companyId: agent.companyId,
              agentId: agent.id,
              runId: run.id,
              coordCount: teamCoordEntries.length,
            },
            "Injected team coordinations into context.skills",
          );
        }
      } catch (err) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
          },
          "Failed to fetch team coordinations for agent run; continuing without team injection",
        );
      }

      // Synthesize a `company-knowledge` skill from founder-pinned
      // memory items and inject it as a skill-shaped entry alongside the others.
      // Resolution: agent's memoryProfile.pinnedSkillItems config drives which
      // items get materialized (department inheritance + per-agent additions/
      // removals). See server/src/services/memory-skill-sync.ts for the algo.
      //
      // SAFETY:
      //   1. try/catch isolates failures — never breaks the heartbeat run.
      //   2. Append-only merge into context.skills — preserves prior skills.
      //   3. Sanitized error logging — never logs raw err (may contain
      //      SQL/credentials).
      try {
        const pinnedMemoryEntries = await buildPinnedMemorySkillEntries(
          db,
          agent.companyId,
          agent.id,
        );
        if (pinnedMemoryEntries.length > 0) {
          const prior = context.skills;
          const existing: RuntimeSkillEntry[] = Array.isArray(prior) ? (prior as RuntimeSkillEntry[]) : [];
          context.skills = [...existing, ...pinnedMemoryEntries];
          logger.info(
            {
              companyId: agent.companyId,
              agentId: agent.id,
              runId: run.id,
              pinnedSkillCount: pinnedMemoryEntries.length,
            },
            "Injected pinned memory items as company-knowledge skill",
          );
        }
      } catch (err) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
          },
          "Failed to synthesize pinned-memory skill for agent run; continuing without",
        );
      }

      // Inject available plugin tools into context
      try {
        const pluginToolDispatcher: PluginToolDispatcher | undefined =
          (globalThis as any).__aoaPluginToolDispatcher;
        if (pluginToolDispatcher) {
          const pluginTools = pluginToolDispatcher.listToolsForAgent({ companyId: agent.companyId });
          if (pluginTools.length > 0) {
            context.pluginTools = pluginTools.map((t: { name: string; displayName: string; description: string }) => ({
              name: t.name,
              displayName: t.displayName,
              description: t.description,
            }));
          }
        }
      } catch (err) {
        logger.warn(
          { companyId: agent.companyId, agentId: agent.id, runId: run.id, err },
          "Failed to fetch plugin tools for agent run; continuing without plugin tool injection",
        );
      }

      // ── Auto-enable skills mentioned in the issue body/comments ──────
      let runScopedConfig: Record<string, unknown> = resolvedConfigWithEnvironmentAcquisition;
      // Phase 4: the standalone subscription-home block that used to live here
      // (company-key-present check → dedicated-target throw → resolveAgentSubscription
      // Environment → mayUseLegacySubscriptionHome) has been folded into the unified
      // resolver above — specifically the `legacySubscriptionEnv` closure of `hbDeps`,
      // which the resolver's legacy fallback invokes. `resolvedConfig` (and therefore
      // `runScopedConfig`) already carries any subscription-home env. The
      // dedicated-target throw is preserved in that closure (marked "P5 REBASE
      // TARGET"). Nothing else in this section changed.
      try {
        const mentionedSkillKeys = await resolveRunScopedMentionedSkillKeys(
          db,
          agent.companyId,
          issueId,
        );
        // Preserve any run-local credential environment resolved immediately
        // above. Re-starting from the pre-binding config silently discarded the
        // governed CODEX_HOME/CLAUDE_CONFIG_DIR before adapter execution.
        runScopedConfig = applyRunScopedMentionedSkillKeys(runScopedConfig, mentionedSkillKeys);
        if (mentionedSkillKeys.length > 0) {
          logger.info(
            {
              companyId: agent.companyId,
              agentId: agent.id,
              runId: run.id,
              skills: mentionedSkillKeys,
              issueId,
            },
            "[heartbeat] auto-enabled run-scoped skills from issue mentions",
          );
        }
      } catch (err) {
        logger.warn(
          { companyId: agent.companyId, agentId: agent.id, runId: run.id, err },
          "Failed to resolve run-scoped mentioned skills; continuing without auto-enable",
        );
      }

      // ── Cheap-model fallback (D4) ─────────────────────────────────────
      try {
        if (isCheapRecoveryWake(run.contextSnapshot as Record<string, unknown> | null)) {
          const recoveryCheapModel = await resolveRecoveryCheapModel(db, agent.companyId);
          if (recoveryCheapModel) {
            runScopedConfig = { ...runScopedConfig, model: recoveryCheapModel };
            logger.info(
              { companyId: agent.companyId, agentId: agent.id, runId: run.id, cheapModel: recoveryCheapModel },
              "[heartbeat] recovery cheap-profile active - using cheap model",
            );
          }
        } else if (agent.budgetMonthlyCents > 0) {
          const cheapModel = await resolveCheapFallbackModel(
            db,
            agent.companyId,
            agent.id,
            agent.budgetMonthlyCents,
          );
          if (cheapModel) {
            runScopedConfig = { ...runScopedConfig, model: cheapModel };
            logger.info(
              { companyId: agent.companyId, agentId: agent.id, runId: run.id, cheapModel },
              "[heartbeat] cost-saver fallback active — using cheap model",
            );
          }
        }
      } catch (err) {
        logger.warn(
          { companyId: agent.companyId, agentId: agent.id, runId: run.id, err },
          "[heartbeat] cheap-fallback check failed; continuing with original model",
        );
      }

      // Provider-switching (org/heartbeat): resolve the model auth-aware + shell-safe.
      // Runs AFTER the cheap-model swaps above (edge #5) so we resolve the model that
      // will run. Best-effort detection; a failure falls back to authMode "unknown".
      //
      // The merged runtime env (runScopedConfig.env) is left intact for the run:
      // a project/environment key still reaches the workspace, and the codex
      // adapter strips only the AMBIENT server key from the spawn (execute.ts
      // unsetEnvKeys) — we do NOT strip the merged key here.
      //
      // Detection env = what the run will actually authenticate with: the agent's
      // OWN env plus the company provider-key fallback (the last stop before host
      // login), but NOT project/environment keys (app/test creds, not codex auth).
      // agentEnvRecord alone omitted the company key, so a codex agent on ONLY the
      // company Providers key was misread as ChatGPT-mode and had its api-key-only
      // model (gpt-*-codex) rewritten to the ChatGPT default even though the run
      // has OPENAI_API_KEY. Build it from the resolved runtime env (which includes
      // the company fallback, already resolved) minus the project/environment keys.
      const projectOrEnvironmentEnvKeys = new Set(
        [...winningEnvSource.entries()]
          .filter(([, source]) => source === "project" || source === "environment")
          .map(([key]) => key),
      );
      const authDetectionEnv = Object.fromEntries(
        Object.entries(parseObject(resolvedConfig.env)).filter(
          ([key]) => !projectOrEnvironmentEnvKeys.has(key),
        ),
      );
      let providerStatus: ProviderStatus;
      try {
        providerStatus = await getProviderStatus(
          agent.adapterType,
          { companyId: agent.companyId, adapterConfig: { ...runScopedConfig, env: authDetectionEnv } },
          realProviderStatusDeps,
        );
      } catch (statusErr) {
        logger.warn({ err: statusErr, companyId: agent.companyId, agentId: agent.id, runId: run.id }, "[heartbeat] provider status detection failed (best-effort fallback to unknown)");
        providerStatus = { adapterType: agent.adapterType, installed: true, authenticated: false, authMode: "unknown", defaultModelResolved: null };
      }
      runScopedConfig = resolveRunScopedModel(agent.adapterType, runScopedConfig, providerStatus, { inheritedEnvOpenAiKey: process.env.OPENAI_API_KEY ?? null });

      // Organization-agent heartbeat runs use the same provider-neutral AoA
      // MCP bridge as crew runs. Role and per-tool service checks remain the
      // authority boundary; capabilities only enable the bridge categories.
      // D18: org-agent heartbeat runs are AGENT WORK, so they read the agent-work
      // dial (`crew_autonomy_level`) — never Commander's `autonomy_level`.
      const [companyAutonomyRow, discussionAutonomyRow] = await Promise.all([
        db
          .select({ autonomyLevel: internalAgentConfig.crewAutonomyLevel })
          .from(internalAgentConfig)
          .where(eq(internalAgentConfig.companyId, agent.companyId))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        issueContext?.sourceDiscussionId
          ? db
            .select({ autonomyLevel: discussions.autonomyLevel })
            .from(discussions)
            .where(and(
              eq(discussions.id, issueContext.sourceDiscussionId),
              eq(discussions.companyId, agent.companyId),
            ))
            .limit(1)
            .then((rows) => rows[0] ?? null)
          : Promise.resolve(null),
      ]);
      const effectiveAutonomy = resolveHeartbeatEffectiveAutonomy({
        companyAutonomyLevel: companyAutonomyRow?.autonomyLevel,
        discussionAutonomyLevel: discussionAutonomyRow?.autonomyLevel,
      });
      // U11: sourced ONCE here (S5 — `orgAcquired.sandbox?.environment.driver
      // === "sandbox"`, never a top-level `orgAcquired.driver`) and reused for
      // both the MCP-bridge `brokered` flag below AND the connector delivery
      // `sandboxTarget` — the SAME "does this run execute inside an E2B VM"
      // question, so one boolean answers both.
      const runTargetsSandbox = orgAcquired.sandbox?.environment.driver === "sandbox";
      const heartbeatMcpParams = {
        companyId: agent.companyId,
        userId: agent.id,
        userRole: "team_member",
        enabledCapabilities: [...ORG_HEARTBEAT_ENABLED_CAPABILITIES],
        bridgeEntrypoint: resolveBridgeEntrypoint(),
        agentKind: agent.kind,
        toolAllowlist: [...ORG_HEARTBEAT_TOOL_ALLOWLIST],
        actorType: "agent",
        agentId: agent.id,
        runId: run.id,
        humanQuestionCapabilities: adapter.humanQuestionCapabilities,
        effectiveAutonomy,
        // U4b (S7 blocker): a resolved provider-sandbox lease (orgAcquired,
        // now acquired UNCONDITIONALLY for every org run — R3, no longer
        // gated on a pinned environment) means this heartbeat run's CLI
        // executes inside an E2B VM — the `aoa` MCP server MUST ride the
        // brokered HTTP transport there, never the stdio bridge (whose env
        // carries DATABASE_URL). `orgAcquired.sandbox` is null on
        // desktop/local_trusted regardless of whether an env is pinned
        // (acquireExecutionContext's S1 contract: environment_not_found ->
        // `{sandbox:null}`), so `brokered` is false there and
        // prepareHeartbeatMcpDelivery's stdio delivery stays byte-identical.
        // On cloud_auth it now fires for BOTH a pinned env and an unpinned
        // run resolving the platform default (R3).
        brokered: runTargetsSandbox,
        // The control plane's own address is the platform's, not the
        // tenant's — read it off the resolved adapter env first (mirrors the
        // runtime-hook-bridge base-URL resolution just below), falling back to
        // the server process env. Only consulted when brokered is true.
        apiBaseUrl: adapterEnv.AOA_API_URL ?? process.env.AOA_API_URL ?? undefined,
      } as const;

      // MCP connectors: resolve the company's enabled connectors for THIS
      // agent, build adapter specs + the env map carrying the real secrets, and
      // thread both into the delivery. Secrets never enter the config FILE —
      // only `${AOA_MCP_*_TOKEN}` placeholders — and land in the spawn env via
      // the delivered config.env.
      //
      // Scoped to CONNECTOR-CAPABLE adapters (Plan 2b Task 3, widened from
      // claude_local-only): the four CLI adapters can host external MCP
      // servers, so all four get the delivery — claude via its `--mcp-config`
      // file, the rest via `ctx.mcpServers` + `config.env`. `process`/`http`/
      // `cursor`/`hermes_local` have no MCP client at all, so resolving for
      // them would be wasted DB I/O and a needless per-run failure surface.
      // The predicate lives in the pure `mcp-connectors.ts` and is shared with
      // the crew runner — do not inline the list here.
      let extraMcpServers: Record<string, McpServerSpec> | undefined;
      let connectorEnv: Record<string, string> | undefined;
      if (adapterSupportsConnectors(agent.adapterType)) {
        const resolved = await resolveAgentConnectors(db, {
          companyId: agent.companyId,
          agentId: agent.id,
          runId: run.id,
          logger,
          // U11: a stdio connector is admissible in-VM but still dropped on an
          // unsandboxed host — sourced from the same S5 acquisition signal as
          // `brokered` above.
          sandboxTarget: runTargetsSandbox,
        });
        extraMcpServers = resolved.extraMcpServers;
        connectorEnv = resolved.connectorEnv;
      }

      const heartbeatMcpDelivery = await prepareHeartbeatMcpDelivery({
        adapterType: agent.adapterType,
        agentId: agent.id,
        runId: run.id,
        config: runScopedConfig,
        params: heartbeatMcpParams,
        extraMcpServers,
        connectorEnv,
      });
      runScopedConfig = heartbeatMcpDelivery.config;

      // ── onSpawn: persist PID/PGID/startedAt immediately after fork ──────
      const onSpawn = (pid: number | null, pgid: number | null, startedAt: Date) => {
        // pgid is now reliably populated on POSIX (= child.pid for detached:true spawns).
        // Persisting it lets an out-of-process watchdog kill the group if needed.
        void db
          .update(heartbeatRuns)
          .set({ processPid: pid, processGroupId: pgid, processStartedAt: startedAt })
          .where(eq(heartbeatRuns.id, run.id))
          .catch((err: unknown) =>
            logger.warn({ err, runId: run.id }, "Failed to persist process metadata"),
          );
      };

      // ── Debounced lastOutputAt: update at most once per second ───────────
      let outputSeq = 0;
      let lastOutputDbMs = 0;
      let appPreviewOutputBuffer = "";
      const previewExcludedOrigins = [
        process.env.AOA_API_URL ?? "",
        `http://localhost:${process.env.PORT ?? "3100"}`,
        `http://127.0.0.1:${process.env.PORT ?? "3100"}`,
      ];
      const pendingPreviewUrls = new Set<string>();
      const persistedPreviewUrls = new Set<string>();
      const adapterManagedRuntimeServicesById = new Map<
        string,
        Awaited<ReturnType<typeof persistAdapterManagedRuntimeServices>>[number]
      >();
      const persistDetectedPreviewServices = async (text: string, source: "stream" | "final") => {
        if (!isolatedWorkspacesEnabled || !realizedWorkspace) return [];
        if (!shouldDetectAoaAppPreviews(parseObject(agent.runtimeConfig))) return [];

        const previewCandidateUrls = extractLoopbackPreviewUrls(text, {
          excludedOrigins: previewExcludedOrigins,
        }).filter((url) => !persistedPreviewUrls.has(url) && !pendingPreviewUrls.has(url));
        if (previewCandidateUrls.length === 0) return [];

        for (const url of previewCandidateUrls) pendingPreviewUrls.add(url);
        try {
          const detectedRuntimeServices = await detectPreviewRuntimeServiceReports({
            text: previewCandidateUrls.map((url) => `AOA_PREVIEW_URL=${url}`).join("\n"),
            cwd: realizedWorkspace.cwd,
            excludedOrigins: previewExcludedOrigins,
          });

          await onLog(
            "system",
            `[aoa] App preview detection (${source}) found ${previewCandidateUrls.length} candidate URL(s), ${detectedRuntimeServices.length} reachable service(s)\n`,
          );

          if (detectedRuntimeServices.length === 0) return [];

          const adapterManagedRuntimeServices = await persistAdapterManagedRuntimeServices({
            db,
            adapterType: agent.adapterType,
            runId: run.id,
            agent: {
              id: agent.id,
              name: agent.name,
              companyId: agent.companyId,
            },
            issue: issueRef,
            workspace: realizedWorkspace,
            executionWorkspaceId: resolveAdapterManagedRuntimeExecutionWorkspaceId({
              persistedExecutionWorkspace,
              issue: issueRef,
            }),
            reports: detectedRuntimeServices,
          });

          for (const service of adapterManagedRuntimeServices) {
            if (service.url) persistedPreviewUrls.add(service.url);
            adapterManagedRuntimeServicesById.set(service.id, service);
          }

          if (adapterManagedRuntimeServices.length > 0) {
            const combinedRuntimeServices = [
              ...runtimeServices,
              ...Array.from(adapterManagedRuntimeServicesById.values()),
            ];
            context.aoaRuntimeServices = combinedRuntimeServices;
            context.aoaRuntimePrimaryUrl =
              combinedRuntimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
            await db
              .update(heartbeatRuns)
              .set({
                contextSnapshot: context,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, run.id));
          }

          return adapterManagedRuntimeServices;
        } finally {
          for (const url of previewCandidateUrls) pendingPreviewUrls.delete(url);
        }
      };
      const livePreviewDetection = createLivePreviewDetectionScheduler({
        onDetect: persistDetectedPreviewServices,
        onError: (err) => {
          logger.warn({ err, runId: run.id }, "[heartbeat] live app preview persistence failed");
        },
      });
      const originalOnLog = onLog;
      const onLogWithOutput = async (stream: "stdout" | "stderr", chunk: string) => {
        outputSeq += 1;
        appPreviewOutputBuffer = (appPreviewOutputBuffer + chunk).slice(-64_000);
        livePreviewDetection.observeChunk(chunk);
        const now = Date.now();
        if (now - lastOutputDbMs > 1000) {
          lastOutputDbMs = now;
          void db
            .update(heartbeatRuns)
            .set({
              lastOutputAt: new Date(now),
              lastOutputSeq: outputSeq,
              lastOutputStream: stream,
              lastOutputBytes: Buffer.byteLength(chunk),
            })
            .where(eq(heartbeatRuns.id, run.id))
            .catch((err: unknown) =>
              logger.warn({ err, runId: run.id }, "Failed to update lastOutputAt"),
            );
        }
        await originalOnLog(stream, chunk);
      };

      const { executionTarget, runtimeCommandSpec } = resolveGuardedAdapterExecutionContext(
        runScopedConfig,
        adapter,
        // Sink-level multi_tenant hardening (trustBoundary) + D1 unsandboxed gate
        // (cloud_auth): neutralize a tenant-authored adapterConfig.executionTarget on
        // shared infra, and REFUSE an unsandboxed local dispatch on cloud_auth unless
        // the operator opted in (AOA_ALLOW_UNSANDBOXED_MULTITENANT). hbTopology is
        // resolved above (:3081); tenantIsolationEnforced() is the cloud_auth signal.
        {
          trustBoundary: hbTopology.trustBoundary,
          tenantIsolationEnforced: tenantIsolationEnforced(),
          sink: "org agent",
        },
      );

      // Audit follow-up #27: persist the redacted+capped assembled prompt on
      // the heartbeat_runs row so the audit card can show "exactly what the
      // agent read." The full prompt is in runScopedConfig.promptTemplate
      // (assembled by the adapter's renderTemplate call). Best-effort — a
      // failure here must NEVER break the run.
      try {
        const rawPrompt = typeof runScopedConfig.promptTemplate === "string"
          ? runScopedConfig.promptTemplate
          : null;
        if (rawPrompt) {
          const snapshot = redactAndCapPrompt(rawPrompt);
          void db
            .update(heartbeatRuns)
            .set({ promptSnapshot: snapshot })
            .where(eq(heartbeatRuns.id, run.id))
            .catch((snapErr: unknown) =>
              logger.warn({ err: snapErr, runId: run.id }, "[heartbeat] failed to persist prompt snapshot (best-effort, ignored)"),
            );
        }
      } catch (snapErr) {
        logger.warn({ err: snapErr, runId: run.id }, "[heartbeat] prompt snapshot preparation failed (best-effort, ignored)");
      }

      const runtimeDecisionBroker = createHeartbeatRuntimeDecisionBroker({
        run,
        agent,
        runtime: runtimeForAdapter,
        runtimeDecisions: agentRuntimeDecisionService(db),
        appendRunEvent: async (event) => {
          await appendRunEvent(currentRun, seq++, event);
        },
        markRunWaiting: async (decision) => {
          await setRunStatus(run.id, "running", {
            livenessState: "waiting_on_human",
            livenessReason: "runtime_decision",
            nextAction: `runtime_decision:${decision.id}`,
          });
        },
        clearRunWaiting: async () => {
          await setRunStatus(run.id, "running", {
            livenessState: null,
            livenessReason: null,
            nextAction: null,
          });
        },
        recordWait: async (kind, durationMs) => {
          const boundedDurationMs = Math.max(0, Math.trunc(durationMs));
          if (boundedDurationMs === 0) return;
          await db.update(heartbeatRuns).set(kind === "permission"
            ? {
                runtimePermissionWaitMs: sql`${heartbeatRuns.runtimePermissionWaitMs} + ${boundedDurationMs}`,
                updatedAt: new Date(),
              }
            : {
                humanQuestionWaitMs: sql`${heartbeatRuns.humanQuestionWaitMs} + ${boundedDurationMs}`,
                updatedAt: new Date(),
              })
            .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running")));
        },
      });

      // ── W5b: per-agent runtime-decision routing bridge ───────────────────
      const bridged = resolveRuntimeDecisionRoutingEnabled({
        agentRuntimeConfig: agent.runtimeConfig,
        instanceEnv: process.env,
        adapterType: agent.adapterType ?? "",
        executionTargetType: executionTarget.type,
      });

      // W5c: only claude_local uses the out-of-process PreToolUse HTTP hook
      // (token + registry + runtimeHookBridge). codex_local drives its approvals
      // IN-PROCESS via the app-server JSON-RPC callback and needs NO token,
      // registry entry, or HTTP bridge — it reads the broker off ctx directly.
      // The `bridged` value already covers BOTH adapters (Task 6 allow-list); we
      // only gate the *hook-token machinery* to claude_local here.
      const usesHttpHookBridge = bridged && agent.adapterType === "claude_local";

      let runtimeHookToken: string | undefined;
      if (usesHttpHookBridge) {
        const selfBaseUrl = resolveRuntimeHookBaseUrl({
          apiUrl: process.env.AOA_API_URL?.trim() ?? "",
          port: process.env.PORT ?? "3100",
          brokered: executionTarget.type !== "local",
        });
        runtimeHookToken = mintRuntimeHookToken();
        // TTL is a leaked-entry backstop only — the primary cleanup is `deregisterRuntimeHook`
        // in the finally block below. The TTL must cover the entire possible run duration so
        // multi-tool or long-running agents are never denied mid-run because the registry
        // entry expired. Since we don't have the exact adapter timeout in scope here, we use
        // a generous 24-hour safety-net constant; the finally block handles normal cleanup.
        const RUNTIME_HOOK_REGISTRY_MAX_TTL_SEC = 24 * 60 * 60; // 24 h backstop
        registerRuntimeHook(runtimeHookToken, {
          broker: runtimeDecisionBroker,
          companyId: run.companyId,
          agentId: agent.id,
          runId: run.id,
          expiresAt: new Date(Date.now() + RUNTIME_HOOK_REGISTRY_MAX_TTL_SEC * 1000),
        });
      }

      let adapterResult: Awaited<ReturnType<typeof adapter.execute>>;
      try {
        adapterResult = await adapter.execute({
          runId: run.id,
          agent,
          runtime: runtimeForAdapter,
          config: runScopedConfig,
          context,
          executionTarget,
          runtimeCommandSpec,
          mcpBridge: heartbeatMcpDelivery.mcpBridge,
          // Plan 2b Task 3: the external connector specs, on the carrier the
          // per-adapter writers (Tasks 4-6) read. Inert for claude_local, which
          // already receives them through its generated `--mcp-config` file.
          // The matching `AOA_MCP_*_TOKEN` secrets travel separately in
          // `runScopedConfig.env` (adapters copy config.env into the spawn env).
          mcpServers: heartbeatMcpDelivery.extraMcpServers,
          onLog: onLogWithOutput,
          onMeta: onAdapterMeta,
          authToken: authToken ?? undefined,
          runtimeDecisionBroker,
          humanQuestionCapabilities: adapter.humanQuestionCapabilities,
          // Non-secret plain boolean — safe in logged meta. codex_local reads
          // this to route its in-process app-server approval bridge; claude_local
          // additionally receives the HTTP hook machinery below.
          runtimeDecisionRoutingEnabled: bridged,
          ...(usesHttpHookBridge && runtimeHookToken != null
            ? {
                runtimeHookBridge: {
                  enabled: true,
                  selfBaseUrl: resolveRuntimeHookBaseUrl({
                    apiUrl: process.env.AOA_API_URL?.trim() ?? "",
                    port: process.env.PORT ?? "3100",
                    brokered: executionTarget.type !== "local",
                  }),
                  path: RUNTIME_HOOK_PATH,
                  timeoutSec: RUNTIME_HOOK_BLOCK_TIMEOUT_SEC,
                },
                runtimeHookToken,
              }
            : {}),
          onSpawn,
        });
      } finally {
        if (usesHttpHookBridge && runtimeHookToken != null) {
          deregisterRuntimeHook(runtimeHookToken);
        }
        await heartbeatMcpDelivery.cleanup();
      }

      await livePreviewDetection.flush();

      // ── Persist adapter-managed runtime services (gated) ───────────
      const previewDetectionText = buildPreviewDetectionText({
        streamedText: appPreviewOutputBuffer,
        adapterResult,
      });
      await persistDetectedPreviewServices(previewDetectionText, "final");

      // ── U6.6: sandbox preview URL (provider-sandbox getHost(port)) ──
      // persistDetectedPreviewServices (above) verifies a candidate preview
      // URL by `fetch`-probing it from THIS process (probePreviewUrl) before
      // ever persisting it — the host-loopback path. For a sandboxed run
      // that probe can never succeed: the VM's "localhost" (what the agent's
      // own AOA_PREVIEW_URL=... report necessarily says, from inside the
      // VM) is not reachable from the control plane, so
      // persistDetectedPreviewServices silently no-ops for cloud runs today.
      // Reuse the SAME text-based port discovery (extractLoopbackPreviewUrls
      // over the agent's own report, already scanned above into
      // previewDetectionText) but skip the host probe entirely and resolve
      // the preview URL via the sandbox's own getHost(port) mapping instead
      // (resolveSandboxPreviewUrl, sandbox-file-movement.ts, U6.6). Gated
      // identically to the U6.3 in-VM diff / U6.5 crew capture sandbox
      // dual-check (orgAcquired.sandbox?.environment.driver === "sandbox" +
      // executionTarget.type === "provider-sandbox", S5) plus issueId !=
      // null. orgAcquired.sandbox is null on desktop/local_trusted (the
      // documented S1 contract on acquire-execution-context.ts), so this
      // block is a pure no-op there — the existing host-loopback preview
      // path above is completely unchanged. Best-effort throughout:
      // emitSandboxPreviewTaskOutput never throws, and this block is
      // additionally try/catched so a resolveHost failure can never fail
      // the run.
      if (issueId) {
        const previewSandboxExecutionTarget = orgAcquired.sandbox?.configPatch.executionTarget;
        if (
          orgAcquired.sandbox?.environment.driver === "sandbox" &&
          previewSandboxExecutionTarget?.type === "provider-sandbox"
        ) {
          try {
            const candidatePorts = Array.from(
              new Set(
                extractLoopbackPreviewUrls(previewDetectionText, {
                  excludedOrigins: previewExcludedOrigins,
                })
                  .map((url) => {
                    try {
                      return new URL(url).port;
                    } catch {
                      return "";
                    }
                  })
                  .filter((port) => port.length > 0)
                  .map((port) => Number(port)),
              ),
            );
            for (const port of candidatePorts) {
              await emitSandboxPreviewTaskOutput(db, {
                companyId: agent.companyId,
                issueId,
                executionWorkspaceId:
                  persistedExecutionWorkspace?.id ?? issueRef?.executionWorkspaceId ?? null,
                // Cast rationale identical to U6.3's collectSandboxDiff call
                // (output-detection block, below): AdapterExecutionTarget's
                // "provider-sandbox" variant types `runner` as the
                // execute-only AdapterProviderSandboxRunner, but the object
                // actually built here is environment-run-orchestrator.ts's
                // buildProviderRunner output — a strict superset (writeFiles/
                // readFiles/resolveHost included whenever the underlying
                // provider implements them, true for every non-docker
                // provider sandbox, the only case this type-narrowed branch
                // is reached). Runtime-safe.
                runner: previewSandboxExecutionTarget.runner as unknown as SandboxFileMovementRunner,
                port,
                createdByRunId: run.id,
                createdByAgentId: agent.id,
              });
            }
          } catch (previewErr) {
            logger.warn(
              { err: previewErr, runId: run.id, issueId },
              "U6.6: sandbox preview URL emission failed (non-fatal)",
            );
          }
        }
      }

      const runtimeServiceReports = mergeAdapterRuntimeServiceReports({
        adapterReports: adapterResult.runtimeServices ?? [],
        detectedReports: [],
      });

      if (isolatedWorkspacesEnabled && realizedWorkspace && runtimeServiceReports.length > 0) {
        const adapterManagedRuntimeServices = await persistAdapterManagedRuntimeServices({
          db,
          adapterType: agent.adapterType,
          runId: run.id,
          agent: {
            id: agent.id,
            name: agent.name,
            companyId: agent.companyId,
          },
          issue: issueRef,
          workspace: realizedWorkspace,
          executionWorkspaceId: resolveAdapterManagedRuntimeExecutionWorkspaceId({
            persistedExecutionWorkspace,
            issue: issueRef,
          }),
          reports: runtimeServiceReports,
        });
        if (adapterManagedRuntimeServices.length > 0) {
          const combinedRuntimeServices = [
            ...runtimeServices,
            ...adapterManagedRuntimeServices,
          ];
          context.aoaRuntimeServices = combinedRuntimeServices;
          context.aoaRuntimePrimaryUrl =
            combinedRuntimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
          await db
            .update(heartbeatRuns)
            .set({
              contextSnapshot: context,
              updatedAt: new Date(),
            })
            .where(eq(heartbeatRuns.id, run.id));
          if (issueId) {
            try {
              await db.insert(issueComments).values({
                companyId: agent.companyId,
                issueId,
                authorAgentId: agent.id,
                authorUserId: null,
                body: buildWorkspaceReadyComment({
                  workspace: realizedWorkspace,
                  runtimeServices: adapterManagedRuntimeServices,
                }),
              });
            } catch (err) {
              await onLog(
                "stderr",
                `[aoa] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          }
        }
      }

      const nextSessionState = resolveNextSessionState({
        codec: sessionCodec,
        adapterResult,
        previousParams: previousSessionParams,
        previousDisplayId: runtimeForAdapter.sessionDisplayId,
        previousLegacySessionId: runtimeForAdapter.sessionId,
      });

      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const latestRun = await getRun(run.id);
      if (latestRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (adapterResult.timedOut) {
        outcome = "timed_out";
      } else if ((adapterResult.exitCode ?? 0) === 0 && !adapterResult.errorMessage) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        logSummary = await runLogStore.finalize(handle);
      }

      const status =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "timed_out"
              ? "timed_out"
              : "failed";

      const usageJson =
        adapterResult.usage || adapterResult.costUsd != null
          ? ({
              ...(adapterResult.usage ?? {}),
              ...(adapterResult.costUsd != null ? { costUsd: adapterResult.costUsd } : {}),
              ...(adapterResult.billingType ? { billingType: adapterResult.billingType } : {}),
            } as Record<string, unknown>)
          : null;

      const finalErrorCode =
        outcome === "timed_out"
          ? "timeout"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "failed"
              ? (adapterResult.errorCode ?? "adapter_failed")
              : null;
      const finalErrorMessage =
        outcome === "succeeded"
          ? null
          : sanitizeForDb(adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"));
      const resultJsonWithStopMetadata = mergeHeartbeatRunStopMetadata(
        adapterResult.resultJson ? parseObject(adapterResult.resultJson) : null,
        buildHeartbeatRunStopMetadata({
          adapterType: agent.adapterType,
          adapterConfig: runScopedConfig,
          outcome,
          errorCode: finalErrorCode,
          errorMessage: finalErrorMessage,
        }),
      );

      const waitingQuestion = await db
        .select({ id: workQuestions.id })
        .from(workQuestions)
        .where(and(
          eq(workQuestions.companyId, run.companyId),
          eq(workQuestions.originatingRunKind, "heartbeat"),
          eq(workQuestions.originatingRunId, run.id),
          eq(workQuestions.status, "open"),
          eq(workQuestions.blocking, true),
        ))
        .orderBy(desc(workQuestions.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const liveness = classifyCompletedRunLiveness({
        outcome,
        waitingQuestionId: waitingQuestion?.id,
      });
      const finishedAt = new Date();
      const runAccounting = await resolveTerminalRunAccounting(run, finishedAt);
      const completedRun = await setRunStatus(run.id, status, {
        finishedAt,
        ...runAccounting,
        livenessState: liveness.livenessState,
        livenessReason: liveness.livenessReason,
        error: finalErrorMessage,
        errorCode: finalErrorCode,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        usageJson,
        resultJson: resultJsonWithStopMetadata,
        sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        stdoutExcerpt: sanitizeForDb(stdoutExcerpt),
        stderrExcerpt: sanitizeForDb(stderrExcerpt),
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      if (!completedRun) {
        logger.info(
          { runId: run.id, status },
          "heartbeat completion lost terminal-status race; skipping completion side effects",
        );
        return;
      }

      await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
        finishedAt,
        error: adapterResult.errorMessage ?? null,
      });
      await cancelRuntimeDecisionPromptsForRun(run, `run ${status}`);

      const finalizedRun = await getRun(run.id);
      if (finalizedRun) {
        await appendRunEvent(finalizedRun, seq++, {
          eventType: "lifecycle",
          stream: "system",
          level: outcome === "succeeded" ? "info" : "error",
          message: `run ${outcome}`,
          payload: {
            status,
            exitCode: adapterResult.exitCode,
          },
        });
        if (normalizeMaxTurnStopReason(finalizedRun.errorCode) || normalizeMaxTurnStopReason(parseObject(finalizedRun.resultJson).stopReason)) {
          const scheduledRetry = await scheduleBoundedRetryForRun(finalizedRun).catch((err) => {
            logger.warn(
              { err, runId: finalizedRun.id, agentId: finalizedRun.agentId, companyId: finalizedRun.companyId },
              "failed to schedule max-turn continuation retry",
            );
            return null;
          });
          if (scheduledRetry) {
            await appendRunEvent(finalizedRun, seq++, {
              eventType: "recovery.retry_scheduled",
              stream: "system",
              level: "info",
              message: "scheduled max-turn continuation retry",
              payload: {
                retryRunId: scheduledRetry.id,
                attempt: scheduledRetry.scheduledRetryAttempt,
                scheduledRetryAt: scheduledRetry.scheduledRetryAt?.toISOString() ?? null,
              },
            });
          }
        }
        await recoveryService(db).handleCompletedRun(finalizedRun.id).catch((err) => {
          logger.warn({ err, runId: finalizedRun.id }, "recovery handleCompletedRun failed");
        });
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      if (finalizedRun) {
        await updateRuntimeState(agent, finalizedRun, adapterResult, {
          legacySessionId: nextSessionState.legacySessionId,
        });
        if (taskKey) {
          if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
            await clearTaskSessions(agent.companyId, agent.id, {
              taskKey,
              adapterType: agent.adapterType,
            });
          } else {
            await upsertTaskSession({
              companyId: agent.companyId,
              agentId: agent.id,
              adapterType: agent.adapterType,
              taskKey,
              sessionParamsJson: nextSessionState.params,
              sessionDisplayId: nextSessionState.displayId,
              lastRunId: finalizedRun.id,
              lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
            });
          }
        }
      }
      await finalizeAgentStatus(agent.id, outcome);

      // ── Agent output capture (Decision #67) ─────────────────────────
      // Runs AFTER the run is finalized — detection failures are non-fatal.
      let detectedFiles: Array<{ path: string; type?: string }> = [];
      const outputDetectionCwd = resolveOutputDetectionCwd({
        adapterExecutionCwd: adapterResult.executionCwd,
        effectiveCwd,
      });
      if (
        outputDetectionCwd &&
        effectiveCwd &&
        adapterResult.executionCwd &&
        path.resolve(outputDetectionCwd) !== path.resolve(effectiveCwd)
      ) {
        logger.info(
          {
            runId: run.id,
            agentId: agent.id,
            adapterType: agent.adapterType,
            outputDetectionCwd,
            effectiveCwd,
          },
          "using adapter execution cwd for output detection",
        );
      }
      if (outcome === "succeeded" && outputDetectionCwd) {
        try {
          // U6.3 (S5): when this run acquired a provider-sandbox lease,
          // source changed files from the in-VM `git diff` (collectSandboxDiff)
          // instead of the host git/mtime scan — outputDetectionCwd on a
          // sandboxed run is the VM's remoteCwd (e.g.
          // "/home/user/aoa-workspace"), which never exists on the host
          // running this service. `orgAcquired` was captured earlier in this
          // run (unmutated `const`, used above for mcpParams.brokered, U4b)
          // and is re-read here rather than off `runScopedConfig` (which gets
          // spread/reassigned repeatedly downstream), so this stays correct
          // regardless of later config mutations. Desktop/local runs (no
          // provider-sandbox lease) get `changedFileSource: undefined` and
          // this call is otherwise byte-identical to before.
          const sandboxExecutionTarget = orgAcquired.sandbox?.configPatch.executionTarget;
          const changedFileSource =
            orgAcquired.sandbox?.environment.driver === "sandbox" &&
            sandboxExecutionTarget?.type === "provider-sandbox"
              ? () =>
                  collectSandboxDiff({
                    // AdapterExecutionTarget's "provider-sandbox" variant types
                    // `runner` as the execute-only AdapterProviderSandboxRunner,
                    // but the object actually built here is
                    // environment-run-orchestrator.ts's buildProviderRunner
                    // output — a strict superset (writeFiles/readFiles/
                    // resolveHost included whenever the underlying runtime
                    // implements them, which it does for every non-docker
                    // provider sandbox — the only case this type-narrowed
                    // branch is reached). Cast is therefore runtime-safe.
                    runner: sandboxExecutionTarget.runner as unknown as SandboxFileMovementRunner,
                    remoteCwd: sandboxExecutionTarget.remoteCwd,
                  })
              : undefined;

          const detected = await outputDetector.detectAndCapture({
            runId: run.id,
            companyId: agent.companyId,
            agentId: agent.id,
            cwd: outputDetectionCwd,
            startedAt: run.startedAt ?? run.createdAt,
            adapterType: agent.adapterType,
            adapterHints: adapterResult.outputFiles,
            issueId: readNonEmptyString(context.issueId),
            changedFileSource,
          });
          if (detected.length > 0) {
            detectedFiles = detected.map((d) => ({
              path: d.path,
              type: d.artifactType ?? undefined,
            }));
            await db
              .update(heartbeatRuns)
              .set({
                detectedOutputs: detected as unknown as Array<Record<string, unknown>>,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, run.id));
            publishLiveEvent({
              companyId: agent.companyId,
              type: "heartbeat.run.outputs_detected",
              payload: { runId: run.id, agentId: agent.id, count: detected.length },
            });
          }
        } catch (detectErr) {
          logger.warn({ err: detectErr, runId: run.id }, "output detection failed (non-fatal)");
        }
      }

      // ── Run summary comments (Decision #88) ─────────────────────────
      if (finalizedRun) {
        await createRunSummaryComment({
          agent,
          run: finalizedRun,
          outcome,
          adapterResult,
          issueId: readNonEmptyString(context.issueId),
          detectedFiles,
        });
      }

      // ── P3-T2: Relay crew-task result to source thread (best-effort) ──
      // When a run finishes successfully for an issue, post a visible agent
      // entry to the originating thread so the result surfaces in chat.
      // The relay guards internally (no-ops for non-crew tasks), so we call
      // it unconditionally for any successful issue-linked run.
      // Mirrors the failure-card hook pattern: try/catch so a relay failure
      // logs but NEVER breaks or fails the run.
      if (outcome === "succeeded" && issueContext?.id) {
        try {
          await relayCrewResult(db, { issueId: issueContext.id });
        } catch (relayErr) {
          logger.warn(
            { err: relayErr, issueId: issueContext.id },
            "P3-T2: failed to relay crew-task result to thread (non-fatal)",
          );
        }
      }

      // ── Phase B.2: Refresh provider quota snapshots (fire-and-forget) ─
      // Adapters that expose getQuotaWindows() report fresh rate-limit
      // windows to the DB so the Costs UI reads recent snapshots without
      // blocking on live provider polls. Errors are swallowed — stale quota
      // data is strictly better than a failed heartbeat completion.
      quotaWindowsService(db)
        .refresh(agent.companyId, agent.adapterType)
        .catch((err) => logger.warn({ err, adapterType: agent.adapterType }, "quota refresh after heartbeat failed"));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown adapter failure";
      const runtimeDecisionCancelled = err instanceof RuntimeDecisionCancelledError;
      const terminalStatus: "failed" | "cancelled" = runtimeDecisionCancelled ? "cancelled" : "failed";
      if (runtimeDecisionCancelled) {
        logger.info({ err, runId }, "heartbeat execution cancelled");
      } else {
        logger.error({ err, runId }, "heartbeat execution failed");
      }

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        try {
          logSummary = await runLogStore.finalize(handle);
        } catch (finalizeErr) {
          logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
        }
      }

      const finishedAt = new Date();
      const runAccounting = await resolveTerminalRunAccounting(run, finishedAt);
      const failedRun = await setRunStatus(run.id, terminalStatus, {
        error: message,
        errorCode: runtimeDecisionCancelled ? "cancelled" : "adapter_failed",
        finishedAt,
        ...runAccounting,
        stdoutExcerpt: sanitizeForDb(stdoutExcerpt),
        stderrExcerpt: sanitizeForDb(stderrExcerpt),
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      if (!failedRun) {
        logger.info(
          { runId: run.id, terminalStatus },
          "heartbeat failure lost terminal-status race; skipping failure side effects",
        );
        return;
      }
      await setWakeupStatus(run.wakeupRequestId, terminalStatus, {
        finishedAt,
        error: message,
      });
      await cancelRuntimeDecisionPromptsForRun(failedRun, `run ${terminalStatus}`);

      await appendRunEvent(failedRun, seq++, {
        eventType: "error",
        stream: "system",
        level: "error",
        message,
      });
      await releaseIssueExecutionAndPromote(failedRun);

      await updateRuntimeState(agent, failedRun, {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: message,
      }, {
        legacySessionId: runtimeForAdapter.sessionId,
      });

      if (taskKey && (previousSessionParams || previousSessionDisplayId || taskSession)) {
        await upsertTaskSession({
          companyId: agent.companyId,
          agentId: agent.id,
          adapterType: agent.adapterType,
          taskKey,
          sessionParamsJson: previousSessionParams,
          sessionDisplayId: previousSessionDisplayId,
          lastRunId: failedRun.id,
          lastError: message,
        });
      }

      await finalizeAgentStatus(agent.id, terminalStatus);

      // ── Run summary comments for crash path (Decision #88) ──────────
      await createRunSummaryComment({
        agent,
        run: failedRun,
        outcome: terminalStatus,
        adapterResult: {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: message,
        },
        issueId: readNonEmptyString(context.issueId),
        detectedFiles: [],
      });

      // P2-T2: surface thread-linked deliverable failures as a visible chat
      // card (not a silent `failed`). Best-effort — must never mask the
      // original failure or throw out of the catch.
      if (!runtimeDecisionCancelled && presenceThreadId && issueContext?.id) {
        try {
          await postCrewFailureCard(db, {
            threadId: presenceThreadId,
            companyId: agent.companyId,
            issueId: issueContext.id,
            agentId: agent.id,
            agentName: agent.name,
            taskTitle: issueContext.title ?? "(untitled task)",
            error: message,
          });
        } catch (cardErr) {
          logger.warn(
            { err: cardErr, threadId: presenceThreadId, issueId: issueContext.id },
            "P2-T2: failed to post crew-failure card",
          );
        }
      }
    } finally {
      // P2-T1: clear this agent's working presence for the thread (run ended,
      // success or failure). Best-effort.
      if (presenceThreadId) {
        try {
          threadWorkingAgents.remove(presenceThreadId, agent.id);
          broadcastThreadPresence(agent.companyId, presenceThreadId, Date.now());
        } catch (presenceErr) {
          logger.warn({ err: presenceErr, threadId: presenceThreadId, agentId: agent.id }, "P2-T1: failed to clear working presence");
        }
      }
      // Release thread workspace run lock (P1-T8 slice 4).
      // This runs unconditionally — even on throw — so the workspace is never
      // left permanently locked by a crashed or deferred run.
      if (threadWorkspaceLock) {
        await executionWorkspacesSvc
          .releaseWorkspaceRun(threadWorkspaceLock.workspaceId, threadWorkspaceLock.runId)
          .catch((lockReleaseErr: unknown) => {
            logger.warn(
              { workspaceId: threadWorkspaceLock?.workspaceId, runId: threadWorkspaceLock?.runId, err: lockReleaseErr },
              "heartbeat: failed to release thread workspace run lock in finally",
            );
          });
      }
      if (isolatedWorkspacesEnabled) {
        await releaseRuntimeServicesForRun(run.id).catch(() => undefined);
      }
      await environmentRuntimeService(db)
        .releaseRunLeases(run.id)
        .catch((leaseReleaseErr: unknown) => {
          logger.warn({ err: leaseReleaseErr, runId: run.id }, "heartbeat: failed to release environment leases in finally");
        });
      await dispatchQueuedRunsAfterAgentSignal(agent.id);
    }
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect) {
    const promotedRun = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);

      if (!issue) return;

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      while (true) {
        const deferred = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, issue.companyId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!deferred) return null;

        const deferredAgent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, deferred.agentId))
          .then((rows) => rows[0] ?? null);

        if (
          !deferredAgent ||
          deferredAgent.companyId !== issue.companyId ||
          deferredAgent.status === "paused" ||
          deferredAgent.status === "terminated" ||
          deferredAgent.status === "pending_approval"
        ) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: "Deferred wake could not be promoted: agent is not invokable",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, deferred.id));
          continue;
        }

        const deferredPayload = parseObject(deferred.payload);
        const deferredContextSeed = parseObject(
          deferredPayload[DEFERRED_WAKE_CONTEXT_KEY],
        );
        const promotedContextSeed: Record<string, unknown> = { ...deferredContextSeed };
        const promotedReason = readNonEmptyString(deferred.reason) ?? "issue_execution_promoted";
        const promotedSource =
          (readNonEmptyString(deferred.source) as WakeupOptions["source"]) ?? "automation";
        const promotedTriggerDetail =
          (readNonEmptyString(deferred.triggerDetail) as WakeupOptions["triggerDetail"]) ?? null;
        const promotedPayload = deferredPayload;
        delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

        const {
          contextSnapshot: promotedContextSnapshot,
          taskKey: promotedTaskKey,
        } = enrichWakeContextSnapshot({
          contextSnapshot: promotedContextSeed,
          reason: promotedReason,
          source: promotedSource,
          triggerDetail: promotedTriggerDetail,
          payload: promotedPayload,
        });

        const sessionBefore = await resolveSessionBeforeForWakeup(deferredAgent, promotedTaskKey);
        const now = new Date();
        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: deferredAgent.companyId,
            agentId: deferredAgent.id,
            invocationSource: promotedSource,
            triggerDetail: promotedTriggerDetail,
            status: "queued",
            wakeupRequestId: deferred.id,
            contextSnapshot: promotedContextSnapshot,
            sessionIdBefore: sessionBefore,
            humanQuestionWaitMs: readNonNegativeInteger(promotedContextSnapshot.humanQuestionWaitMs),
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            reason: "issue_execution_promoted",
            runId: newRun.id,
            claimedAt: null,
            finishedAt: null,
            error: null,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, deferred.id));

        if (deferred.reason === "work_question_continuation" && deferred.idempotencyKey) {
          await bindHeartbeatWorkQuestionContinuation(tx as unknown as Db, {
            companyId: issue.companyId,
            runId: newRun.id,
            idempotencyKey: deferred.idempotencyKey,
          });
        }

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: normalizeAgentNameKey(deferredAgent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));

        return newRun;
      }
    });

    if (!promotedRun) return;

    publishLiveEvent({
      companyId: promotedRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: promotedRun.id,
        agentId: promotedRun.agentId,
        invocationSource: promotedRun.invocationSource,
        triggerDetail: promotedRun.triggerDetail,
        wakeupRequestId: promotedRun.wakeupRequestId,
      },
    });

    await dispatchQueuedRunsAfterAgentSignal(promotedRun.agentId);
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = { ...(opts.contextSnapshot ?? {}) };
    const reason = opts.reason ?? null;
    const payload = opts.payload ?? null;
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    const inheritedHumanQuestionWaitMs = readNonNegativeInteger(
      enrichedContextSnapshot.humanQuestionWaitMs,
    );
    const issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");

    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    const policy = parseHeartbeatPolicy(agent);
    const writeSkippedRequest = async (reason: string) => {
      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
      });
    };

    // Runtime-boundary guard (B2, Decision #100): kind='aoa'/'platform'
    // agents run ONLY via the AoA dispatcher, never the heartbeat runtime.
    // Refuse to enqueue a heartbeat run for them at this single chokepoint so
    // no call site (e.g. the issue-CREATE assignment path in routes/issues.ts)
    // can drive an AoA agent through both runtimes = dual execution.
    // Legitimate AoA triggering uses enqueueAoaMentionWakeup /
    // delegate_to_subagent, which bypass enqueueWakeup entirely.
    if (agent.kind === "aoa" || agent.kind === "platform") {
      await writeSkippedRequest("heartbeat.skipped.aoa_kind");
      return null;
    }

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);
      const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
        );

        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_issue_not_found",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            finishedAt: new Date(),
          });
          return { kind: "skipped" as const };
        }

        if (reason === "work_question_continuation") {
          const invalidation = classifyScheduledRetryGate({ issue, agentId });
          if (invalidation) {
            await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason,
              payload,
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              error: invalidation,
              finishedAt: new Date(),
            });
            return { kind: "skipped" as const };
          }
        }

        let activeExecutionRun = issue.executionRunId
          ? await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, issue.executionRunId))
            .then((rows) => rows[0] ?? null)
          : null;

        if (
          activeExecutionRun &&
          activeExecutionRun.status !== "queued" &&
          activeExecutionRun.status !== "running" &&
          activeExecutionRun.status !== "scheduled_retry"
        ) {
          activeExecutionRun = null;
        }

        if (!activeExecutionRun && issue.executionRunId) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }

        if (!activeExecutionRun) {
          const legacyRun = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, issue.companyId),
                inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(
              sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
              asc(heartbeatRuns.createdAt),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (legacyRun) {
            activeExecutionRun = legacyRun;
            const legacyAgent = await tx
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, legacyRun.agentId))
              .then((rows) => rows[0] ?? null);
            await tx
              .update(issues)
              .set({
                executionRunId: legacyRun.id,
                executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
                executionLockedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }
        }

        if (activeExecutionRun) {
          const staleReason = classifyScheduledRetryGate({
            issue,
            agentId: activeExecutionRun.agentId,
          });
          if (staleReason && isCancellableIssueExecutionStatus(activeExecutionRun.status)) {
            const now = new Date();
            await tx
              .update(heartbeatRuns)
              .set({
                status: "cancelled",
                finishedAt: now,
                errorCode: staleReason,
                error: "Queued issue execution cancelled because the issue is no longer eligible",
                updatedAt: now,
              })
              .where(eq(heartbeatRuns.id, activeExecutionRun.id));
            if (activeExecutionRun.wakeupRequestId) {
              await tx
                .update(agentWakeupRequests)
                .set({
                  status: "cancelled",
                  finishedAt: now,
                  error: "Queued issue execution cancelled because the issue is no longer eligible",
                  updatedAt: now,
                })
                .where(eq(agentWakeupRequests.id, activeExecutionRun.wakeupRequestId));
            }
            if (issue.executionRunId === activeExecutionRun.id) {
              await tx
                .update(issues)
                .set({
                  executionRunId: null,
                  executionAgentNameKey: null,
                  executionLockedAt: null,
                  updatedAt: now,
                })
                .where(eq(issues.id, issue.id));
            }
            activeExecutionRun = null;
          }
        }

        if (activeExecutionRun) {
          const executionAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, activeExecutionRun.agentId))
            .then((rows) => rows[0] ?? null);
          const executionAgentNameKey =
            normalizeAgentNameKey(issue.executionAgentNameKey) ??
            normalizeAgentNameKey(executionAgent?.name);
          const isSameExecutionAgent =
            Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
          const shouldQueueFollowup =
            (Boolean(wakeCommentId) || reason === "work_question_continuation") &&
            activeExecutionRun.status === "running" &&
            isSameExecutionAgent;

          if (isSameExecutionAgent && !shouldQueueFollowup) {
            const mergedContextSnapshot = mergeCoalescedContextSnapshot(
              activeExecutionRun.contextSnapshot,
              enrichedContextSnapshot,
            );
            const mergedRun = await tx
              .update(heartbeatRuns)
              .set({
                contextSnapshot: mergedContextSnapshot,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, activeExecutionRun.id))
              .returning()
              .then((rows) => rows[0] ?? activeExecutionRun);

            const coalescedWakeup = await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_same_name",
              payload,
              status: "coalesced",
              coalescedCount: 1,
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              runId: mergedRun.id,
              finishedAt: new Date(),
            }).returning({ id: agentWakeupRequests.id }).then((rows) => rows[0]);

            await opts.beforeIssueWakeCommit?.(tx as unknown as Db, {
              id: mergedRun.id,
              wakeupRequestId: coalescedWakeup.id,
            });

            return { kind: "coalesced" as const, run: mergedRun };
          }

          const deferredPayload = {
            ...(payload ?? {}),
            issueId,
            [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
          };

          const existingDeferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
                ...(reason === "work_question_continuation" && opts.idempotencyKey
                  ? [eq(agentWakeupRequests.idempotencyKey, opts.idempotencyKey)]
                  : []),
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingDeferred) {
            const existingDeferredPayload = parseObject(existingDeferred.payload);
            const existingDeferredContext = parseObject(
              existingDeferredPayload[DEFERRED_WAKE_CONTEXT_KEY],
            );
            const mergedDeferredContext = mergeCoalescedContextSnapshot(
              existingDeferredContext,
              enrichedContextSnapshot,
            );
            const mergedDeferredPayload = {
              ...existingDeferredPayload,
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: mergedDeferredContext,
            };

            await tx
              .update(agentWakeupRequests)
              .set({
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(eq(agentWakeupRequests.id, existingDeferred.id));

            await opts.beforeIssueWakeCommit?.(tx as unknown as Db, {
              id: existingDeferred.runId,
              wakeupRequestId: existingDeferred.id,
            });

            return { kind: "deferred" as const };
          }

          const deferredWakeup = await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: reason === "work_question_continuation"
              ? reason
              : "issue_execution_deferred",
            payload: deferredPayload,
            status: "deferred_issue_execution",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          }).returning({ id: agentWakeupRequests.id }).then((rows) => rows[0]);

          await opts.beforeIssueWakeCommit?.(tx as unknown as Db, {
            id: null,
            wakeupRequestId: deferredWakeup.id,
          });

          return { kind: "deferred" as const };
        }

        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason,
            payload,
            status: "queued",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: agent.companyId,
            agentId,
            invocationSource: source,
            triggerDetail,
            status: "queued",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: enrichedContextSnapshot,
            sessionIdBefore: sessionBefore,
            humanQuestionWaitMs: inheritedHumanQuestionWaitMs,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: newRun.id,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: agentNameKey,
            executionLockedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issue.id));

        await opts.beforeIssueWakeCommit?.(tx as unknown as Db, {
          id: newRun.id,
          wakeupRequestId: wakeupRequest.id,
        });

        return { kind: "queued" as const, run: newRun };
      });

      if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
      if (outcome.kind === "coalesced") return outcome.run;

      const newRun = outcome.run;
      publishLiveEvent({
        companyId: newRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await dispatchQueuedRunsAfterAgentSignal(agent.id);
      return newRun;
    }

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowup =
      (Boolean(wakeCommentId) || reason === "work_question_continuation") &&
      Boolean(sameScopeRunningRun) &&
      !sameScopeQueuedRun;

    const coalescedTargetRun =
      sameScopeQueuedRun ??
      (shouldQueueFollowup ? null : sameScopeRunningRun ?? null);

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        contextSnapshot,
      );
      const mergedRun = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "coalesced",
        coalescedCount: 1,
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        runId: mergedRun.id,
        finishedAt: new Date(),
      });
      return mergedRun;
    }

    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);

    // PR #291 round-18 #1: create the wakeup request, its heartbeat run, and the
    // request→run link ATOMICALLY. Previously these were three separate writes, so
    // a crash between them could leave a `queued` agent_wakeup_requests row with no
    // run — which the comment-wakeup outbox's idempotency check (round-17 #2) would
    // then treat as "already dispatched" and skip, dropping the summon. With one
    // transaction, a persisted request row ALWAYS has its run, so the existence of
    // the keyed request row genuinely means the dispatch completed.
    const newRun = await db.transaction(async (tx) => {
      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: agent.companyId,
          agentId,
          source,
          triggerDetail,
          reason,
          payload,
          status: "queued",
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          idempotencyKey: opts.idempotencyKey ?? null,
        })
        .returning()
        .then((rows) => rows[0]);

      const run = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: agent.companyId,
          agentId,
          invocationSource: source,
          triggerDetail,
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: enrichedContextSnapshot,
          sessionIdBefore: sessionBefore,
          humanQuestionWaitMs: inheritedHumanQuestionWaitMs,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({ runId: run.id, updatedAt: new Date() })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      return run;
    });

    publishLiveEvent({
      companyId: newRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await dispatchQueuedRunsAfterAgentSignal(agent.id);

    return newRun;
  }

  return {
    list: (companyId: string, agentId?: string, limit?: number) => {
      const query = db
        .select()
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      if (limit) {
        return query.limit(limit);
      }
      return query;
    },

    getRun,

    scheduleBoundedRetryForRun,

    promoteDueScheduledRetries,

    getRuntimeState: async (agentId: string) => {
      const state = await getRuntimeState(agentId);
      const agent = await getAgent(agentId);
      if (!agent) return null;
      const ensured = state ?? (await ensureRuntimeState(agent));
      const latestTaskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id)))
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        ...ensured,
        sessionDisplayId: latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
        sessionParamsJson: latestTaskSession?.sessionParamsJson ?? null,
      };
    },

    listTaskSessions: async (agentId: string) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agentId)))
        .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt));
    },

    resetRuntimeSession: async (agentId: string, opts?: { taskKey?: string | null }) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      await ensureRuntimeState(agent);
      const taskKey = readNonEmptyString(opts?.taskKey);
      const clearedTaskSessions = await clearTaskSessions(
        agent.companyId,
        agent.id,
        taskKey ? { taskKey, adapterType: agent.adapterType } : undefined,
      );
      const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
        sessionId: null,
        lastError: null,
        updatedAt: new Date(),
      };
      if (!taskKey) {
        runtimePatch.stateJson = {};
      }

      const updated = await db
        .update(agentRuntimeState)
        .set(runtimePatch)
        .where(eq(agentRuntimeState.agentId, agentId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return {
        ...updated,
        sessionDisplayId: null,
        sessionParamsJson: null,
        clearedTaskSessions,
      };
    },

    listEvents: (runId: string, afterSeq = 0, limit = 200) =>
      db
        .select()
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq)))
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(Math.max(1, Math.min(limit, 1000))),

    readLog: async (runId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (!run.logStore || !run.logRef) throw notFound("Run log not found");

      const result = await runLogStore.read(
        {
          store: run.logStore as "local_file",
          logRef: run.logRef,
        },
        opts,
      );

      return {
        runId,
        store: run.logStore,
        logRef: run.logRef,
        ...result,
      };
    },

    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "on_demand" | "automation" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: "manual" | "ping" | "callback" | "system" = "manual",
      actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
    ) =>
      enqueueWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),

    wakeup: enqueueWakeup,

    reapOrphanedRuns,

    tickTimers: async (now = new Date()) => {
      const allAgents = await db.select().from(agents);
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      for (const agent of allAgents) {
        if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        checked += 1;
        const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
        const elapsedMs = now.getTime() - baseline;
        if (elapsedMs < policy.intervalSec * 1000) continue;

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason: "interval_elapsed",
            now: now.toISOString(),
          },
        });
        if (run) enqueued += 1;
        else skipped += 1;
      }

      return { checked, enqueued, skipped };
    },

    cancelRun: async (runId: string) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (run.status !== "running" && run.status !== "queued") return run;

      const running = runningProcesses.get(run.id);
      if (running) {
        logger.info(
          {
            runId: run.id,
            agentId: run.agentId,
            pid: running.child.pid,
            processGroupId: running.processGroupId,
            reason: "cancelRun",
          },
          "heartbeat.cancel: signaling SIGTERM",
        );
        signalRunningProcess(running, "SIGTERM");
        const graceMs = Math.max(1, running.graceSec) * 1000;
        setTimeout(() => {
          // If the process exited cleanly during the grace period, the
          // normal completion path will have removed the entry from
          // runningProcesses. Don't log/signal a process that's gone.
          if (!runningProcesses.has(run.id)) return;
          logger.info(
            {
              runId: run.id,
              agentId: run.agentId,
              pid: running.child.pid,
              processGroupId: running.processGroupId,
              reason: "cancelRun.grace-expired",
            },
            "heartbeat.cancel: signaling SIGKILL",
          );
          signalRunningProcess(running, "SIGKILL");
        }, graceMs);
      }

      const cancelled = await setRunStatus(run.id, "cancelled", {
        finishedAt: new Date(),
        error: "Cancelled by control plane",
        errorCode: "cancelled",
      });

      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: new Date(),
        error: "Cancelled by control plane",
      });

      if (cancelled) {
        await cancelRuntimeDecisionPromptsForRun(cancelled, "run cancelled");
        await appendRunEvent(cancelled, 1, {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: "run cancelled",
        });
        await releaseIssueExecutionAndPromote(cancelled);
      }

      // R1 zombie-run teardown: purge any W5b PreToolUse hook tokens for this run
      // NOW. If the CLI's process survived the SIGTERM/taskkill (grandchild
      // orphan), the adapter `await` stays pending and its finally-block
      // deregisterRuntimeHook never runs — the token would otherwise stay valid
      // for its 24h TTL and keep resolving a live broker for zombie hook POSTs.
      // Deregistering by runId closes that window immediately (codex_local uses no
      // HTTP hook, so this is a 0-entry no-op there).
      deregisterRuntimeHooksForRun(run.id);

      // R1 zombie-run teardown: do NOT eagerly delete the runningProcesses entry
      // here. The eager delete made the SIGKILL grace-escalation timer above a
      // no-op (its `runningProcesses.has(run.id)` guard always missed), so a CLI
      // that ignored SIGTERM was never force-killed. Deregistration is owned by
      // spawnTrackedChild's close/error listeners; the escalation timer now fires.
      await finalizeAgentStatus(run.agentId, "cancelled");
      await dispatchQueuedRunsAfterAgentSignal(run.agentId);
      return cancelled;
    },

    cancelActiveForAgent: async (agentId: string) => {
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

      for (const run of runs) {
        await setRunStatus(run.id, "cancelled", {
          finishedAt: new Date(),
          error: "Cancelled due to agent pause",
          errorCode: "cancelled",
        });

        await setWakeupStatus(run.wakeupRequestId, "cancelled", {
          finishedAt: new Date(),
          error: "Cancelled due to agent pause",
        });
        await cancelRuntimeDecisionPromptsForRun(run, "run cancelled due to agent pause");

        const running = runningProcesses.get(run.id);
        if (running) {
          logger.info(
            {
              runId: run.id,
              agentId: run.agentId,
              pid: running.child.pid,
              processGroupId: running.processGroupId,
              reason: "cancelActiveForAgent",
            },
            "heartbeat.cancel: signaling SIGTERM",
          );
          signalRunningProcess(running, "SIGTERM");
          // R1: deregistration is owned by spawnTrackedChild's close/error
          // listeners — no eager delete (see cancelRun).
        }
        await releaseIssueExecutionAndPromote(run);
      }

      // Plan 3 Task 7: also cancel running internal_agent_runs (crew sub-agents)
      await cancelCrewRunsForAgent(db, agentId).catch((err: unknown) => {
        logger.warn({ err, agentId }, "crew run cancellation failed (non-fatal)");
      });

      return runs.length;
    },

    cancelBudgetScopeWork: async (scope: { companyId: string; scopeType: "company" | "agent"; scopeId: string }) => {
      // Agent scope: kill all queued/running runs for that agent.
      if (scope.scopeType === "agent") {
        const runs = await db
          .select()
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.agentId, scope.scopeId), inArray(heartbeatRuns.status, ["queued", "running"])));

        for (const run of runs) {
          await setRunStatus(run.id, "cancelled", {
            finishedAt: new Date(),
            error: "Cancelled due to budget hard-stop",
            errorCode: "cancelled",
          });
          await setWakeupStatus(run.wakeupRequestId, "cancelled", {
            finishedAt: new Date(),
            error: "Cancelled due to budget hard-stop",
          });
          await cancelRuntimeDecisionPromptsForRun(run, "run cancelled due to budget hard-stop");
          const running = runningProcesses.get(run.id);
          if (running) {
            logger.info(
              {
                runId: run.id,
                agentId: run.agentId,
                pid: running.child.pid,
                processGroupId: running.processGroupId,
                reason: "cancelBudgetScopeWork.agent",
              },
              "heartbeat.cancel: signaling SIGTERM",
            );
            signalRunningProcess(running, "SIGTERM");
            // R1: deregistration owned by spawnTrackedChild close/error listeners.
          }
          await releaseIssueExecutionAndPromote(run);
        }
        return runs.length;
      }

      // Company scope: kill all queued/running runs in the company.
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, scope.companyId), inArray(heartbeatRuns.status, ["queued", "running"])));

      for (const run of runs) {
        await setRunStatus(run.id, "cancelled", {
          finishedAt: new Date(),
          error: "Cancelled due to company budget hard-stop",
          errorCode: "cancelled",
        });
        await setWakeupStatus(run.wakeupRequestId, "cancelled", {
          finishedAt: new Date(),
          error: "Cancelled due to company budget hard-stop",
        });
        await cancelRuntimeDecisionPromptsForRun(run, "run cancelled due to company budget hard-stop");
        const running = runningProcesses.get(run.id);
        if (running) {
          logger.info(
            {
              runId: run.id,
              agentId: run.agentId,
              pid: running.child.pid,
              processGroupId: running.processGroupId,
              reason: "cancelBudgetScopeWork.company",
            },
            "heartbeat.cancel: signaling SIGTERM",
          );
          signalRunningProcess(running, "SIGTERM");
          // R1: deregistration owned by spawnTrackedChild close/error listeners.
        }
        await releaseIssueExecutionAndPromote(run);
      }
      // Plan 3 Task 7: also cancel running internal_agent_runs (crew sub-agents).
      await cancelCrewRunsForCompany(db, scope.companyId).catch((err: unknown) => {
        logger.warn({ err, companyId: scope.companyId }, "crew run cancellation failed (non-fatal)");
      });
      return runs.length;
    },

    getActiveRunForAgent: async (agentId: string) => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}
