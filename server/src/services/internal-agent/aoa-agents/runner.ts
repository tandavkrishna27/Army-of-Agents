import { and, eq, sql } from "drizzle-orm";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, unlink } from "node:fs/promises";
import type { Db } from "@armyofagents/db";
import { agents, internalAgentRuns, discussionEntries, issues, threadOrchestrationState, workQuestions } from "@armyofagents/db";
import { getServerAdapter } from "../../../adapters/registry.js";
import { costService } from "../../costs.js";
import { buildMcpConfig, buildCodexAoaMcpSpec, type McpConfigParams } from "../cli-mode.js";
import { stripUserMcpArgs } from "../../mcp-arg-sanitize.js";
import { loadConnectorEgressHosts, resolveAgentConnectors } from "../../mcp-connectors-loader.js";
import { adapterSupportsConnectors } from "../../mcp-connectors.js";
import type { McpServerSpec } from "@armyofagents/adapter-utils";
import { resolveGuardedAdapterExecutionContext, applyEnvironmentAcquisitionConfig } from "../../heartbeat.js";
import { tenantIsolationEnforced } from "../../../config/deployment-mode.js";
import { acquireExecutionContext } from "../../acquire-execution-context.js";
import { environmentRuntimeService } from "../../environment-runtime.js";
import { createLocalAgentJwt } from "../../../agent-auth-jwt.js";
import { resolveBridgeEntrypoint } from "./bridge-path.js";
import { publishLiveEvent, publishIssueStatusChanged, threadWorkingAgents, broadcastThreadPresence } from "../../live-events.js";
import { logger } from "../../../middleware/logger.js";
import { recordDistributedShadow } from "../../distributed-shadow-port.js";
import { getDistributedRolloutPort } from "../../distributed-rollout-port.js";
import { readDistributedCrewRolloutFlag } from "../../../config/distributed-execution.js";
import { buildTaskRunBatchWorkload } from "../../task-run-batch-workload.js";
import { shouldSuppressLegacyExecution } from "../../run-execution-owner.js";
import { resolveCrewDistributedGate } from "./crew-distributed-gate.js";
import { buildCrewHandoffMarkerPatch } from "./crew-handoff-marker.js";
import { computeCostCents } from "../cost-model.js";
import { assembleAgentPersona } from "../commander-context.js";
import { agentInstructionsService } from "../../agent-instructions.js";
import type { AoaRunResult } from "./aoa-run-result.js";
import { buildAoaRunResultFromAdapter } from "./aoa-run-result.js";
import { buildTriggerPrompt } from "./aoa-trigger-prompt.js";
import { deriveEnabledCapabilities } from "./derive-capabilities.js";
import { createToolRegistry } from "../tool-registry.js";
import { redactAndCapPrompt } from "../../prompt-snapshot.js";
import { maybeExecuteFakeCrewTurn } from "./fake-crew-llm.js";
import { getRunLogStore } from "../../run-log-store.js";
import type { RunLogHandle } from "../../run-log-store.js";
import { createCrewRunLogSink } from "./crew-run-log.js";
import type { CrewRunLogSink } from "./crew-run-log.js";
import { getProviderStatus } from "../../../adapters/provider-status.js";
import type { ProviderStatus } from "../../../adapters/provider-status.js";
import { realProviderStatusDeps } from "../../../adapters/provider-status-deps.js";
import { applyModelResolutionToConfig } from "./runner-model-resolution.js";
import { resolveCrewExecutionWorkspace } from "./crew-workspace.js";
import { secretService } from "../../secrets.js";
// Type-only: erased at compile time, so it does NOT pull company-skills' module
// graph (adapter registry + agent/project/secret services) into every consumer
// of the runner. The value import is dynamic, at the call site below.
import type { RuntimeSkillEntry } from "../../company-skills.js";
// Type-only (U6.5): the sandbox-file-movement runner shape captureCrewOutputs
// expects. The value import (`captureCrewOutputs`) is dynamic, at the call
// site below, mirroring crew-run-outcome.js's own dynamic-import discipline.
import type { SandboxFileMovementRunner } from "../../sandbox-file-movement.js";
import {
  bindInternalAgentWorkQuestionContinuation,
  finalizeInternalAgentWorkQuestionContinuation,
} from "../../work-question-continuation-terminal.js";
import { mapCloudProviderKeyError } from "../require-cloud-provider-key.js";

export interface AoaTriggerPayload { companyId: string; source: string; entryId?: string; issueId?: string; [k: string]: unknown; }

/**
 * Phase 5 (Task 5.2): humanized "what is this agent doing" string for the thread
 * presence pill, derived from the crew role key. v1 is a static map — richer
 * per-tool activity ("reading the spec", "running tests") is a deferred
 * follow-up. The chat renders "<Agent> is <activity>…", so each phrase is a bare
 * present-participle clause. Unknown roles fall back to "typing" (the generic
 * group-chat affordance).
 */
export function humanizedActivityForRole(roleKey: string): string {
  switch (roleKey) {
    case "scout":
      return "researching";
    case "planner":
      return "writing the plan";
    case "engineer":
      return "creating an artifact";
    case "adjutant":
      return "reviewing the thread";
    default:
      return "typing";
  }
}

type RunnerAgentShape = { id: string; companyId: string; name: string; adapterConfig: Record<string, unknown> | null };

/**
 * P1 (ii): resolve the instruction text a crew run uses. Prefer the assembled
 * 4-file bundle (founder edits take effect live); fall back to the legacy
 * runtimeConfig.aoa.instruction string. Never throws — assembly failure falls back.
 */
export async function resolveAoaInstruction(args: {
  agent: RunnerAgentShape;
  fallbackInstruction: string;
  assemble?: (a: { agent: RunnerAgentShape; service: ReturnType<typeof agentInstructionsService> }) => Promise<string | null>;
}): Promise<string> {
  const assemble = args.assemble ?? assembleAgentPersona;
  try {
    const persona = await assemble({ agent: args.agent, service: agentInstructionsService() });
    if (persona && persona.trim().length > 0) return persona;
  } catch {
    /* fall through to the legacy string */
  }
  return args.fallbackInstruction;
}

// From Step 1 (authorize-tool.ts + tools/submit-extracted-items.ts): the system
// session identity an AoA sub-agent run uses so the internal-agent bridge
// accepts `submit_extracted_items`. These are NOT placeholders — they are the
// exact values the authorize path requires:
//
//  - submit-extracted-items.ts:66 sets the tool's `requiredRole = "founder"`.
//    authorize-tool.ts ROLE_RANK = { team_member:0, team_lead:1, founder:2 }
//    and the gate is `userRank >= ROLE_RANK[tool.requiredRole]`. requiredRole
//    "founder" => rank 2, so ONLY the literal "founder" satisfies it. Any
//    lower/unknown role fails closed (FORBIDDEN_ROLE).
//  - submit-extracted-items.ts:65 sets the tool's `category = "discussion"`.
//    authorize-tool.ts CAPABILITY_TO_CATEGORY maps `discussion_processing ->
//    "discussion"`, so the session's enabledCapabilities MUST include
//    "discussion_processing" or the call fails (CAPABILITY_DISABLED). No other
//    capability gates this category.
const SUBAGENT_SESSION_USER_ID = "aoa-subagent";
const SUBAGENT_SESSION_USER_ROLE = "founder"; // verified: submit_extracted_items requiredRole === "founder" (rank 2)

// T1.3 (eng-review D4) — Per-agent capability derivation REPLACES this constant
// in the mcpParams construction below. Kept exported (legacy const) for any
// external callers that may still reference it, but the runner itself now
// computes capabilities from the agent's toolAllowlist via
// `deriveEnabledCapabilities`. Before T1.3: every crew agent was capped at
// "discussion_processing", causing CAPABILITY_DISABLED on create_artifact
// (Maker), advance_phase (Adjutant), create_task (Dispatcher),
// suggest_memory (Memory Keeper). See derive-capabilities.ts header for
// the full rationale.
/** @deprecated v1.0 — use `deriveEnabledCapabilities(toolAllowlist, registry)` instead. */
const SUBAGENT_ENABLED_CAPABILITIES = ["discussion_processing"]; // verified: gates category "discussion"
// Suppress "declared but never used" — the constant is intentionally kept for
// back-compat / documentation of the prior behavior; downstream may import it.
void SUBAGENT_ENABLED_CAPABILITIES;

// T1.3: build the registry ONCE at module load. createToolRegistry()
// returns AgentTool[] with static name+category — the heavy callbacks
// (execute, services) are not invoked here. Subsequent runner calls reuse
// this. Keeps the per-wakeup cost down to a few Map lookups.
const TOOL_REGISTRY_FOR_CAPABILITY_DERIVATION = createToolRegistry();

export async function runAoaAgent(db: Db, agentId: string, payload: AoaTriggerPayload): Promise<AoaRunResult> {
  const log = logger.child({ svc: "aoa-runner", agentId, companyId: payload.companyId });
  const startedAt = Date.now();
  const inheritedHumanQuestionWaitMs = typeof payload.humanQuestionWaitMs === "number"
    ? Math.max(0, Math.trunc(payload.humanQuestionWaitMs))
    : 0;
  let runId: string | null = null;
  let cfgPath: string | null = null;
  // Audit #27: prompt snapshot built after triggerPrompt is assembled; persisted
  // by folding into whichever run-row write fires next (completion or failure).
  // Declared at function scope so both the try body and catch block can access it.
  let promptSnapshot: string | null = null;
  // FX1/B1: id of the discussion entry this run atomically CLAIMED
  // (pending→processing). Stays null on the not-claimable early-return so the
  // catch terminalizer never touches an entry this run does not own.
  let claimedEntryId: string | null = null;
  // Phase 5 (Tasks 5.1/5.2): thread this run is "working" on (a thread/mention
  // run carries payload.threadId). Set when we add the agent to the thread
  // working-agents presence store BEFORE adapter.execute; the `finally`
  // GUARANTEES removal (even on throw) by reading these. Null for a task-only /
  // entry-only run (no thread to light a chat pill for). Mirrors the heartbeat
  // presence pattern (heartbeat.ts:2608-2616 add / :4117-4124 remove).
  let presenceThreadId: string | null = null;
  let presenceAgentName: string | null = null;
  // T1 (crew observability): the run's NDJSON transcript handle + the sink that
  // feeds it. Both stay null when the transcript could not be opened (or when
  // there is no runId to attach it to) — the run then behaves exactly as it did
  // before T1 (no-op callbacks). Finalization lives in the single `finally`
  // below, so every exit path (benign early returns, success, throw) converges
  // on exactly one finalize without a per-exit call site.
  let runLogHandle: RunLogHandle | null = null;
  let crewLogSink: CrewRunLogSink | null = null;
  // W3a (P1 fix): `const agent` is scoped INSIDE the try, so the catch block
  // cannot read `agent.name`/`agent.runtimeConfig` (TS2304). Capture the two
  // fields the FAILURE loopback needs into function-scope locals right after the
  // agent row loads, and have the catch wiring use THESE (never `agent`). Do NOT
  // widen the `agent` const itself — the success wiring stays in the try scope.
  let outcomeAgentName: string | undefined;
  let outcomeAgentRuntimeConfig: Record<string, unknown> | null | undefined;
  // U12: capture the resolved provider id for the top-level catch's
  // mapCloudProviderKeyError call. `providerId` (below) is block-scoped
  // inside the try and out of scope in the catch — same pattern as
  // outcomeAgentName/outcomeAgentRuntimeConfig above (the P1 fix).
  let outcomeProviderId: string | null = null;
  // FIX 1 (Wave 2 adversarial review, HIGH — cloud VM/lease leak): the U4
  // sandbox-lease acquire result, captured at FUNCTION scope so the `finally`
  // below can see it and release the lease on every exit. The `acquired` const
  // at the acquire call site (below) is block-scoped inside the try — same
  // problem the P1 fix (outcomeAgentName/outcomeAgentRuntimeConfig) already
  // solved for the catch block; this solves it for the finally block. Stays
  // null on every early-return path that never reaches the acquire call, so
  // the finally's release is correctly a no-op for those.
  let acquiredContext: Awaited<ReturnType<typeof acquireExecutionContext>> | null = null;
  try {
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((r: any[]) => r[0] ?? null);
    if (!agent) {
      log.warn("aoa agent missing; skip");
      // T1.0: even no-op early returns expose a status to the dispatcher
      // so the wakeup row reflects what happened. "agent gone" is a failed
      // run from the wakeup's perspective (something asked for an agent
      // that doesn't exist anymore — orphan wakeup).
      return { status: "failed", errorMessage: "aoa agent missing", runId };
    }

    // SECURITY (Layer C — cross-tenant backstop). The run's company comes from
    // payload.companyId (the dispatcher sets it from the trusted wakeup row).
    // Assert the loaded agent ACTUALLY belongs to that company. A company-A
    // agent must NEVER execute in another company's context: payload.companyId
    // becomes mcpParams.companyId below — the tenant its live MCP tools read and
    // write — plus the run row and cost attribution. This holds even if a future
    // enqueue path bypasses the agent.dispatch allowlist (Layer A) or the
    // dispatcher's spread ordering (Layer B). Refuse with a failed status,
    // mirroring the "aoa agent missing" early-return (runId is still null here,
    // so no run row, mcpParams, or adapter execution is ever built).
    if (agent.companyId !== payload.companyId) {
      log.error(
        { agentCompanyId: agent.companyId, runCompanyId: payload.companyId },
        "aoa agent company mismatch; refusing cross-tenant run",
      );
      return { status: "failed", errorMessage: "aoa agent company mismatch", runId };
    }

    // W3a (P1 fix): capture the two fields the FAILURE loopback (in the catch,
    // where `agent` is out of scope) needs, so it can card + summarize without a
    // TS2304. The SUCCESS wiring below still uses `agent` directly (in scope).
    outcomeAgentName = agent.name;
    outcomeAgentRuntimeConfig = agent.runtimeConfig as Record<string, unknown> | null | undefined;

    const inserted = await db.insert(internalAgentRuns).values({
      companyId: payload.companyId, agentId, // Finding R1: per-agent attribution
      triggerType: "sub_agent", triggerSource: payload.source,
      // Spec B Task 5: a task wakeup stamps relatedEntityType="task" (the runs
      // column vocabulary is 'discussion'|'task'|'agent'|'goal'|'memory' — NOT
      // "issue"). issueId takes precedence over entryId (a task wakeup never
      // also carries an entry to claim).
      status: "running", relatedEntityType: payload.issueId ? "task" : payload.entryId ? "discussion" : null,
      relatedEntityId: payload.issueId ?? payload.entryId ?? null, userId: null,
      continuationIdempotencyKey:
        typeof payload.continuationAttemptIdempotencyKey === "string"
          ? payload.continuationAttemptIdempotencyKey
          : typeof payload.continuationIdempotencyKey === "string"
            ? payload.continuationIdempotencyKey
            : null,
      humanQuestionWaitMs: inheritedHumanQuestionWaitMs,
    }).returning();
    runId = inserted[0]?.id ?? null;
    const continuationIdempotencyKey = typeof payload.continuationIdempotencyKey === "string"
      ? payload.continuationIdempotencyKey
      : null;
    if (runId && continuationIdempotencyKey && typeof payload.wakeupId === "string") {
      await bindInternalAgentWorkQuestionContinuation(db, {
        companyId: payload.companyId,
        runId,
        idempotencyKey: continuationIdempotencyKey,
        agentId,
        wakeupId: payload.wakeupId,
      });
    }

    // M2/#99 atomic claim: flip pending→processing AND link extraction_run_id
    // in ONE statement. Empty RETURNING ⇒ already claimed ⇒ abort (mirrors
    // extraction.ts:389-402). Without this the dispatcher re-runs the same
    // pending entry every tick.
    //
    // P1-C fix: gate this claim on `payload.source === 'outbox'` so it only
    // fires for the extraction trigger (Scribe). Without the gate, mention-
    // and phase-advance-driven agents (Maker, Router, etc.) would attempt to
    // claim the entry's extraction lock, fail (because the entry is in
    // terminal state — completed/failed — for any extraction the Scribe
    // already finished), and abort before running any actual agent logic.
    // For non-outbox sources the entry is *context*, not work to claim.
    if (payload.entryId && payload.source === "outbox") {
      const claimed = await db.update(discussionEntries)
        .set({ extractionStatus: "processing", extractionRunId: runId })
        .where(and(
          eq(discussionEntries.id, payload.entryId),
          eq(discussionEntries.extractionStatus, "pending"),
        ))
        .returning();
      if (claimed.length === 0) {
        if (runId) {
          await db.update(internalAgentRuns)
            .set({ status: "failed", errorMessage: "not claimable (concurrent)", completedAt: new Date() })
            .where(eq(internalAgentRuns.id, runId));
        }
        log.info("entry not claimable (already processing/terminal) — skipping");
        // T1.0: concurrent claim race is not a true failure (another run
        // owns this entry, will handle it). Return succeeded so the
        // dispatcher doesn't count it toward the failure-storm brake (T1.9).
        // The internal_agent_runs row is still marked failed above so the
        // operator sees the skip for this specific run attempt.
        return { status: "succeeded", runId };
      }
      // Claim succeeded — this run now OWNS the entry. Record it so a later
      // failure can terminalize it (FX1/B1).
      claimedEntryId = payload.entryId;
    }

    // Spec B Task 5 — TASK CHECKOUT CLAIM. A task wakeup must atomically CLAIM
    // the issue before the adapter runs: issueService.checkout flips
    // todo/backlog/in_progress → in_progress and sets executionRunId=runId
    // (single-agent lock; assertAssignableAgent enforces company scope). A
    // contended checkout THROWS conflict("Issue checkout conflict"). That is a
    // BENIGN concurrency skip (another run already owns the task), not a true
    // failure — so we mark the run ROW 'failed' (the runs enum has no
    // 'succeeded') with a clear errorMessage, then return the AoaRunResult
    // 'succeeded' so the dispatcher's failure-storm brake does not count it.
    // Mirrors the entry-claim race precedent above (the not-claimable branch).
    if (payload.issueId && runId) {
      const { issueService } = await import("../../issues.js");
      try {
        await issueService(db).checkout(payload.issueId, agentId, ["todo", "backlog", "in_progress"], runId);
      } catch (err) {
        log.info({ issueId: payload.issueId, err: (err as Error)?.message }, "task checkout conflict — another run owns it; skipping");
        await db.update(internalAgentRuns)
          .set({ status: "failed", errorMessage: "task checkout conflict (concurrent)", completedAt: new Date(), durationMs: Date.now() - startedAt })
          .where(and(eq(internalAgentRuns.id, runId), eq(internalAgentRuns.status, "running")));
        if (continuationIdempotencyKey) {
          await finalizeInternalAgentWorkQuestionContinuation(db, {
            companyId: payload.companyId,
            runId,
            status: "failed",
            error: "task checkout conflict (concurrent)",
          });
        }
        return { status: "succeeded", runId }; // benign concurrency skip — mirror entry-claim race
      }
    }

    const rc = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
    const aoaCfg = (rc.aoa ?? {}) as Record<string, unknown>;
    const fallbackInstruction = typeof aoaCfg.instruction === "string" ? aoaCfg.instruction : "";
    const instruction = await resolveAoaInstruction({
      agent: {
        id: agent.id,
        companyId: agent.companyId,
        name: agent.name,
        adapterConfig: (agent.adapterConfig ?? null) as Record<string, unknown> | null,
      },
      fallbackInstruction,
    });

    // D2: read per-agent toolAllowlist from runtimeConfig.aoa.toolAllowlist.
    // The runner always sets agentKind='aoa' so the bridge activates
    // default-deny. toolAllowlist is pulled from the agent's runtimeConfig
    // so the seed values (ensureExtractionAgent / ensureCommanderAgent) govern
    // what each agent is allowed to call — no separate config required.
    const toolAllowlistFromConfig = Array.isArray(aoaCfg.toolAllowlist)
      ? (aoaCfg.toolAllowlist as string[])
      : [];

    // T1.3 (eng-review D4): derive enabledCapabilities PER-AGENT from the
    // agent's toolAllowlist. Pre-T1.3 every crew run got the blanket
    // ["discussion_processing"] constant — that failed-closed on
    // create_artifact (Maker), advance_phase (Adjutant), create_task
    // (Dispatcher), and suggest_memory (Memory Keeper) because those tools
    // require categories the constant didn't grant. Per-agent derivation
    // keeps the COARSE capability gate as a real second line of defense:
    // if Router's allowlist is ever broadened in a future regression, it
    // STILL won't have system_actions — its derived capability set is
    // ["discussion_processing"] only. Pure function — exhaustively unit-
    // tested in derive-capabilities.test.ts.
    const enabledCapabilities = deriveEnabledCapabilities(
      toolAllowlistFromConfig,
      TOOL_REGISTRY_FOR_CAPABILITY_DERIVATION,
    );

    const bridgeThreadId = typeof payload.threadId === "string" ? payload.threadId : undefined;
    const isActionGatedDiscussionRun = Boolean(bridgeThreadId) && (
      payload.source === "thread.controller" ||
      payload.source === "thread.participation" ||
      payload.source === "mention" ||
      payload.source === "agent.dispatch"
    );
    const discussionRunMode: "controller_action_gate" | null =
      isActionGatedDiscussionRun ? "controller_action_gate" : null;
    let threadFreshness: Record<string, unknown> | null = null;
    if (bridgeThreadId && isActionGatedDiscussionRun) {
      try {
        const { captureFreshnessSnapshot } = await import("../../thread-agent-action-freshness.js");
        threadFreshness = await captureFreshnessSnapshot(db as never, bridgeThreadId);
      } catch (freshnessErr) {
        // The captured snapshot stays null → the action row stores `{}` → the
        // later commit reports `snapshot_unavailable` (NOT a false
        // `newer_human_entry`). Escalate with threadId+runId so a fully-
        // suppressed run can be traced back to this capture failure.
        log.warn(
          { err: freshnessErr, threadId: bridgeThreadId, runId },
          "aoa-runner: failed to capture thread freshness snapshot — actions this run proposes may be suppressed as snapshot_unavailable",
        );
      }
    }

    const adapter = getServerAdapter(agent.adapterType);

    // MX2: the bridge params are identical for both the claude {mcpServers}
    // envelope and the provider-neutral spec — build them once. Explicit
    // McpConfigParams annotation (rather than the previous inferred literal
    // type) so U4b can assign `.brokered`/`.apiBaseUrl` onto this SAME object
    // after the sandbox lease is acquired below, instead of rebuilding it.
    const mcpParams: McpConfigParams = {
      companyId: payload.companyId,
      userId: SUBAGENT_SESSION_USER_ID,
      userRole: SUBAGENT_SESSION_USER_ROLE,
      // T1.3: per-agent capability set (was: SUBAGENT_ENABLED_CAPABILITIES).
      enabledCapabilities,
      bridgeEntrypoint: resolveBridgeEntrypoint(),
      agentKind: "aoa",
      // T8 Defect A: crew is an autonomous agent actor, not a board/Commander
      // caller. Without this the bridge defaults AOA_ACTOR_TYPE to "board", and
      // ask_human's identity gate (actorType==="agent") rejects every crew run.
      // Mirrors the org heartbeat path (heartbeat.ts). Never set on the
      // Commander path — that sets actorType:"commander" (cli-mode.ts).
      actorType: "agent",
      toolAllowlist: toolAllowlistFromConfig,
      agentId,
      runId,
      humanQuestionCapabilities: adapter.humanQuestionCapabilities,
      discussionRunMode,
      threadFreshness,
      effectiveAutonomy: typeof payload.effectiveAutonomy === "number"
        ? payload.effectiveAutonomy
        : null,
    };
    // MX2: the claude {mcpServers} JSON temp file is still written
    // UNCONDITIONALLY (and unlinked in `finally` for every run) so the
    // tmp-file cleanup contract is adapter-agnostic. For non-claude adapters
    // the file is simply never referenced (harmless, unused) — only
    // claude-family gets `--mcp-config <file>` injected into config.args.
    // The write happens BEFORE buildMcpBridgeSpec so `cfgPath` is always set
    // by the time any later step can fail — the `finally` unlink invariant
    // ("if we created the temp file we always remove it") holds regardless of
    // where a downstream error occurs.
    // MCP connectors: resolve THIS agent's enabled company connectors —
    // per-agent opt-in, so the REAL `agentId` (never null) — into adapter specs
    // + the env map carrying the real secrets. Secrets ride ONLY in the
    // delivered `config.env` (merged below for every adapter), never in the
    // config FILE, which holds `${AOA_MCP_*_TOKEN}` placeholders.
    //
    // U11 (real-shape drift fix): the actual resolve call is DEFERRED to just
    // after the U4/U12 sandbox acquire further below. `sandboxTarget` — whether
    // a stdio connector is admissible in-VM (S5) — can only be known from
    // `acquired.sandbox?.environment.driver === "sandbox"`, and U12 already
    // relocated the acquire to run AFTER provider-credential resolution
    // succeeds (so a cloud run with no company key fails before any sandbox —
    // now also any connector DB read — is spent). Declared here so both are in
    // scope for `connectorEnvMerge` / `buildMcpConfig` / `adapter.execute`'s
    // `mcpServers` below.
    let extraMcpServers: Record<string, McpServerSpec> | undefined;
    let connectorEnv: Record<string, string> = {};

    // U12 (real-shape drift fix): the U4 sandbox acquire used to sit HERE,
    // immediately after connector resolution and before provider-credential
    // resolution below. That ordering meant a cloud run with NO company
    // provider key still leased (and paid for) a sandbox before
    // resolveProviderCredential got a chance to throw ProviderUnavailableError
    // — directly contradicting U12's "fail before any sandbox spend"
    // guarantee (confirmed empirically: aoa-runner-cloud-provider-key.test.ts
    // observed acquireExecutionContext called even though the credential
    // resolution rejected). Nothing between here and the acquire's new home
    // (just before `const config` below) depends on `acquired`/`cfgPath`/
    // `bridgeSpec`/`mcpParams.brokered` — baseConfig, the context bundle, the
    // trigger prompt, and the whole credential-resolution block are all
    // independent of the sandbox lease — so relocating the acquire+MCP-config
    // block down there (after resolvedBaseConfig is computed, right before
    // `cfgPath` is first consumed) is a pure reorder: identical outputs on
    // every path, but now a ProviderUnavailableError throws BEFORE any
    // sandbox is ever requested.
    const baseConfig = { ...(agent.adapterConfig ?? {}) } as Record<string, unknown>;
    const prevArgs = Array.isArray(baseConfig.args) ? (baseConfig.args as string[]) : [];

    // T1.2 (codex F1): build a concrete role-aware trigger prompt so the LLM
    // has something to act on. Before this, every crew run got the adapter's
    // default 14-word placeholder ("You are agent <uuid> (<Name>). Continue
    // your AoA work.") with NO mention of the trigger, thread, inviting
    // entry, or what tool to call. Result: claude/codex ran 30s, read the
    // bundle, exited without calling any MCP tool. T1.2 puts the trigger
    // context + role action directive in the user prompt itself.
    //
    // Role lookup keys off runtimeConfig.aoa.role (the seed key like 'scribe'
    // / 'maker' / 'adjutant') NOT agent.name (codex F7 — marketplace install
    // can rename on conflict). Falls back to a slugified agent.name when the
    // role key is absent (unknown name → generic directive in the prompt).
    // aoaCfg is already defined above (line ~132) as `(rc.aoa ?? {}) as Record<string, unknown>`.
    const agentRoleKey =
      typeof aoaCfg.role === "string" && aoaCfg.role.length > 0
        ? aoaCfg.role
        : agent.name.toLowerCase().replace(/\s+/g, "_");

    // Phase 4 (Task 4.3): build the crew context bundle so the agent does NOT
    // start blind. Before this, a thread/mention run's dynamic prompt block was
    // IDs only (Thread/Inviting entry/Mention) → an @mentioned agent had to
    // fetch everything via tools and often answered "no precedent found". The
    // bundle injects the conversation + the Chronicler summary + relevant
    // memory (and, for tasks, the task body + upstream artifact) directly.
    //
    // Gated on threadId|issueId: an entry-only extraction run (Scribe/outbox)
    // has no thread or task to summarize, so there's nothing to inject and we
    // skip the work entirely. BEST-EFFORT: wrapped in try/catch exactly like
    // the redactAndCapPrompt snapshot below — a bundle failure (e.g. memory/
    // pgvector hiccup) must NEVER break a run. Empty bundle ⇒ no `## Context`
    // section (the prompt stays byte-identical to the pre-Phase-4 form).
    let contextBundle = "";
    const bundleThreadId = bridgeThreadId;
    const bundleIssueId = typeof payload.issueId === "string" ? payload.issueId : undefined;
    if (bundleThreadId || bundleIssueId) {
      try {
        const { buildCrewContextBundle } = await import("./crew-context-bundle.js");
        contextBundle = await buildCrewContextBundle(db, {
          companyId: payload.companyId,
          threadId: bundleThreadId,
          issueId: bundleIssueId,
          agentId,
          // P1-T4: thread the run id so CREW memory retrieval is audited (O4).
          runId,
          // P1-T6: role label for the always-on core (goal title omitted on the
          // crew path — the bundle does not load the goal).
          agentRole: agent.role ?? agent.name ?? null,
        });
      } catch (bundleErr) {
        log.warn({ err: bundleErr }, "aoa-runner: failed to build crew context bundle (best-effort, ignored)");
      }
    }

    const triggerPrompt = buildTriggerPrompt({
      instruction,
      payload,
      agentName: agent.name,
      agentRoleKey,
      contextBundle,
    });

    // Provider-switching (Unit B): resolve the model auth-aware + shell-safe and
    // strip any inherited company OPENAI_API_KEY before spawn. getProviderStatus
    // (Unit A) is the real detector; resolveModel throws on shell-unsafe — caught
    // by the run's existing try/catch and surfaced via Unit E.
    //
    // Provider-status detection is best-effort (consistent with the runner's other
    // guarded I/O): a detection hiccup must not abort an otherwise-ready run. Model
    // RESOLUTION still hard-fails on shell-unsafe input — that throw comes from
    // applyModelResolutionToConfig below, outside this guard, and is recorded as a
    // failed run by the outer catch.
    // Crew path MUST resolve env bindings (secret_ref/plain → string) BEFORE
    // provider detection + model resolution + spawn. Saved env entries are
    // normalized to binding objects, and codex-local copies only STRING env into
    // the child — so an unresolved per-agent OPENAI_API_KEY would be detected as
    // apikey here yet never reach the codex child, breaking the run. Mirror the
    // org (heartbeat) path. resolveEnvBindings no-ops to {} for agents with no
    // env; a missing secret throws → recorded as a failed run by the outer catch
    // (correct — the run can't proceed without the configured key). (Codex P2.)
    //
    // Resolve the AGENT's OWN env ONLY here — NOT the company-key fallback. The
    // legacy company `provider:<id>` key is deferred to the unified resolver's
    // Step 4 (via resolveDeps.legacyResolveConfig below), exactly like heartbeat
    // (heartbeat.ts:3217/3222). Pre-injecting the company key into currentEnv
    // would trip the resolver's Step-0 agent_env_override short-circuit
    // (provider-resolution.ts:300-305) and MASK every provider_assignments row —
    // agent_override / personal_execution_default / company_default / org_default,
    // including a founder's explicit agent→connection pin. So the company-key
    // fallback must run AFTER the assignment lookup, never before it.
    const resolvedEnv = await secretService(db).resolveEnvBindings(agent.companyId, baseConfig.env, {
      consumerType: "agent",
      consumerId: agent.id,
      actorType: "agent",
      actorId: agent.id,
    });

    // Unified provider-credential resolution (Phase 4). Reads the new
    // provider_connections model FIRST; falls back to the legacy company-key /
    // subscription ladder when no assignment exists (STRANGLER). This is also where
    // crew FINALLY honors a personal_subscription binding — the old runner path never
    // called resolveAgentSubscriptionEnvironment. Plan's stale local names
    // (`adapterDeploymentMode`/`adapterDeploymentExposure`) do not exist in this
    // runner; deployment mode/exposure come from loadConfig() (same source
    // providers.ts uses to build the topology).
    const { resolveProviderCredential, applyResolvedCredential } = await import(
      "../../provider-resolution.js"
    );
    const { buildResolveDeps } = await import("../../provider-resolution-deps.js");
    const { resolveCliAuthTopology } = await import("../../cli-auth-topology.js");
    const { loadConfig } = await import("../../../config.js");
    const runnerDeployConfig = loadConfig();
    const topology = resolveCliAuthTopology({
      deploymentMode: runnerDeployConfig.deploymentMode,
      deploymentExposure: runnerDeployConfig.deploymentExposure,
    });
    const providerId =
      agent.adapterType === "codex_local"
        ? "openai"
        : agent.adapterType === "claude_local"
          ? "anthropic"
          : agent.adapterType;
    // U12: capture for the top-level catch's mapCloudProviderKeyError call
    // (the catch cannot read the block-scoped `providerId` above).
    outcomeProviderId = providerId;
    const resolveDeps = {
      ...buildResolveDeps(db, topology),
      // Bind the legacy fallback to THIS adapter (deps default is identity).
      legacyResolveConfig: async (cfg: Record<string, unknown>) =>
        secretService(db).resolveAdapterConfigForRuntime(agent.companyId, agent.adapterType, cfg, {
          consumerType: "agent",
          consumerId: agent.id,
          actorType: "agent",
          actorId: agent.id,
        }),
    };
    const resolvedCredential = await resolveProviderCredential(
      db,
      {
        organizationId: null,
        companyId: agent.companyId,
        agentId: agent.id,
        actorKind: "crew",
        adapterType: agent.adapterType,
        provider: providerId,
        executionTargetId: process.env.AOA_EXECUTION_TARGET_ID?.trim() || "control-plane",
        currentEnv: resolvedEnv,
        context: {
          consumerType: "agent",
          consumerId: agent.id,
          actorType: "agent",
          actorId: agent.id,
        },
      },
      resolveDeps,
    );
    // Reunite the resolver's credential patch with the agent's adapter config
    // (command/cwd/model/args from baseConfig) + agent-only resolvedEnv — the
    // resolver's Step 4 (legacyResolveConfig) is where the company key finally
    // lands for the no-assignment case, so applyResolvedCredential carries it in.
    const runtimeBaseConfigResolved = applyResolvedCredential(
      { ...baseConfig, env: resolvedEnv } as Record<string, unknown>,
      resolvedCredential,
    );

    let providerStatus: ProviderStatus;
    try {
      providerStatus = await getProviderStatus(
        agent.adapterType,
        { companyId: agent.companyId, adapterConfig: runtimeBaseConfigResolved },
        realProviderStatusDeps,
      );
    } catch (statusErr) {
      log.warn({ err: statusErr }, "aoa-runner: provider status detection failed (best-effort fallback to unknown)");
      providerStatus = {
        adapterType: agent.adapterType,
        installed: true,
        authenticated: false,
        authMode: "unknown",
        defaultModelResolved: null,
      };
    }
    const resolvedBaseConfig = applyModelResolutionToConfig(
      agent.adapterType,
      runtimeBaseConfigResolved,
      providerStatus,
      { inheritedEnvOpenAiKey: process.env.OPENAI_API_KEY ?? null },
    );

    // MX2: only claude-family CLIs understand `--mcp-config <file>`. Injecting
    // it for codex/opencode/etc. leaked an invalid flag into their argv (the
    // reason codex AoA agents got zero MCP tools). claude_local is the ONLY
    // claude CLI adapter (registry.ts) — do not broaden.
    //
    // Task 12: AoA's `--mcp-config cfgPath --strict-mcp-config` prefix MUST land
    // in the adapter-PREFERRED arg key, mirroring the heartbeat site. The
    // claude-local adapter (execute.ts) prefers `extraArgs` over `args` when
    // `extraArgs` is non-empty. The UI "Extra args" box writes `adapterConfig.
    // extraArgs`. If we hardcoded `args` here, a founder's `extraArgs` (evil or
    // even benign like `--model opus`) would be preferred by the adapter and
    // SHADOW AoA's `args`-injected config — a governance bypass AND broken
    // connector delivery. So target the same key the adapter will read, and
    // sanitize ONLY the user tail from that key (never AoA's own prepended
    // flags — passing the whole array through stripUserMcpArgs would delete
    // AoA's own config and break every MCP run).
    //
    // T1.2: every adapter (claude/codex/opencode/gemini) honors
    // `config.promptTemplate` via their `renderTemplate(promptTemplate, ...)`
    // call site, so passing the built trigger prompt as promptTemplate flows
    // through uniformly. The prompt has no {{...}} tokens — renderTemplate
    // returns it verbatim.
    const isClaudeFamily = agent.adapterType === "claude_local";
    const resolvedConfigRecord = resolvedBaseConfig as Record<string, unknown>;
    const argKey = Array.isArray(resolvedConfigRecord.extraArgs) ? "extraArgs" : "args";
    const userTail = Array.isArray(resolvedConfigRecord[argKey])
      ? (resolvedConfigRecord[argKey] as unknown[]).filter((v): v is string => typeof v === "string")
      : prevArgs;

    // U4 (relocated by U12 — see the note above baseConfig): acquire the
    // sandbox lease immediately BEFORE buildMcpConfig so U4b can set
    // mcpParams.brokered/apiBaseUrl on the SAME mcpParams before the MCP
    // config file / bridge spec are built. R1/Q1: crew is ALWAYS ephemeral,
    // never warm. `worktree: null` — crew has no host worktree (A+ model, U6).
    // environmentId comes from the agent's own defaultEnvironmentId column
    // (agents.default_environment_id — NOT adapterConfig, which has no such
    // field); null flows straight through to the orchestrator, which resolves
    // the platform default on cloud (U1) or throws environment_not_found on
    // desktop (caught below -> sandbox:null, local path unchanged).
    //
    // U12: this now runs AFTER provider-credential resolution succeeds (the
    // block above, ending at resolvedBaseConfig) — a cloud run with no
    // company key throws ProviderUnavailableError well before this line is
    // ever reached, so no sandbox is leased for a run that is about to fail.
    //
    // U11: a PRE-acquire, best-effort estimate of the hosts THIS agent's
    // connectors might need, fed into the acquire's egressAllowlist. Real
    // connector resolution happens AFTER this acquire (its own sandboxTarget
    // input comes FROM `acquired`, per U11's own reorder above), so the
    // actual delivered set cannot be known yet — deliberately optimistic (see
    // loadConnectorEgressHosts' doc-comment) and never throws.
    const crewEgressHosts = adapterSupportsConnectors(agent.adapterType)
      ? await loadConnectorEgressHosts(db, { companyId: agent.companyId, agentId: agent.id })
      : [];
    const acquired = await acquireExecutionContext(db, {
      runIdentity: { companyId: agent.companyId, agentId: agent.id, runId: runId ?? `aoa-${agentId}`, adapterType: agent.adapterType },
      functionType: null,
      // Crew (`kind='aoa'`) is ALWAYS ephemeral — never warm (spec §7 /
      // resolveWarmSandboxPreference's crew_always_ephemeral rule, U7.2).
      warmPreference: false,
      worktree: null,
      environmentId: agent.defaultEnvironmentId ?? null,
      egressAllowlist: crewEgressHosts,
    });
    // FIX 1: mirror into the function-scoped local the `finally` release reads.
    // Assigned unconditionally (including the sandbox:null desktop/local_trusted
    // case) so the finally's `acquiredContext?.sandbox` check is always accurate.
    acquiredContext = acquired;
    // U4b (S7 blocker): a resolved provider-sandbox lease means this run's CLI
    // will execute inside an E2B VM — the `aoa` MCP server MUST ride the
    // brokered HTTP transport there, never the stdio bridge (whose env carries
    // DATABASE_URL, cli-mode.ts's buildMcpBridgeSpec). `acquired.sandbox` is
    // null on desktop/local_trusted (acquireExecutionContext's S1 contract),
    // so `brokered` is false there and delivery stays byte-identical.
    mcpParams.brokered = acquired.sandbox?.environment.driver === "sandbox";
    // No per-run "resolved" control-plane URL exists on the crew path (unlike
    // the agent's OWN provider env, resolved further below as `resolvedEnv` —
    // AOA_API_URL is never part of that agent-configured env). The control
    // plane's own address is the platform's, not the tenant's, so read it
    // directly off the server process env (only consulted when brokered).
    mcpParams.apiBaseUrl = process.env.AOA_API_URL ?? undefined;

    // MCP connectors: resolve THIS agent's enabled company connectors — per-
    // agent opt-in, so the REAL `agentId` (never null) — into adapter specs +
    // the env map carrying the real secrets. Secrets ride ONLY in the
    // delivered `config.env` (merged below for every adapter), never in the
    // config FILE, which holds `${AOA_MCP_*_TOKEN}` placeholders.
    //
    // Gated on CONNECTOR-CAPABLE adapters (Plan 2b Task 3, widened from
    // claude_local-only) using the same shared predicate as the heartbeat site:
    // the four CLI adapters can host external MCP servers — claude consumes
    // them via `--mcp-config`, the rest via `ctx.mcpServers` — while
    // `process`/`http`/`cursor`/`hermes_local` have no MCP client at all and
    // must not pay for the DB read.
    //
    // U11: sourced from THIS run's just-acquired execution context —
    // `acquired.sandbox?.environment.driver === "sandbox"` (S5, the SAME
    // predicate `mcpParams.brokered` above uses, never a top-level
    // `acquired.driver`) — so a stdio connector is delivered in-VM but still
    // dropped on an unsandboxed host.
    if (adapterSupportsConnectors(agent.adapterType)) {
      const resolved = await resolveAgentConnectors(db, {
        companyId: agent.companyId,
        agentId,
        runId: runId ?? undefined,
        logger: log,
        sandboxTarget: acquired.sandbox?.environment.driver === "sandbox",
      });
      extraMcpServers = resolved.extraMcpServers;
      connectorEnv = resolved.connectorEnv;
    }

    // A29 — do NOT scrub: connector tokens merge ON TOP of the already
    // secret-bound env. `resolvedBaseConfig` is post provider-credential
    // resolution (resolveEnvBindings + resolveProviderCredential) +
    // applyModelResolutionToConfig (i.e. post-secret-binding), so merging here
    // is not re-scrubbed downstream. Only add the env override when connectors
    // actually exist so the no-connector case is byte-identical to the pre-task
    // delivery. `...connectorEnvMerge` is placed AFTER `...resolvedBaseConfig` (a
    // connector token wins over a same-named base key) but BEFORE `[argKey]`
    // (AoA's own args still override).
    //
    // Plan 2b Task 3: hoisted OUT of the claude branch. Every connector-capable
    // adapter copies `config.env` into its child's spawn env, so this one merge
    // is the whole secret-delivery path for codex/opencode/gemini too — the
    // matching specs travel structurally on `ctx.mcpServers` below. Only the
    // `--mcp-config` argv injection stays claude-only (the other CLIs would
    // reject the flag).
    const connectorEnvMerge =
      Object.keys(connectorEnv).length > 0
        ? { env: { ...(resolvedConfigRecord.env as Record<string, string> | undefined), ...connectorEnv } }
        : {};

    const mcp = buildMcpConfig({ ...mcpParams, extraMcpServers });
    cfgPath = join(tmpdir(), `aoa-mcp-${agentId}-${runId ?? "x"}.json`);
    await writeFile(cfgPath, JSON.stringify(mcp, null, 2));
    // MX2: provider-neutral bridge spec handed to EVERY adapter via
    // ctx.mcpBridge. Non-claude adapters (codex/opencode/...) consume this in
    // a later milestone (MX3); claude keeps its own --mcp-config delivery
    // below. Building it unconditionally is cheap and keeps the contract
    // uniform across adapters.
    //
    // U4b: buildCodexAoaMcpSpec is the brokered-aware selector — despite the
    // name, it is provider-neutral (codex/opencode/gemini all consume the
    // same McpBridgeSpec | McpHttpServerSpec union via ctx.mcpBridge). A
    // brokered run gets the HTTP form here (no DATABASE_URL); non-brokered
    // falls through to the unchanged buildMcpBridgeSpec stdio bridge.
    const bridgeSpec = buildCodexAoaMcpSpec(mcpParams);

    const config = isClaudeFamily
      ? { ...resolvedBaseConfig, promptTemplate: triggerPrompt, ...connectorEnvMerge, [argKey]: ["--mcp-config", cfgPath, "--strict-mcp-config", ...stripUserMcpArgs(userTail)] }
      : { ...resolvedBaseConfig, promptTemplate: triggerPrompt, ...connectorEnvMerge };
    // U4: fold the U4-acquired sandbox's configPatch (executionTarget etc.) over
    // `config` BEFORE the guarded-context resolution below. No-ops (returns
    // `config` unchanged) when `acquired.sandbox` is null (desktop/local_trusted
    // — environment_not_found) or carries an empty patch, so the local path
    // stays byte-identical.
    const configWithSandbox = applyEnvironmentAcquisitionConfig(config, acquired.sandbox);
    // Sink-level multi_tenant hardening (trustBoundary) + D1 unsandboxed gate
    // (cloud_auth) for CREW runs. `topology` is already resolved above (:544);
    // tenantIsolationEnforced() is the cloud_auth signal.
    const { executionTarget, runtimeCommandSpec } = resolveGuardedAdapterExecutionContext(
      configWithSandbox,
      adapter,
      {
        trustBoundary: topology.trustBoundary,
        tenantIsolationEnforced: tenantIsolationEnforced(),
        sink: "crew agent",
      },
    );

    // ── MIG-006 slice 1 — the crew distributed-execution seam ─────────────────
    // The crew analogue of the heartbeat/org CLI-006 canary transfer: gate this crew run to the
    // distributed substrate, or fall through to the legacy in-process adapter below. Ships INERT
    // behind the SEPARATE off-by-default crew flag (a task_run-canary org must not auto-arm
    // tool-less crew). The rollout hook is read LAZILY through the process-wide port —
    // runAoaAgent is a plain exported function with no options object, and an eager capture would
    // be a silent no-op (see distributed-rollout-port.ts). The port is undefined on every
    // flag-off / non-distributed deployment, so those stay byte-identical legacy.
    const crewRolloutPort = getDistributedRolloutPort();
    if (crewRolloutPort && readDistributedCrewRolloutFlag(process.env) && runId && payload.issueId) {
      // The SHARED org rollout state (the crew flag above is the only independence lever), plus
      // the resolved Organization, via the same hook the heartbeat seam uses. Best-effort inside
      // the hook — a resolution error resolves to `off`, which stays legacy.
      const { state: crewRolloutState, organizationId: crewOrganizationId } =
        await crewRolloutPort.resolveRunRolloutState({ companyId: payload.companyId, sourceKind: "crew_run" });
      if (crewOrganizationId) {
        const crewWorkload = buildTaskRunBatchWorkload({
          adapterType: agent.adapterType,
          runtimeCommandSpec,
          adapterConfig: resolvedConfigRecord,
          // The crew persona is already folded into triggerPrompt by buildTriggerPrompt, so a
          // separate instructions bundle would double-deliver — instructions:null for slice 1.
          currentTaskMarkdown: triggerPrompt,
          instructions: null,
        });
        const crewGate = resolveCrewDistributedGate({
          rolloutState: crewRolloutState,
          crewRolloutEnabled: true,
          workload: crewWorkload,
        });
        if (crewGate.attempt) {
          const crewOwner = await crewRolloutPort.resolveExecutionOwner({
            source: { kind: "crew_run", crewRunId: runId },
            actor: { kind: "agent", id: agentId, companyId: payload.companyId },
            organizationId: crewOrganizationId,
            idempotencyKey: runId,
            rolloutState: crewRolloutState,
            input: crewGate.workload,
            stagedFiles: crewGate.stagedFiles,
          });
          if (shouldSuppressLegacyExecution(crewOwner) && crewOwner.owner === "distributed") {
            // The attempt is the terminal authority now: write the durable marker (status
            // untouched, still 'running') and SUPPRESS the legacy adapter by returning here. The
            // run's `finally` below still fires (this return is inside the main try) — it releases
            // the sandbox lease, unlinks cfgPath, and finalizes the transcript.
            await db
              .update(internalAgentRuns)
              .set(buildCrewHandoffMarkerPatch(crewOwner, new Date()))
              .where(and(eq(internalAgentRuns.id, runId), eq(internalAgentRuns.status, "running")));
            log.info(
              {
                runId,
                companyId: payload.companyId,
                agentId,
                jobId: crewOwner.jobId,
                attemptId: crewOwner.attemptId,
              },
              "[MIG-006] crew run handed off to distributed attempt; suppressing legacy adapter",
            );
            return {
              status: "succeeded",
              runId,
              distributedHandoff: { jobId: crewOwner.jobId, attemptId: crewOwner.attemptId },
            }; // CREW-SUPPRESSION-RETURN
          }
        }
      }
    }

    // ── MIG-006 shadow observation ────────────────────────────────────────
    // After the execution target is resolved (so the recorded routing is real) and
    // before `adapter.execute` (so the record is the dispatch's intent, not its
    // outcome). Skipped without a `runId`: a `crew_run` source is identified by its
    // run, and the FROZEN `.strict()` variant accepts no substitute.
    //
    // Inert unless this Organization's rollout is `shadow`; cannot throw; the probe is
    // deadline-bounded, so the worst case for a live dispatch is
    // SHADOW_PROBE_DEADLINE_MS and never a failure.
    if (runId) {
      await recordDistributedShadow({
        companyId: payload.companyId,
        source: { kind: "crew_run", crewRunId: runId },
        // The crew agent is the executor, and `crew_run` admits an agent requester.
        principal: { kind: "agent", id: agentId },
        routing: { executionTargetType: executionTarget.type },
        policy: {
          model: typeof providerId === "string" ? providerId : null,
          budgetPolicyId: null,
          effectiveCompletionPolicy: "not_applicable",
        },
        workloadCharacterization: {
          command: String(agent.adapterType ?? ""),
          args: [],
          maxRuntimeSeconds: 600,
          stdinArtifactId: null,
        },
      });
    }

    // Audit follow-up #27: capture the redacted+capped prompt snapshot now so
    // it is available to fold into the next existing run-row write (either the
    // completion update below or the catch-block failure update). Building it
    // here (pure string op) keeps the snapshot close to where triggerPrompt is
    // assembled. The actual DB write is folded into the existing .set({...})
    // calls — no separate round-trip, no extra db._sets entry in tests.
    // Best-effort: redactAndCapPrompt is a pure fn that won't throw, but guard
    // defensively so a future change there can never break the run.
    // NOTE: `promptSnapshot` is declared at function scope (above the try block)
    // so the catch block can also fold it into the failure update.
    try {
      promptSnapshot = redactAndCapPrompt(triggerPrompt);
    } catch (snapErr) {
      log.warn({ err: snapErr }, "aoa-runner: failed to build prompt snapshot (best-effort, ignored)");
    }

    // Phase 5 (Tasks 5.1/5.2): a thread/mention run lights the thread presence
    // pill — "<Agent> is <activity>…" — for the duration of the run. Gated on
    // payload.threadId (only conversational runs have a chat to show presence
    // in; a task-only/entry-only run skips this entirely). The humanized
    // activity is derived from the crew role key. Added BEFORE execute and
    // REMOVED in the `finally` (guaranteed even on throw). Best-effort — a
    // presence failure must never break the run (mirrors heartbeat.ts:2610-2615).
    //
    // Source gate: ONLY light presence for CONVERSATIONAL runs. A background
    // sweep (`sweep.*` — e.g. `sweep.chronicler`, `sweep.adjutant`) carries a
    // threadId but does NOT post to the thread (the Chronicler's summary sweep
    // never posts), so a typing-presence pill for it is phantom ("Chronicler is
    // typing…" with nothing ever arriving). Skip the add for sweeps; keep it for
    // `thread.controller` / `thread.participation` / `mention` / `agent.dispatch`.
    // presenceThreadId is set ONLY when we add, so the `finally` removal below
    // stays symmetric automatically — it never clears a presence we didn't set.
    const isBackgroundSweep = String(payload.source).startsWith("sweep.");
    if (bundleThreadId && !isBackgroundSweep) {
      presenceThreadId = bundleThreadId;
      presenceAgentName = agent.name;
      try {
        const activity = humanizedActivityForRole(agentRoleKey);
        threadWorkingAgents.add(bundleThreadId, agentId, agent.name, activity);
        broadcastThreadPresence(payload.companyId, bundleThreadId, Date.now());
      } catch (presenceErr) {
        log.warn({ err: presenceErr, threadId: bundleThreadId }, "aoa-runner: failed to set working presence (best-effort, ignored)");
      }
    }

    // T1.0: capture the adapter result so we can build AoaRunResult.
    // Adapters populate `usage`, `costUsd`, `exitCode`, `errorMessage` on
    // their AdapterExecutionResult — that data was previously discarded.
    //
    // T1: this WAS a single `fake ?? adapter.execute(...)` expression. It is now
    // split so the run transcript is opened ONLY on the branch that actually
    // spawns a CLI: a fake-crew turn short-circuits execute entirely, and
    // minting a transcript for it would leave a permanently empty file with a
    // DB pointer advertising content that never existed.
    let adapterResult = await maybeExecuteFakeCrewTurn({
      db,
      agent: { id: agent.id, name: agent.name },
      payload,
      // Controller-mode fake turns queue real create_scope_draft actions; the
      // seal (below) and direct-run commit then treat them exactly like a real
      // agent's tool calls — no fake-specific bookkeeping anywhere downstream.
      runId,
      discussionRunMode,
      threadFreshness,
    });

    if (!adapterResult) {
      // T1 (crew observability): open the run transcript HERE — immediately
      // before its only consumer — rather than at run-row insert. Everything
      // above this point can still bail benignly (the entry-claim race and the
      // task-checkout conflict both `return` early, and the dispatcher retries
      // pending entries every tick), and each of those bails would otherwise
      // mkdir + write a permanent 0-byte .ndjson and an extra UPDATE for a run
      // that never spawned anything. There is no retention sweeper for
      // run-logs. Opening it here makes a non-null logRef MEAN "the adapter
      // actually ran".
      //
      // Keyed on the run row's UUID — deliberately NO synthesized fallback id
      // (one would collide across runs of the same agent and truncate the
      // previous transcript, since begin() writes an empty file). No runId ⇒
      // nothing to attach a transcript to ⇒ skip logging for this run.
      // Entirely best-effort — a logging failure must never change a run outcome.
      if (runId) {
        const logRunId = runId;
        // Resolved inside the try on purpose: getRunLogStore() →
        // resolveAoaInstanceId() throws on a malformed AOA_INSTANCE_ID
        // (home-paths.ts:29-31), and an escape from here would fail the run +
        // terminalize the claimed entry + post a failure card — a logging
        // concern changing a run outcome, which is exactly what this block
        // promises never to do. Declared outside so the sink can reuse it.
        let runLogStore: ReturnType<typeof getRunLogStore> | null = null;
        try {
          runLogStore = getRunLogStore();
          runLogHandle = await runLogStore.begin({
            companyId: payload.companyId,
            agentId,
            runId: logRunId,
          });
        } catch (beginErr) {
          // Fatal to logging only: with no handle there is nothing to write to.
          log.warn({ err: beginErr, runId: logRunId }, "aoa-runner: failed to open run transcript (best-effort, ignored)");
          runLogHandle = null;
        }

        // `runLogStore` is non-null whenever `runLogHandle` is (begin() only
        // resolves after the store resolved); the second check is for the type
        // checker, not a real second condition.
        if (runLogHandle && runLogStore) {
          // Record the pointer so the transcript is FINDABLE from the run row
          // (mirrors heartbeat.ts:3709-3722 — `runLogStore.begin` + the
          // logStore/logRef update; moved by T5's -135-line extraction). A
          // failure here is NOT fatal to
          // logging: logRef is fully deterministic
          // (<companyId>/<agentId>/<runId>.ndjson — run-log-store.ts:97-100), so
          // an operator holding the run id can still find the file. The realistic
          // trigger is migration 0179 not being applied yet, which would fail
          // this UPDATE on every crew run — discarding the transcript for that
          // would silently degrade T1 back into the black box it exists to kill.
          try {
            await db.update(internalAgentRuns)
              .set({ logStore: runLogHandle.store, logRef: runLogHandle.logRef })
              .where(eq(internalAgentRuns.id, logRunId));
          } catch (pointerErr) {
            log.warn(
              { err: pointerErr, runId: logRunId, logRef: runLogHandle.logRef },
              "aoa-runner: failed to persist run transcript pointer — transcript is still being written and is findable at <companyId>/<agentId>/<runId>.ndjson",
            );
          }

          // Wired last, so the sequence reads open → record → wire.
          crewLogSink = createCrewRunLogSink({
            store: runLogStore,
            handle: runLogHandle,
            // Identity + this run's logger, so a broken store surfaces ONE warn
            // line traceable back to the run row rather than a silently empty
            // transcript (which reads exactly like "the agent produced nothing").
            run: { companyId: payload.companyId, agentId, runId: logRunId },
            logger: log,
          });
        }
      }

      // T5 (Decision #110 clause 7): give this run an execution workspace.
      // WITHOUT this, the adapter's cwd chain (`effectiveWorkspaceCwd ||
      // configuredCwd || process.cwd()` — claude-local execute.ts:188) fell all
      // the way through to process.cwd(): the AoA SERVER'S OWN REPOSITORY. Every
      // crew run then executed inside this codebase and loaded AoA's CLAUDE.md
      // as agent context. The helper mirrors heartbeat's resolution and NEVER
      // returns nothing — the per-agent home is the floor — so process.cwd() is
      // no longer reachable from the crew path.
      //
      // Placed INSIDE the `!adapterResult` branch, next to its only consumer: a
      // fake-crew turn short-circuits `adapter.execute` entirely, so resolving
      // for one would spend three DB reads and an mkdir on a cwd nothing ever
      // uses. Everything above this point can also still bail benignly (the
      // entry-claim race, the task-checkout conflict), and those bails must not
      // provision a workspace either.
      const crewWorkspace = await resolveCrewExecutionWorkspace(db, {
        agent: { id: agent.id, companyId: agent.companyId },
        issueId: typeof payload.issueId === "string" ? payload.issueId : null,
        threadId: bridgeThreadId ?? null,
        log,
      });
      if (crewWorkspace.warnings.length > 0) {
        log.info({ warnings: crewWorkspace.warnings }, "aoa-runner: execution workspace warnings");
        // Replay into the run transcript so the FOUNDER sees them, not just the
        // server log. Mirrors heartbeat.ts:3753-3755, which streams the same
        // warning class through the run's stderr. Without this a founder who
        // configured `isolated_workspace` and silently got the shared checkout
        // (see WHY THAT BRANCH in crew-workspace.ts) had no surface telling
        // them so. Best-effort: the sink swallows store failures internally,
        // and a run with no transcript simply skips it.
        if (crewLogSink) {
          for (const warning of crewWorkspace.warnings) {
            await crewLogSink.onLog("stderr", `[aoa] ${warning}\n`);
          }
        }
      }
      // T6 (P3): deliver the company/marketplace skills the founder attached to
      // this agent. `listRuntimeSkillEntries` had exactly ONE caller — the
      // heartbeat (heartbeat.ts:3869-3885) — and crew agents are barred from the
      // heartbeat, so an attached skill reached org agents and silently reached
      // no crew agent, while the Agent Skills tab said it did. This block mirrors
      // heartbeat's, including its two load-bearing details:
      //
      //   1. the `length > 0` guard. The claude-local adapter reads
      //        const dbSkills = (context.skills as …) ?? [];
      //        buildSkillsDir(dbSkills.length > 0 ? dbSkills : undefined);
      //      (claude-local/src/server/execute.ts:374-375) — writing `[]` instead
      //      of omitting the key must not change which branch runs, so the key is
      //      only ever written when there is something to write.
      //   2. warn-and-continue. Skill resolution touches the DB and, for
      //      local_path/catalog skills, the filesystem; broken skill storage must
      //      be VISIBLE rather than silently reading as "no skills attached" —
      //      which is exactly what an unattached agent produces (D17: Phase 1
      //      ships crew agents with no default skillKeys, so the empty result is
      //      the common case and cannot be allowed to double as the error case).
      //
      // Imported dynamically like the runner's other heavy collaborators
      // (issues.js, crew-context-bundle.js, crew-run-outcome.js):
      // company-skills.ts pulls in the adapter registry plus the agent, project
      // and secret services, and every consumer of this module would otherwise
      // load that graph.
      //
      // Placement matches T5's workspace resolution — inside `!adapterResult`,
      // next to its only consumer. A fake-crew turn never spawns a CLI, so
      // resolving skills for one costs DB + ancillary-file reads for a context
      // nothing reads.
      let agentSkills: RuntimeSkillEntry[] = [];
      try {
        const { companySkillService } = await import("../../company-skills.js");
        agentSkills = await companySkillService(db).listRuntimeSkillEntries(
          agent.companyId,
          agent.id,
        );
        log.info(
          { runId, skillCount: agentSkills.length, skillKeys: agentSkills.map((s) => s.key) },
          "aoa-runner: resolved company skills for crew run",
        );
      } catch (skillErr) {
        // Sanitized err — mirror heartbeat's team-coordination block
        // (heartbeat.ts:3923), NOT its skills block. A skill-resolution failure
        // is most plausibly a DB error, and a node-postgres error carries `query`
        // + `parameters` as own-enumerable props that pino's err serializer would
        // include — so log identity only, never the raw error.
        log.warn(
          {
            err: skillErr instanceof Error
              ? { name: skillErr.name, message: skillErr.message }
              : String(skillErr),
            companyId: agent.companyId,
            agentId: agent.id,
            runId,
          },
          "aoa-runner: failed to resolve company skills for crew run; continuing without skill injection",
        );
      }

      const executionContext: Record<string, unknown> = {
        aoaInstruction: instruction,
        payload,
        paperclipWorkspace: crewWorkspace.workspace,
        paperclipWorkspaces: crewWorkspace.workspaceHints,
      };
      // Guard, not a convenience: see (1) above — `skills: []` and an absent key
      // must stay indistinguishable to the adapter.
      if (agentSkills.length > 0) {
        executionContext.skills = agentSkills;
      }

      // U6.7 (S5): explicitly stage the agent's own resolved skill bundles
      // into the sandbox for provider-sandbox targets. `claude-local` (and
      // `cursor-local`) already satisfy this via their own adapter-internal
      // `context.skills` staging (execute.ts's buildSkillsDir + the remote
      // sync at :628) — this is REDUNDANT-but-harmless for those adapters
      // (same destination, same bytes, idempotent overwrite) and is the ONLY
      // delivery path for every other adapter (codex_local/opencode_local/
      // gemini_local/…), which never reads `context.skills` at all. Same
      // dual-check as U6.5's captureCrewOutputs / U6.6's preview emission:
      // BOTH the acquisition driver AND the resolved executionTarget must
      // agree it's a provider sandbox. Best-effort — stageAgentSkillsIntoSandbox
      // never throws on its own, but this call is still wrapped so a
      // defensive future change there can never fail an otherwise-successful
      // run.
      if (
        agentSkills.length > 0 &&
        acquired.sandbox?.environment.driver === "sandbox" &&
        executionTarget.type === "provider-sandbox"
      ) {
        try {
          const { stageAgentSkillsIntoSandbox } = await import("./sandbox-skill-staging.js");
          await stageAgentSkillsIntoSandbox({
            runId: runId ?? `aoa-${agentId}`,
            target: executionTarget,
            remoteCwd: executionTarget.remoteCwd,
            skills: agentSkills,
            onLog: crewLogSink ? crewLogSink.onLog : undefined,
          });
        } catch (skillStageErr) {
          log.warn(
            { err: skillStageErr, runId, agentId, companyId: agent.companyId },
            "aoa-runner: sandbox skill staging failed (best-effort, ignored)",
          );
        }
      }

      // U3: mint a per-run run-JWT so the crew CLI has a networked identity
      // (mirrors the org/heartbeat mint at heartbeat.ts:4276-4279). Gated on
      // the adapter flag + a real runId — a fake-crew turn never reaches this
      // branch, and codex/opencode/etc. that don't support the local-agent
      // JWT simply get `null` (behavior-safe: the token is unused until the
      // broker lands in later Wave-1 tasks).
      const crewAuthToken = adapter.supportsLocalAgentJwt && runId
        ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, runId)
        : null;
      if (adapter.supportsLocalAgentJwt && runId && !crewAuthToken) {
        log.warn(
          { companyId: agent.companyId, agentId: agent.id, runId, adapterType: agent.adapterType },
          "crew local agent jwt secret missing; running without injected AOA_API_KEY",
        );
      }

      adapterResult = await adapter.execute({
        runId: runId ?? `aoa-${agentId}`,
        agent,
        runtime: agent.runtimeConfig ?? {},
        config: configWithSandbox,
        context: executionContext,
        executionTarget, runtimeCommandSpec,
        mcpBridge: bridgeSpec,
        // Plan 2b Task 3: external connector specs on the carrier the
        // per-adapter writers (Tasks 4-6) read. Inert for claude_local, which
        // already receives them through the `--mcp-config` file written above.
        // The matching `AOA_MCP_*_TOKEN` secrets travel in `config.env`.
        mcpServers: extraMcpServers,
        humanQuestionCapabilities: adapter.humanQuestionCapabilities,
        // T2 (D9): CREW-ONLY ambient-config isolation. A crew run inherited the
        // operator's whole environment, so the host machine's ~/.claude
        // (SessionStart hooks, third-party skills, plugins) and the server's
        // ambient ANTHROPIC_API_KEY bled into the agent — observed live
        // hijacking a run. Set unconditionally HERE because this call site IS
        // the crew path; heartbeat (org) never sets it, so org behavior is
        // unchanged. Honoring the flag is per-adapter opt-in — claude_local
        // acts on it, the others currently ignore it.
        isolateAmbientConfig: true,
        // T1: stream the CLI transcript + one redacted adapter.invoke event into
        // the run log (was: two literal no-ops that discarded everything). Both
        // sink callbacks swallow store failures internally.
        onLog: crewLogSink ? crewLogSink.onLog : async () => {},
        onMeta: crewLogSink ? crewLogSink.onMeta : async () => {},
        authToken: crewAuthToken ?? undefined, onSpawn: () => {},
      });
    }

    // Silent-failure guard: a CLI agent can finish its run WITHOUT calling
    // submit_extracted_items (codex/opencode have no MCP-bridge wiring yet — see
    // buildMcpConfig/--mcp-config above, claude-only; the claude CLI submit
    // handshake can also hang). The adapter then returns "successfully" but the
    // claimed entry is never terminalized → stuck 'processing' forever (silent
    // loss). If we claimed an entry and it is STILL 'processing' after execute
    // returned, the agent did not submit — throw so the catch terminalizer below
    // marks both the entry and the run 'failed' with a clear error instead of
    // leaving it silently stuck.
    if (claimedEntryId) {
      const stillProcessing = await db
        .select({ status: discussionEntries.extractionStatus })
        .from(discussionEntries)
        .where(eq(discussionEntries.id, claimedEntryId))
        .then((r: Array<{ status: string }>) => r[0]?.status === "processing");
      if (stillProcessing) {
        throw new Error(
          "extraction agent run completed without submitting results",
        );
      }
    }

    // Spec B Task 5 — TASK SILENT-STUCK GUARD (autonomy-aware, T10 fix).
    // Symmetric to the entry guard above. A non-claude adapter (no MCP bridge) or
    // a hung claude run can exit "successfully" WITHOUT ever moving its task —
    // leaving the task we checked out stuck 'in_progress' forever. BUT: whether a
    // still-in_progress task is a FAILURE depends on the autonomy dial the agent
    // ran under.
    //
    //  • effectiveAutonomy >= 1 (Assist/Drive): the A4 dial-gate PERMITTED an
    //    advance (Assist → in_review, Drive → done). A task still in_progress
    //    means the agent was allowed to move it but didn't → a genuine stall:
    //    RELEASE it back to 'todo' (clear the lock) and THROW so the run is marked
    //    failed loudly. This is the guard's real purpose and is preserved.
    //  • effectiveAutonomy === 0 (Manual): the A4 dial-gate FORBIDS any advance
    //    (set-task-status-tool refuses in_review/done at Manual). A task still
    //    in_progress is therefore the EXPECTED terminal state, NOT a failure — the
    //    agent physically could not satisfy the guard. Do NOT release-to-todo and
    //    do NOT throw: the run SUCCEEDS and the agent's posted work stands. We
    //    clear ONLY the execution lock so the task is founder-actionable (Manual
    //    means the founder advances it) and not stuck-locked; status stays
    //    in_progress so nothing masquerades as review-ready, and Manual gates
    //    agent-initiated re-dispatch so this does not loop (Decision #109).
    //
    // effectiveAutonomy is `null` only for synthetic/legacy callers that never
    // pass a dial (the dispatcher ALWAYS resolves a number for real task runs) —
    // treat unknown as "fire the guard" so behaviour for those callers is
    // unchanged; the Manual exemption requires a POSITIVE `=== 0`.
    // Both writes are guarded on executionRunId=runId AND status='in_progress' so
    // a concurrent run that legitimately re-claimed the task is never clobbered.
    const effectiveAutonomy: number | null =
      typeof payload.effectiveAutonomy === "number" ? payload.effectiveAutonomy : null;
    if (payload.issueId && runId) {
      const { issueService } = await import("../../issues.js");
      const task = await issueService(db).getById(payload.issueId);
      if (task && task.status === "in_progress" && (task as { executionRunId?: string | null }).executionRunId === runId) {
        const parkedQuestion = await db.select({ id: workQuestions.id }).from(workQuestions).where(and(
          eq(workQuestions.companyId, payload.companyId),
          eq(workQuestions.issueId, payload.issueId),
          eq(workQuestions.askingAgentId, agentId),
          eq(workQuestions.originatingRunKind, "internal_agent"),
          eq(workQuestions.originatingRunId, runId),
          eq(workQuestions.status, "open"),
          eq(workQuestions.blocking, true),
        )).then((rows) => rows[0] ?? null);
        if (parkedQuestion) {
          log.info(
            { issueId: payload.issueId, questionId: parkedQuestion.id },
            "crew task run parked on an open human question",
          );
        } else if (effectiveAutonomy === 0) {
          // Manual: the agent was never permitted to advance → not a failure.
          // Clear the execution lock (atomic, guarded on runId + in_progress) so
          // the founder can advance the still-in_progress task without it being
          // stuck-locked. Zero rows (a concurrent re-claim) → leave it alone.
          // Clear the SAME four lock fields the dispatcher's canonical release
          // clears (dispatcher.ts:175-181) — executionAgentNameKey/executionLockedAt
          // are harmless once executionRunId is null (heartbeat reads them only
          // inside `if (activeExecutionRun)`), but keep the field-set aligned.
          // BEST-EFFORT: unlike the Assist+ branch this path deliberately does NOT
          // fail the run — the agent's posted work already stands and the lock-clear
          // is cleanup, not correctness. A transient DB error here must NOT
          // propagate to the outer catch and mark an otherwise-successful Manual run
          // failed (which would reintroduce the exact failure this fix removes).
          try {
            await db.update(issues)
              .set({ executionRunId: null, checkoutRunId: null, executionAgentNameKey: null, executionLockedAt: null, updatedAt: new Date() })
              .where(and(eq(issues.id, payload.issueId), eq(issues.executionRunId, runId), eq(issues.status, "in_progress")));
            log.info(
              { issueId: payload.issueId, effectiveAutonomy },
              "crew task run finished at Manual autonomy — task left in_progress for the founder, execution lock cleared (not a failure)",
            );
          } catch (lockClearErr) {
            log.warn(
              { err: lockClearErr, issueId: payload.issueId },
              "Manual-autonomy execution-lock clear failed (best-effort, ignored) — run stays successful",
            );
          }
        } else {
          const released = await db.update(issues)
            // Atomic status guard (Codex P2): a concurrent set_task_status between
            // the getById read and this write keeps executionRunId (only checkoutRunId
            // is cleared on leaving in_progress), so without status='in_progress' here
            // this could revert an in_review/done task back to todo.
            .set({ status: "todo", executionRunId: null, checkoutRunId: null, updatedAt: new Date() })
            .where(and(eq(issues.id, payload.issueId), eq(issues.executionRunId, runId), eq(issues.status, "in_progress")))
            .returning({ id: issues.id });
          // Only publish + throw if the guarded UPDATE actually released the row. A
          // ZERO-row result means set_task_status won the race and already moved the
          // task — the agent DID move it, so the run is NOT a failure (Codex P2).
          if (released.length > 0) {
            log.warn({ issueId: payload.issueId, effectiveAutonomy }, "crew task run finished with the task still in_progress (not advanced) — released task to todo");
            // Task 5.6: this is a CREW status-MOVE (in_progress → todo) that bypasses
            // issueService.update; publish issue.status_changed so the board reflects
            // the card dropping back to todo. Best-effort — must not mask the throw.
            try {
              publishIssueStatusChanged(payload.companyId, payload.issueId, "todo");
            } catch (publishErr) {
              log.warn({ err: publishErr, issueId: payload.issueId }, "issue.status_changed publish failed on silent-stuck release (best-effort, ignored)");
            }
            // The agent WAS permitted to advance (effectiveAutonomy >= 1) but the task
            // is still in_progress — a genuine stall. (The prior "no set_task_status
            // call" text was an assumption: the agent may have called it and hit a
            // different refusal.)
            throw new Error("crew task run finished with the task still in progress (not advanced)");
          }
        }
      }
    }

    // T1.0 + T1.1: determine status from the adapter's actual outcome.
    // buildAoaRunResultFromAdapter is the pure function that owns this logic
    // — exhaustively unit-tested in aoa-run-result.test.ts so we don't
    // duplicate the success/failure decision here AND in the catch path.
    const runResult = buildAoaRunResultFromAdapter(adapterResult, {
      mcpAttempted: !isClaudeFamily,                          // claude_local uses native --mcp-config, not the bridge → mcpAttempted:false EXEMPTS it from the transport-failure scan (no false-positives on claude output)
      markerSupported: agent.adapterType !== "gemini_local",  // gemini's error stream lacks a clean MCP marker
    });
    const adapterUsage = runResult.usage;
    const costCents = runResult.costCents;

    // Outbox SEAL (producer-gate, Decision #99 completion). On run SUCCESS, promote the actions
    // THIS run proposed (proposed → ready) by the run's durable key-set (recorded by
    // proposeThreadAction on internal_agent_runs.proposed_action_keys). Fires for ALL
    // controller_action_gate runs — direct AND controller — and BEFORE the run-status write
    // below, so a crash between seal and status leaves the rows `ready` (committable by the
    // relay), never a `completed` run with orphaned `proposed` rows. A run that did NOT succeed
    // never seals → its proposed rows stay un-committable and are reaped by the GC. The relay
    // then commits only sealed `ready` rows — the failed-run-leak (Codex P1) is structurally gone.
    if (
      runResult.status === "succeeded" &&
      runId &&
      bridgeThreadId &&
      discussionRunMode === "controller_action_gate"
    ) {
      // Best-effort: a transient seal read/write failure must NOT fail a run that already succeeded
      // (the agent did its work). On failure the rows stay `proposed`; the sweep GC then RE-SEALS this
      // completed run's key-set (gcOrphanedProposedActions Step 2, ~2-min cadence), so the actions are
      // recovered and committed — NOT lost. Far better than flipping a succeeded run to `failed`.
      // Mirrors the freshness-capture best-effort guard above.
      try {
        const { threadAgentActionService } = await import("../../thread-agent-actions.js");
        const [runRow] = await db
          .select({ keys: internalAgentRuns.proposedActionKeys })
          .from(internalAgentRuns)
          .where(eq(internalAgentRuns.id, runId))
          .limit(1);
        const keys = (runRow?.keys ?? []) as string[];
        if (keys.length > 0) {
          await threadAgentActionService(db).sealRunActions({
            companyId: payload.companyId,
            threadId: bridgeThreadId,
            idempotencyKeys: keys,
          });
        }
      } catch (sealErr) {
        log.warn(
          { err: sealErr, runId, threadId: bridgeThreadId },
          "aoa-runner: outbox seal failed — actions left unsealed; GC will re-seal this completed run on the next sweep",
        );
      }
    }

    // Thread controller runs commit action-gated side effects in
    // thread-orchestration.ts after re-checking the controller epoch. Direct
    // participation / mention / delegated thread runs have no outer controller,
    // so they must flush their own freshness-checked action queue here (the SEAL
    // above has already promoted this run's rows to `ready`).
    if (
      runResult.status === "succeeded" &&
      runId &&
      bridgeThreadId &&
      discussionRunMode === "controller_action_gate" &&
      payload.source !== "thread.controller"
    ) {
      const { threadAgentActionService } = await import("../../thread-agent-actions.js");
      const commitResult = await threadAgentActionService(db).commitThreadAgentActions({
        companyId: payload.companyId,
        threadId: bridgeThreadId,
        runId,
      });
      // A run whose work was ENTIRELY discarded (nothing committed, yet it
      // proposed actions that were suppressed/blocked/failed) is otherwise
      // invisible — the run row still reads "completed". Surface it at warn so a
      // fully-suppressed run (e.g. all actions stale, or snapshot_unavailable
      // from a freshness-capture failure above) is operator-visible, not silent.
      const fullySuppressed =
        commitResult.committed === 0 &&
        commitResult.suppressed + commitResult.blocked + commitResult.failed > 0;
      if (fullySuppressed) {
        log.warn(
          { runId, threadId: bridgeThreadId, commitResult },
          "aoa-runner: discussion run fully suppressed — no actions committed",
        );
      } else {
        log.info(
          { runId, threadId: bridgeThreadId, commitResult },
          "aoa-runner: committed direct discussion actions",
        );
      }

      // Re-arm the controller if this self-flush left retryable work (Codex round-8). Mirrors the
      // controller commit (thread-orchestration Step 5 reschedule), the committing reaper, and the GC
      // re-seal: EVERY commit path that leaves `failed`/lost-race rows must set pendingRun so the next
      // sweep re-drives them — otherwise a mixed direct flush (one action commits, another hits a
      // transient error or loses the CAS) strands retryable rows until an unrelated future human entry.
      // Only ever writes pendingRun=true (safe vs the claim discriminator, which keys on pendingRun===false).
      if (commitResult.failed > 0 || commitResult.lostRace > 0) {
        await db
          .update(threadOrchestrationState)
          .set({ pendingRun: true, updatedAt: new Date() })
          .where(eq(threadOrchestrationState.threadId, bridgeThreadId));
      }
    }

    if (runId) {
      const activeExecutionMs = Date.now() - startedAt;
      const terminalRows = await db.update(internalAgentRuns)
        .set({
          status: runResult.status === "failed" ? "failed" : "completed",
          errorMessage: runResult.errorMessage ?? null,
          tokenUsage: adapterUsage ? {
            inputTokens: adapterUsage.inputTokens,
            outputTokens: adapterUsage.outputTokens,
            ...(typeof adapterUsage.cachedInputTokens === "number"
              ? { cachedInputTokens: adapterUsage.cachedInputTokens }
              : {}),
          } : null,
          costCents,
          durationMs: activeExecutionMs,
          activeExecutionMs,
          humanQuestionWaitMs: inheritedHumanQuestionWaitMs,
          totalWallClockMs: activeExecutionMs + inheritedHumanQuestionWaitMs,
          completedAt: new Date(),
          // Audit #27: folded here (was a separate update pre-execute). This is
          // the natural home — one round-trip for the final run-row write.
          ...(promptSnapshot !== null ? { promptSnapshot } : {}),
        })
        .where(and(eq(internalAgentRuns.id, runId), eq(internalAgentRuns.status, "running")))
        .returning({ status: internalAgentRuns.status, errorMessage: internalAgentRuns.errorMessage });
      const persistedTerminal = terminalRows[0] ?? await db.select({
        status: internalAgentRuns.status,
        errorMessage: internalAgentRuns.errorMessage,
      }).from(internalAgentRuns).where(and(
        eq(internalAgentRuns.companyId, payload.companyId),
        eq(internalAgentRuns.id, runId),
      )).then((rows) => rows[0] ?? null);
      if (
        continuationIdempotencyKey
        && persistedTerminal
        && ["completed", "failed", "cancelled"].includes(persistedTerminal.status)
      ) {
        await finalizeInternalAgentWorkQuestionContinuation(db, {
          companyId: payload.companyId,
          runId,
          status: persistedTerminal.status as "completed" | "failed" | "cancelled",
          error: persistedTerminal.errorMessage,
        });
      }
    }

    // W3a: crew result loopback + run-summary comment on task outcome (SUCCESS
    // AND non-throwing FAILURE). relayCrewResult / postCrewFailureCard self-guard
    // on originKind==="crew_thread" + sourceDiscussionId (so a non-discussion
    // task is a no-op); the run-summary honors the autoRunSummary opt-out. Both
    // composed fns isolate each sub-step (a relay/card failure still lets the
    // summary post, and vice-versa). Safety here is PLACEMENT-gated, not
    // guard-gated: the benign early `return { status: "succeeded", runId }` paths
    // (entry-not-claimable, checkout-conflict) return BEFORE this point.
    //
    // W3a holistic finding: buildAoaRunResultFromAdapter can yield
    // status==="failed" WITHOUT throwing (adapter non-zero exit, non-null
    // errorMessage, or a detected transport failure). That path writes the
    // internal_agent_runs row 'failed' above then `return`s at the end of the try
    // — it NEVER enters the catch, so the catch's postCrewRunFailure would miss
    // it, leaving a silently-failed crew task with NO thread card + NO failure
    // summary. Route it to postCrewRunFailure HERE using `agent` (in scope in the
    // try; the catch uses the captured outcomeAgent* locals for THROWN failures).
    // No double-fire: a run either returns normally (this block) OR throws to the
    // catch — never both (the `return` below precedes the catch).
    //
    // resolveCrewOutcomeKind is the tested dispatch rule (succeeded→success,
    // failed→failure). Best-effort: the whole call is try/caught so a loopback
    // failure NEVER flips the run's already-decided status.
    if (payload.issueId && runId) {
      try {
        const { postCrewRunSuccess, postCrewRunFailure, resolveCrewOutcomeKind } =
          await import("./crew-run-outcome.js");
        if (resolveCrewOutcomeKind(runResult.status) === "success") {
          // U6.5 (S5): a crew run that targeted a provider sandbox gets its
          // in-sandbox working-dir diff captured to task_outputs (Decision
          // #67 — review-gated `detected_file` rows; artifacts stay
          // founder-gated, never auto-minted here). Mirrors heartbeat.ts's
          // U6.3 org-path gate: BOTH the acquisition driver AND the resolved
          // executionTarget must agree it's a provider sandbox. Best-effort —
          // captureCrewOutputs never throws on its own, but this call is
          // still wrapped so a defensive future change there can never flip
          // an already-succeeded run to failed or skip the loopback below.
          let detectedFiles: Array<{ path: string; type?: string }> = [];
          if (
            acquired.sandbox?.environment.driver === "sandbox" &&
            executionTarget.type === "provider-sandbox"
          ) {
            try {
              const { captureCrewOutputs } = await import("./crew-output-capture.js");
              detectedFiles = await captureCrewOutputs({
                db,
                companyId: payload.companyId,
                issueId: payload.issueId,
                agentId,
                runId,
                // AdapterExecutionTarget's "provider-sandbox" variant types
                // `runner` as the execute-only AdapterProviderSandboxRunner,
                // but the object actually built is
                // environment-run-orchestrator.ts's buildProviderRunner
                // output — a strict superset (writeFiles/readFiles/
                // resolveHost included whenever the underlying runtime
                // implements them). Cast mirrors heartbeat.ts's identical
                // U6.3 org-path cast.
                runner: executionTarget.runner as unknown as SandboxFileMovementRunner,
                remoteCwd: executionTarget.remoteCwd,
              });
            } catch (captureErr) {
              log.warn(
                { err: captureErr, issueId: payload.issueId, runId },
                "aoa-runner: crew output capture failed (best-effort, ignored)",
              );
            }
          }

          await postCrewRunSuccess(db, {
            companyId: payload.companyId,
            issueId: payload.issueId,
            agentName: agent.name,
            runtimeConfig: agent.runtimeConfig as Record<string, unknown> | null,
            startedAtMs: startedAt,
            nowMs: Date.now(),
            adapterUsage,
            costCents: costCents ?? null,
            runId,
            // Task 4: the delivering agent id — provenance for the run-result refs.
            agentId,
            detectedFiles,
          });
        } else {
          // runResult.status === "failed" WITHOUT a throw — the adapter reported
          // failure. Same loopback as the catch path (failure card + failure
          // run-summary), but `agent` is in scope here so use it directly.
          await postCrewRunFailure(db, {
            companyId: payload.companyId,
            issueId: payload.issueId,
            agentId,
            agentName: agent.name,
            runtimeConfig: agent.runtimeConfig as Record<string, unknown> | null,
            startedAtMs: startedAt,
            nowMs: Date.now(),
            errorMessage: runResult.errorMessage ?? "Run failed",
            runId,
          });
        }
      } catch (loopbackErr) {
        log.warn(
          { err: loopbackErr, issueId: payload.issueId },
          "W3a crew outcome loopback failed (non-fatal)",
        );
      }
    }

    // Plan 3 Task 6 + T1.1: real cost accounting from adapter result.
    // Previously hardcoded to 0 tokens / $0 even when the adapter reported
    // real usage. Now uses the values returned in AdapterExecutionResult.
    // Providers without per-run billing (CLI subscriptions) still report
    // zero — that's correct and intentional.
    await costService(db).createEvent(payload.companyId, {
      agentId,
      provider: adapterResult.provider ?? "anthropic",
      model: adapterResult.model ?? process.env.EXTRACTION_MODEL ?? "claude-sonnet-4-20250514",
      inputTokens: adapterUsage?.inputTokens ?? 0,
      outputTokens: adapterUsage?.outputTokens ?? 0,
      // Prefer the adapter's authoritative cost. Fall back to model-based
      // computation only when the adapter doesn't report cost (e.g. legacy
      // adapter returning UsageSummary without costUsd).
      costCents: costCents ?? computeCostCents(
        adapterResult.provider ?? "anthropic",
        adapterResult.model ?? process.env.EXTRACTION_MODEL ?? "claude-sonnet-4-20250514",
        adapterUsage?.inputTokens ?? 0,
        adapterUsage?.outputTokens ?? 0,
      ),
      occurredAt: new Date(),
    });

    return { ...runResult, runId };
  } catch (err) {
    log.error({ err }, "aoa run failed (isolated)");
    // U12: on cloud, resolveProviderCredential (above, before the U4 acquire —
    // see the reorder note at its call site) THROWS ProviderUnavailableError
    // when no company key is configured — it never returns host_login_fallback
    // on a shared host (provider-resolution.ts:450). Re-shape THAT throw into
    // founder-facing guidance, then thread the SAME message into every surface
    // that reads `errMessage` below (the internalAgentRuns failure row, the
    // work-question continuation finalize, the postCrewRunFailure card, and
    // the function's final return). Any non-provider-unavailable error is
    // untouched (mapper returns null -> surfaced === err).
    const mappedKeyError = mapCloudProviderKeyError(err, {
      tenantIsolationEnforced: tenantIsolationEnforced(),
      provider: outcomeProviderId ?? "provider",
      sink: "crew agent",
    });
    const surfaced = mappedKeyError ?? err;
    const errMessage = surfaced instanceof Error ? surfaced.message : String(surfaced);
    if (runId) {
      try {
        const activeExecutionMs = Date.now() - startedAt;
        await db.update(internalAgentRuns)
          .set({
            status: "failed",
            // False-green fix (U12): this used to re-materialize the message
            // from the RAW `err` (String((err as Error)?.message ?? err)),
            // bypassing the mapper above — the DB failure row carried the raw
            // resolver text even when postCrewRunFailure got the guidance.
            // Now both surfaces read the SAME mapped `errMessage`.
            errorMessage: errMessage,
            durationMs: activeExecutionMs,
            activeExecutionMs,
            humanQuestionWaitMs: inheritedHumanQuestionWaitMs,
            totalWallClockMs: activeExecutionMs + inheritedHumanQuestionWaitMs,
            completedAt: new Date(),
          })
          .where(and(eq(internalAgentRuns.id, runId), eq(internalAgentRuns.status, "running")));
        if (typeof payload.continuationIdempotencyKey === "string") {
          const persistedTerminal = await db.select({
            status: internalAgentRuns.status,
            errorMessage: internalAgentRuns.errorMessage,
          }).from(internalAgentRuns).where(and(
            eq(internalAgentRuns.companyId, payload.companyId),
            eq(internalAgentRuns.id, runId),
          )).then((rows) => rows[0] ?? null);
          if (persistedTerminal && ["completed", "failed", "cancelled"].includes(persistedTerminal.status)) {
            await finalizeInternalAgentWorkQuestionContinuation(db, {
              companyId: payload.companyId,
              runId,
              status: persistedTerminal.status as "completed" | "failed" | "cancelled",
              error: persistedTerminal.errorMessage ?? errMessage,
            });
          }
        }
      } catch { /* swallow */ }
    }

    // W3a: crew FAILURE loopback — post "… could not complete …" into the
    // originating thread (crew_thread-origin only) + a failure run-summary
    // comment on the task. postCrewRunFailure fetches the issue itself, gates
    // the card on originKind==="crew_thread", and isolates each sub-step. Uses
    // the CAPTURED function-scope locals (NOT `agent`, which is out of scope in
    // this catch — the P1 fix). Best-effort: never mask the original error.
    if (payload.issueId && runId) {
      try {
        const { postCrewRunFailure } = await import("./crew-run-outcome.js");
        await postCrewRunFailure(db, {
          companyId: payload.companyId,
          issueId: payload.issueId,
          agentId,
          agentName: outcomeAgentName ?? "Crew agent",
          runtimeConfig: outcomeAgentRuntimeConfig ?? null,
          startedAtMs: startedAt,
          nowMs: Date.now(),
          errorMessage: errMessage,
          runId,
        });
      } catch (loopbackErr) {
        log.warn(
          { err: loopbackErr, issueId: payload.issueId },
          "W3a crew failure loopback failed (non-fatal)",
        );
      }
    }

    // Release a TASK this run checked out if a mid-run failure terminated the run
    // BEFORE the success-path release guard (e.g. runtime secret resolution, a
    // shell-unsafe model, a context/bundle error — all of which throw between
    // issueService.checkout and adapter.execute). Without this the task stays
    // stuck 'in_progress' + locked forever, blocking retry/redispatch. Symmetric
    // to the discussion-entry terminalizer below and the silent-stuck release in
    // the success path: only clear the lock when the task is still 'in_progress'
    // AND still owned by THIS run (executionRunId===runId), so a concurrently
    // re-claimed task is never clobbered. Entirely best-effort — never escape the
    // run boundary (consistent with the catch's swallow style).
    if (payload.issueId && runId) {
      const releaseRunId = runId;
      try {
        const { issueService } = await import("../../issues.js");
        const task = await issueService(db).getById(payload.issueId);
        if (task && task.status === "in_progress" && (task as { executionRunId?: string | null }).executionRunId === releaseRunId) {
          const released = await db.update(issues)
            // Guard on status='in_progress' IN the UPDATE (not just the JS read):
            // the issue update path clears checkoutRunId but keeps executionRunId
            // when leaving in_progress, so a concurrent set_task_status between the
            // getById read and this write could otherwise revert an in_review/done
            // task back to todo (Codex P2). Atomic predicate prevents the clobber.
            .set({ status: "todo", executionRunId: null, checkoutRunId: null, updatedAt: new Date() })
            .where(and(eq(issues.id, payload.issueId), eq(issues.executionRunId, releaseRunId), eq(issues.status, "in_progress")))
            .returning({ id: issues.id });
          // Only log/publish when the guarded UPDATE actually released the row; a
          // zero-row result means a concurrent set_task_status already moved it.
          if (released.length > 0) {
            log.warn({ issueId: payload.issueId }, "crew run failed before execute — released checked-out task to todo");
            try {
              publishIssueStatusChanged(payload.companyId, payload.issueId, "todo");
            } catch (publishErr) {
              log.warn({ err: publishErr, issueId: payload.issueId }, "issue.status_changed publish failed on failed-run task release (best-effort, ignored)");
            }
          }
        }
      } catch (releaseErr) {
        log.warn({ err: releaseErr, issueId: payload.issueId }, "failed-run task release failed (best-effort, ignored)");
      }
    }
    // FX1/B1: a failed extraction RUN must terminalize the entry it claimed —
    // otherwise the entry is stuck 'processing' forever (silent permanent
    // loss). Mirrors extraction.ts:639-659's failure branch VERBATIM (status
    // 'failed' + sourceInfo.extractionError + the discussion.extraction.failed
    // LiveEvent; NO notification — extraction.ts writes none). Guarded on
    // extractionStatus='processing' AND extractionRunId=runId: extraction.ts
    // guards by id only because it owns the lifecycle linearly; the runner is
    // concurrent, so it must not clobber an entry a *different* run owns or
    // one already terminalized. Entirely best-effort — the catch must never
    // throw (consistent with the file's existing swallow style). `runId` is
    // necessarily a non-null string whenever claimedEntryId is set (the atomic
    // claim that set it also linked extractionRunId=runId); the `&& runId`
    // guard makes that invariant explicit (and narrows the type for eq()).
    if (claimedEntryId && runId) {
      const claimedRunId = runId;
      try {
        let discussionId: string | null = null;
        try {
          const drow = await db
            .select({ discussionId: discussionEntries.discussionId })
            .from(discussionEntries)
            .where(eq(discussionEntries.id, claimedEntryId));
          discussionId = drow[0]?.discussionId ?? null;
        } catch { /* swallow — terminalize on best-effort below */ }

        await db
          .update(discussionEntries)
          .set({
            extractionStatus: "failed",
            sourceInfo: sql`jsonb_set(COALESCE(${discussionEntries.sourceInfo}, '{}'::jsonb), '{extractionError}', ${JSON.stringify(errMessage)}::jsonb)`,
          })
          .where(
            and(
              eq(discussionEntries.id, claimedEntryId),
              eq(discussionEntries.extractionStatus, "processing"),
              eq(discussionEntries.extractionRunId, claimedRunId),
            ),
          )
          .catch((updateErr: unknown) => {
            log.error({ err: updateErr }, "Failed to update entry status after extraction failure");
          });

        if (discussionId) {
          publishLiveEvent({
            companyId: payload.companyId,
            type: "discussion.extraction.failed",
            payload: { discussionId, entryId: claimedEntryId, error: errMessage },
          });
        }
      } catch { /* terminalizer is best-effort; never escape the run boundary */ }
    }
    // T1.0: return a failed AoaRunResult so the dispatcher sets the wakeup
    // row to status='failed'. Before T1.0 we swallowed silently and the
    // dispatcher inferred 'succeeded' from the absence of a thrown
    // exception — masking every crew failure as a successful wakeup.
    return { status: "failed", errorMessage: errMessage, runId };
  } finally {
    // T1 (crew observability): seal the run transcript on EVERY exit — success,
    // adapter-reported failure, thrown failure, and the benign early returns
    // (entry not claimable / task checkout conflict) that return before the
    // success path. `finally` is the single site precisely because it is
    // unmissable and runs exactly once — no per-exit finalize calls to keep in
    // sync. Best-effort (mirrors the presence/unlink cleanups below) — a
    // finalize failure must never change a run outcome. The logged logRef is
    // the pointer an operator follows to read what the CLI actually did.
    if (runLogHandle) {
      try {
        const summary = await getRunLogStore().finalize(runLogHandle);
        log.info({ runId, logRef: runLogHandle.logRef, bytes: summary.bytes }, "aoa-runner: run transcript finalized");
      } catch (finalizeErr) {
        log.warn({ err: finalizeErr, runId }, "aoa-runner: failed to finalize run transcript (best-effort, ignored)");
      }
    }
    // FIX 1 (Wave 2 adversarial review, HIGH — cloud VM/lease leak): release the
    // crew sandbox lease acquired above (U4) on EVERY exit — success, adapter-
    // reported failure, AND thrown failure alike. `finally` GUARANTEES this runs
    // exactly once regardless of which path the run took, mirroring the
    // transcript-finalize / presence-clear / cfgPath-unlink cleanups around it.
    //
    // Keyed on the LEASE RECORD itself (environment + lease), NOT
    // heartbeatRunId: crew acquires with no heartbeatRunId (see the U4 acquire
    // call above — crew never sets `runIdentity`'s heartbeatRunId field), so the
    // org-only reaper (`environmentRuntimeService(db).releaseRunLeases(run.id)`,
    // which lists leases `WHERE heartbeat_run_id = <id>`) can never find or
    // reap a crew lease — this per-lease `releaseRunLease` is the ONLY release
    // path for crew. `acquiredContext?.sandbox` is null on desktop/
    // local_trusted (U4's S1 contract) and on every early-return that never
    // reached the acquire call, so this is correctly a no-op there.
    //
    // Best-effort: a release failure must NEVER fail the run or mask its
    // already-decided outcome (the run row was written success/failed above).
    if (acquiredContext?.sandbox) {
      try {
        await environmentRuntimeService(db).releaseRunLease({
          environment: acquiredContext.sandbox.environment,
          lease: acquiredContext.sandbox.lease,
          status: "released",
        });
      } catch (releaseErr) {
        log.warn({ err: releaseErr, runId }, "crew sandbox lease release failed (best-effort)");
      }
    }
    // Phase 5 (Tasks 5.1/5.2): clear this agent's thread working-presence (run
    // ended — success OR failure). GUARANTEED removal even on throw: the
    // presenceThreadId is only set after the add succeeded, so this never
    // touches a thread we didn't light. Best-effort (mirrors heartbeat.ts:4117).
    if (presenceThreadId) {
      try {
        threadWorkingAgents.remove(presenceThreadId, agentId);
        broadcastThreadPresence(payload.companyId, presenceThreadId, Date.now());
      } catch (presenceErr) {
        log.warn({ err: presenceErr, threadId: presenceThreadId, agentName: presenceAgentName }, "aoa-runner: failed to clear working presence (best-effort, ignored)");
      }
    }
    if (cfgPath && process.env.AOA_KEEP_MCP_CONFIG === "1") {
      log.info({ cfgPath }, "aoa-runner: preserving MCP config for diagnostics");
    } else if (cfgPath) {
      try {
        await unlink(cfgPath).catch(() => {
          /* best-effort cleanup; never break the run or its hard-error boundary */
        });
      } catch {
        /* unlink itself unavailable/threw synchronously — still must not escape */
      }
    }
  }
}
