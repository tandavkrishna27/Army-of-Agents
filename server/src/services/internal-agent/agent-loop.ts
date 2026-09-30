import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { internalAgentConfig, agents } from "@armyofagents/db";
import type { CommanderContextScope, ShowRef } from "@armyofagents/shared";
import type { ToolResult } from "./types.js";
import { conversationService, COMMANDER_TURN_HEARTBEAT_MS } from "./conversation.js";
import { cliModeService } from "./cli-mode.js";
import { agentInstructionsService } from "../agent-instructions.js";
import { contextAssemblyService } from "./context-assembly.js";
import { assembleAgentPersona } from "./commander-context.js";
import { ensureCommanderAgent } from "./aoa-agents/ensure-commander.js";
import { summarizeViaCli } from "./cli-summarizer.js";
import { tenantIsolationEnforced } from "../../config/deployment-mode.js";
import { notifyFounderOfCompactionFailure } from "./compaction-failure-notice.js";
import { buildCompactSkillList } from "./commander-skills.js";
import { companySkillService } from "../company-skills.js";
import {
  commanderMemoryRecallService,
  normalizeCommanderMemoryRecallPolicy,
} from "./memory-recall.js";
import {
  normalizeCommanderContextScope,
  type NormalizedCommanderContextScope,
} from "./context-scope.js";
import { collectChunkRefs, mergeOutputRefs } from "./output-refs.js";
import { humanToolSummary } from "./tool-summary.js";
import { assetService } from "../assets.js";
import {
  resolveRuntimeAttachments,
  formatRuntimeAttachmentBlock,
  createRuntimeAttachmentDeps,
} from "./runtime-attachments.js";
import type { Readable } from "node:stream";

/** Minimal storage surface needed to read attachment bytes for runtime delivery. */
export interface RuntimeAttachmentStorage {
  getObject: (companyId: string, objectKey: string) => Promise<{ stream: Readable }>;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface RunSummary {
  runId: string;
  toolsCalled: string[];
  durationMs: number;
  costCents: number;
  tokenUsage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  /** Model/provider actually used, when the adapter reports it (cost estimate input). */
  model?: string | null;
  provider?: string | null;
}

export type AgentStreamChunk =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id?: string; name: string; result: ToolResult; refs?: ShowRef[] }
  | { type: "action_confirmation"; toolName: string; params: unknown; runId: string }
  | { type: "options_prompt"; question: string; options: string[]; promptId: string }
  | { type: "error"; message: string }
  // Emitted when the turn did NOT execute a CLI run — an idempotent replay or an
  // in-progress defer (PR #291 round-8 #3). The route uses it to avoid recording
  // a phantom internal_agent_runs row (zero-token completed / spurious failed).
  // Not forwarded to the client SSE stream.
  | { type: "run_skipped" }
  | { type: "done"; summary: RunSummary };

export interface ChatInput {
  companyId: string;
  userId: string;
  userRole: string;
  // Threaded through to the MCP bridge so tools can be capability-gated.
  // Looked up by the chat route from internal_agent_config. (C13)
  enabledCapabilities: readonly string[];
  content: string;
  /**
   * System-level context (persona + skills + conversation history) assembled
   * by agent-loop. When set, cli-mode passes this via --system so the model
   * sees it as its system prompt rather than as user-message content.
   * This prevents the user's global ~/.claude/CLAUDE.md (e.g. gstack routing
   * rules) from being triggered by what would otherwise look like instruction
   * text inside a user message. Undefined = fallback (full assembled content
   * stuffed into -p — pre-Sprint-1 behaviour, kept for codex stdin path).
   */
  systemContext?: string;
  /**
   * The raw, unassembled user-typed message. When systemContext is present,
   * cli-mode passes this via -p (the user turn) instead of the full assembled
   * content string. Undefined = use content (backward compat / codex).
   */
  rawContent?: string;
  pageContext?: string;
  departmentContext?: string;
  conversationId?: string;
  contextScope?: CommanderContextScope | NormalizedCommanderContextScope | null;
  /**
   * The internal_agent_runs row id for this turn (created by the chat route).
   * Threaded to the MCP bridge as AOA_RUN_ID so emitted output refs carry
   * `provenance.runId`. Optional so non-route callers (proactive/event) compile.
   */
  runId?: string;
  /** Client idempotency key; a repeat replays the original turn (see chat()). */
  clientSubmissionId?: string;
  /** Composer attachment asset IDs; text-readable content is delivered to the turn. */
  attachmentAssetIds?: string[];
}

/**
 * Reconstruct the stream chunks for a persisted assistant reply so an idempotent
 * retry REPLAYS the original turn instead of re-running the CLI (PR #291 review).
 *
 * A completed turn may legitimately have EMPTY content when it was tool-calls
 * only — the persistence gate saves such rows (toolCalls present). Gating replay
 * on non-empty content would misclassify a completed tool-only turn as
 * "unfinished → re-run" and double-execute its tools. The existence of the
 * linked assistant row is therefore sufficient for replay; here we stream its
 * reasoning, tool calls/results, and content back as the original run would.
 */
function* replayPersistedReply(reply: {
  content?: string | null;
  reasoning?: string | null;
  toolCalls?: unknown;
  outputRefs?: unknown;
}): Generator<AgentStreamChunk> {
  if (reply.reasoning) {
    yield { type: "reasoning", delta: reply.reasoning };
  }
  const calls = Array.isArray(reply.toolCalls)
    ? (reply.toolCalls as Array<{ id?: string; name?: string; input?: unknown; success?: boolean; summary?: string; result?: unknown }>)
    : [];
  const refs = Array.isArray(reply.outputRefs) ? (reply.outputRefs as ShowRef[]) : [];
  let refsEmitted = false;
  for (const tc of calls) {
    const name = tc.name ?? "unknown";
    yield { type: "tool_call", id: tc.id ?? "", name, input: tc.input };
    const result: ToolResult = {
      success: tc.success ?? true,
      summary: typeof tc.summary === "string" ? tc.summary : "",
      data: tc.result,
    };
    const chunk: AgentStreamChunk = { type: "tool_result", name, result };
    if (tc.id) (chunk as { id?: string }).id = tc.id;
    // Re-attach the turn's merged output refs to the first tool_result so the
    // Commander viewer re-hydrates on replay (the row stores refs turn-level).
    if (!refsEmitted && refs.length > 0) {
      (chunk as { refs?: ShowRef[] }).refs = refs;
      refsEmitted = true;
    }
    yield chunk;
  }
  if (reply.content) {
    yield { type: "text", delta: reply.content };
  }
}

/**
 * A same-key request that could not acquire/keep the turn (lost the atomic claim
 * or the DB insert race) must NOT start a second CLI run. Defer to the winner:
 * replay its reply if one has already persisted, otherwise report in-progress
 * (PR #291 review). Shared by the fresh-path claim-loss and insert-loss branches.
 */
async function* replayWinnerOrSignalInProgress(
  convService: {
    getMessageByClientSubmissionId: (conversationId: string, key: string) => Promise<{ id: string } | null>;
    getAssistantReplyForUserMessage: (
      conversationId: string,
      userMessageId: string,
    ) => Promise<{ content?: string | null; reasoning?: string | null; toolCalls?: unknown; outputRefs?: unknown } | null>;
  },
  conversationId: string,
  clientSubmissionId: string | null,
): AsyncGenerator<AgentStreamChunk> {
  // No CLI run happens on this path (replay or in-progress defer) — tell the
  // route so it doesn't record a phantom run (round-8 #3).
  yield { type: "run_skipped" };
  if (clientSubmissionId) {
    const winner = await convService.getMessageByClientSubmissionId(conversationId, clientSubmissionId);
    if (winner) {
      const reply = await convService.getAssistantReplyForUserMessage(conversationId, winner.id);
      if (reply) {
        yield* replayPersistedReply(reply);
        return;
      }
    }
  }
  yield {
    type: "error",
    message: "This message is already being processed.",
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * Internal agent ("Commander") chat service.
 *
 * Sprint 2A (Decision #91) — API-mode execution was removed. Every turn
 * routes through {@link cliModeService} regardless of the legacy
 * `executionMode` column on `internal_agent_config`. The column stays for
 * rollback safety and historical data; the dispatch no longer reads it.
 *
 * Responsibilities kept in this file:
 * - Ensure an active conversation exists
 * - Persist the inbound user message (for history + audit)
 * - Fetch the company's Commander config and surface "not configured" errors
 * - Dispatch to cli-mode, forwarding its stream chunks to the caller
 * - Persist the assistant turn after a clean stream (MX-chatpersist):
 *   cli-mode streams the reply but never writes it back, so the
 *   conversation-owning layer accumulates the text chunks and appends one
 *   role:"assistant" message (skipped on empty / error-only / throw)
 *
 * Responsibilities moved to cli-mode.ts:
 * - Session management, CLI subprocess spawn + stdin piping
 * - Streaming output parsing
 *
 * Not yet implemented on the CLI path (tracked deferrals):
 * - Run record creation in `internal_agent_runs`
 * - Per-turn cost accounting / budget enforcement
 * - Tool action confirmations
 * These features existed only in the API-mode loop and will come back when
 * the team-under-Commander architecture lands; see Decision #91.
 *
 * Now wired on the CLI path:
 * - Conversation summarization — `convService.summarizeIfNeeded` is called
 *   after every clean turn via an injectable tool-less CLI summarizer
 *   (`summarizeViaCli`). Long conversations are compacted automatically;
 *   a failed compaction is swallowed so it never affects the delivered reply.
 */
export function agentLoopService(db: Db, storage?: RuntimeAttachmentStorage) {
  const convService = conversationService(db);
  const cliService = cliModeService(db);

  return {
    async *chat(params: ChatInput): AsyncGenerator<AgentStreamChunk> {
      // Durable cross-instance turn claim (PR #291 round-6/7, #1). Set once THIS
      // request wins the DB CAS; released to 'done' (reply persisted → retries
      // replay) or 'failed' (no reply → retries reclaim). The token gates the
      // lease so a reclaimed original owner cannot heartbeat or overwrite status.
      let claimedUserMessageId: string | null = null;
      let claimToken: string | null = null;
      // Release the durable claim exactly once, owner-token-guarded. Idempotent
      // (turnFinalized latch) so the success/error/finally paths cooperate.
      let turnFinalized = false;
      const finalizeClaim = async (status: "done" | "failed"): Promise<void> => {
        if (!claimedUserMessageId || !claimToken || turnFinalized) return;
        turnFinalized = true;
        try {
          await convService.finishTurn(claimedUserMessageId, claimToken, status);
        } catch {
          // Best-effort: a failed status update leaves the row 'running' until
          // the staleness window reclaims it — never affects the delivered reply.
        }
      };
      try {
        // 1. Get/create active conversation
        const conversation = params.conversationId
          ? await convService.getById(params.conversationId)
          : await convService.getOrCreateActive(params.companyId, params.userId);

        if (!conversation) {
          yield { type: "error", message: "Conversation not found." };
          return;
        }

        // Ownership guard: when a specific conversationId was requested, reject
        // if the fetched conversation belongs to a different user or company.
        // Treat as not-found to avoid leaking existence.
        if (
          params.conversationId &&
          (conversation.companyId !== params.companyId ||
            conversation.userId !== params.userId)
        ) {
          yield { type: "error", message: "Conversation not found." };
          return;
        }

        // 1b. Idempotent retry: if this exact Send was already recorded AND the
        // turn completed (a persisted assistant reply exists), replay the
        // original reply — WITHOUT persisting a duplicate user message or
        // starting a second CLI run. If the user turn persisted but no assistant
        // reply was recorded, the durable claim CAS below decides whether we may
        // re-run (we own it / it's reclaimable) or must defer to the owner. The
        // partial unique index on the message is the simultaneous-insert backstop.
        let reuseExistingUserRow = false;
        // The persisted user message this turn's reply must be linked to. Set on
        // both the fresh-insert and reuse-existing paths so the assistant row we
        // persist below carries an explicit back-link (PR #291 review, C2).
        let userMessageId: string | null = null;
        if (params.clientSubmissionId) {
          const priorUser = await convService.getMessageByClientSubmissionId(
            conversation.id,
            params.clientSubmissionId,
          );
          if (priorUser) {
            // C2: replay ONLY the reply explicitly linked to this user turn, not
            // the first assistant row after its timestamp — which could belong to
            // a later, unrelated turn if this send died before it replied.
            const reply = await convService.getAssistantReplyForUserMessage(
              conversation.id,
              priorUser.id,
            );
            // #2 (round-3): ANY linked assistant row is a completed reply — a
            // tool-only turn legitimately has empty content. Replay it (stream
            // its tool events/content) rather than re-running the CLI.
            if (reply) {
              // No CLI run — signal the route to skip recording a run (round-8 #3).
              yield { type: "run_skipped" };
              yield* replayPersistedReply(reply);
              return;
            }
            // No linked reply yet. Reuse the row; the durable CAS below is the
            // arbiter of whether we may run.
            reuseExistingUserRow = true;
            userMessageId = priorUser.id;
          }
        }

        // 2. Persist the user message (skipped when re-running a turn whose user
        // row already exists from a prior send).
        if (!reuseExistingUserRow) {
          const insertedUser = await convService.appendMessage(conversation.id, {
            role: "user",
            content: params.content,
            pageContext: params.pageContext ?? null,
            departmentContext: params.departmentContext ?? null,
            clientSubmissionId: params.clientSubmissionId ?? null,
          });
          // C3 (PR #291 review): a same-key request that lost the unique-index
          // insert race gets back an undefined insert — the winner owns the turn.
          // Defer to it (replay its reply if persisted, else in-progress); never
          // start a second run.
          if (!insertedUser) {
            yield* replayWinnerOrSignalInProgress(
              convService,
              conversation.id,
              params.clientSubmissionId ?? null,
            );
            return;
          }
          userMessageId = insertedUser.id;
        }

        // 2a. Durable, cross-instance turn claim (PR #291 round-6, #1). Both the
        // fresh and reuse paths converge here once the user row exists. ONE
        // atomic DB CAS decides ownership across ALL Node processes/workers — an
        // in-process Set could not (each process kept its own, so two retries on
        // different workers both "claimed" and both ran the turn + its tools).
        // The message unique index only dedups rows; it does not gate this
        // prior-row run path. A CAS loser defers to the owner (replay its reply,
        // or in-progress) and never starts a second CLI run.
        if (params.clientSubmissionId && userMessageId) {
          const token = await convService.claimTurn(userMessageId);
          if (!token) {
            yield* replayWinnerOrSignalInProgress(
              convService,
              conversation.id,
              params.clientSubmissionId,
            );
            return;
          }
          claimedUserMessageId = userMessageId;
          claimToken = token;
        }

        // 2b. Runtime attachment delivery (v1 — text only). Resolve company-owned
        // attachment content server-side and fold it into the message shown to the
        // model. Best-effort: an attachment failure must never fail the turn.
        let effectiveUserMessage = params.content;
        if (storage && params.attachmentAssetIds && params.attachmentAssetIds.length > 0) {
          try {
            const deps = createRuntimeAttachmentDeps(
              (assetId) => assetService(db).getById(assetId) as any,
              storage,
            );
            const resolved = await resolveRuntimeAttachments(
              deps,
              params.companyId,
              params.attachmentAssetIds,
            );
            const block = formatRuntimeAttachmentBlock(resolved);
            if (block) effectiveUserMessage = `${params.content}\n\n${block}`;
          } catch {
            // Leave the message untouched; the file stays referenced, not read.
          }
        }

        // 3. Load Commander config
        const config = await db
          .select()
          .from(internalAgentConfig)
          .where(eq(internalAgentConfig.companyId, params.companyId))
          .then((rows: any[]) => rows[0] ?? null);

        if (!config) {
          yield {
            type: "error",
            message: "Internal agent not configured. Go to Settings to set up.",
          };
          return;
        }

        // 4. Dispatch to CLI mode (the only execution path post-Sprint-2A).
        //
        // MX-chatpersist: agent-loop OWNS the conversation, so it is the
        // correct layer to persist the assistant turn. cli-mode streams the
        // reply to the caller but never writes it back (its accumulatedText
        // was dead). We forward every chunk UNCHANGED (SSE/streaming stays
        // byte-identical for claude AND codex — we only ADD post-stream
        // persistence here; cli-mode spawn/args/parsing is untouched) and
        // separately accumulate type:"text" deltas. After a CLEAN stream
        // completion, if there is non-empty assistant text, append one
        // role:"assistant" message. Nothing is persisted on the empty,
        // error-only, or mid-stream-throw paths (the catch below handles
        // throws; a partial accumulation is intentionally discarded so a
        // failed turn never leaves a truncated assistant message — the
        // persisted user turn + the streamed error are the durable record).

        // Assemble the per-turn prompt (Option B). cli-mode is UNCHANGED:
        // it sends params.content verbatim, so substituting content here
        // keeps the spawn shape byte-identical (content-only change).
        let assembledContent = params.content;
        let systemContext: string | undefined;
        let cliContextScope: NormalizedCommanderContextScope | null = null;
        try {
          const commanderAgentId = await ensureCommanderAgent(db, params.companyId);
          const agentRow = await db
            .select({ id: agents.id, companyId: agents.companyId, name: agents.name, adapterConfig: agents.adapterConfig })
            .from(agents)
            .where(eq(agents.id, commanderAgentId))
            .then((r: { id: string; companyId: string; name: string; adapterConfig: Record<string, unknown> | null }[]) => r[0] ?? null);
          const persona = agentRow
            ? await assembleAgentPersona({ agent: agentRow, service: agentInstructionsService() })
            : null;
          const skillsSection = await buildCompactSkillList({
            companyId: params.companyId,
            agentId: commanderAgentId,
            resolve: (cid, aid) => companySkillService(db).listCompactSkillEntries(cid, aid),
          });
          const history = await convService.getMessagesSince(
            conversation.id,
            (conversation as { summarizedUpToMessageId?: string | null }).summarizedUpToMessageId ?? null,
            50,
          );
          const historyText = history
            .map((m: { role: string; content?: string | null }) => (m.content ? `${m.role}: ${m.content}` : null))
            .filter(Boolean)
            .join("\n");
          const metadata =
            config.metadata && typeof config.metadata === "object" && !Array.isArray(config.metadata)
              ? (config.metadata as Record<string, unknown>)
              : {};
          const memoryRecallPolicy = normalizeCommanderMemoryRecallPolicy(metadata.memoryRecall);
          const contextScope = normalizeCommanderContextScope({
            contextScope: params.contextScope ?? null,
            departmentContext: params.departmentContext ?? null,
            conversationId: conversation.id,
          });
          cliContextScope = contextScope;
          const effectiveDepartmentContext = contextScope.departmentId;
          const recalledMemory = await commanderMemoryRecallService(db).recall({
            companyId: params.companyId,
            userId: params.userId,
            userRole: params.userRole,
            conversationId: conversation.id,
            agentId: commanderAgentId,
            latestUserMessage: params.content,
            policy: memoryRecallPolicy,
            scope: contextScope,
          });
          const assembled = await contextAssemblyService(db).assembleContext(params.companyId, {
            ...(persona ? { systemInstructions: persona } : {}),
            ...((conversation as { summarizedContext?: string | null }).summarizedContext
              ? { conversationSummary: (conversation as { summarizedContext?: string | null }).summarizedContext }
              : {}),
            ...(params.pageContext ? { pageContext: params.pageContext } : {}),
            ...(effectiveDepartmentContext ? { departmentContext: effectiveDepartmentContext } : {}),
            contextTokenBudget: (config as { contextTokenBudget?: number }).contextTokenBudget,
            relevanceQuery: params.content,
            memoryItems: recalledMemory.items.map((item) => ({
              title: item.title,
              content: item.content,
              layer: item.layer,
            })),
          });

          // Split assembled context from the user message (C-systemsplit).
          //
          // Problem: sending the entire assembled prompt (system instructions +
          // skills + history) as a single -p "user message" causes the global
          // ~/.claude/CLAUDE.md (which may carry gstack routing rules) to
          // interpret what looks like instruction text as user content and echo
          // skill-related text back to the user.
          //
          // Fix: pass system context via --system and raw user input via -p so
          // the model correctly interprets its Commander role from the system
          // slot, regardless of what the user's personal claude config contains.
          // For codex (stdin path) the full assembled content is still used
          // since codex does not read ~/.claude/CLAUDE.md the same way.
          systemContext =
            `${assembled.systemPrompt}` +
            (skillsSection ? `\n\n${skillsSection}` : "") +
            (historyText ? `\n\n## Conversation So Far\n${historyText}` : "");

          // Full assembled string kept for the codex stdin path (unchanged).
          assembledContent =
            systemContext +
            `\n\n## User Message\n${effectiveUserMessage}`;
        } catch {
          // Any assembly failure → send the raw message (never hard-fail).
          assembledContent = effectiveUserMessage;
          systemContext = undefined;
        }

        // For claude_cli: systemContext + rawContent enable the --system split.
        // For codex: content (full assembled) is used via stdin — unchanged.
        const cliParams = {
          ...params,
          // The caller may omit conversationId when starting a new chat. The
          // runtime provider session still needs the resolved persisted ID so
          // it cannot be shared with another Commander conversation.
          conversationId: conversation.id,
          content: assembledContent,
          contextScope: cliContextScope,
          ...(systemContext !== undefined
            ? { systemContext, rawContent: effectiveUserMessage }
            : {}),
        };

        const effectiveConfig = {
          ...config,
          cliTool: (config as { cliTool?: string | null }).cliTool ?? "claude_cli",
        };

        let accumulatedAssistant = "";
        const REASONING_CAP = 16000;
        let accumulatedReasoning = "";
        const turnRefs: ShowRef[] = [];
        const turnToolCalls: Array<{ id?: string; name: string; input?: unknown; success?: boolean; summary?: string; result?: unknown }> = [];
        // Lease heartbeat (round-7 #1): refresh turn_claimed_at during a long
        // stream so an actively-progressing turn never ages into the staleness
        // window and gets reclaimed + double-run. Throttled to the heartbeat
        // interval and best-effort — a failed bump never affects the reply.
        let lastHeartbeatMs = Date.now();
        for await (const chunk of cliService.chat(cliParams, effectiveConfig)) {
          if (claimedUserMessageId && claimToken && Date.now() - lastHeartbeatMs >= COMMANDER_TURN_HEARTBEAT_MS) {
            lastHeartbeatMs = Date.now();
            try {
              await convService.heartbeatTurn(claimedUserMessageId, claimToken);
            } catch {
              // Best-effort; the staleness window is the backstop.
            }
          }
          if (chunk.type === "text") accumulatedAssistant += chunk.delta;
          if (chunk.type === "reasoning") {
            // F5: cap accumulation exactly — once at/over cap, stop appending and
            // skip forwarding to avoid holding a huge string in memory.
            if (accumulatedReasoning.length >= REASONING_CAP) {
              // Already at/over cap — skip yielding and accumulating.
              continue;
            }
            // Slice to cap so a large delta cannot overshoot by one chunk.
            accumulatedReasoning = (accumulatedReasoning + chunk.delta).slice(0, REASONING_CAP);
          }
          if (chunk.type === "tool_call") {
            turnToolCalls.push({ id: chunk.id, name: chunk.name, input: chunk.input });
          }
          if (chunk.type === "tool_result") {
            const enriched = {
              success: chunk.result?.success ?? true,
              summary: humanToolSummary(chunk.name, chunk.result?.summary ?? chunk.result?.data),
              result: chunk.result?.data ?? chunk.result,
            };
            const match = turnToolCalls.find((c) => (chunk.id && c.id === chunk.id) || (c.name === chunk.name && c.success === undefined));
            if (match) Object.assign(match, enriched);
            else turnToolCalls.push({ id: chunk.id, name: chunk.name, ...enriched });
          }
          collectChunkRefs(turnRefs, chunk);
          yield chunk;
        }

        const turnProducedReply =
          Boolean(accumulatedAssistant.trim()) || turnToolCalls.length > 0 || Boolean(accumulatedReasoning.trim());
        if (turnProducedReply) {
          // Assistant replies have no originating page / department-persona
          // context (those describe where the USER was), so we omit them —
          // appendMessage defaults the optional fields to null, matching the
          // internal_agent_messages schema. role:"assistant" is a valid role
          // per the schema's role enum.
          const outputRefs = turnRefs.length > 0 ? mergeOutputRefs([], turnRefs) : undefined;
          await convService.appendMessage(conversation.id, {
            role: "assistant",
            content: accumulatedAssistant,
            // C2 (PR #291 review): back-link the reply to the user turn that
            // produced it so an idempotent retry replays THIS reply, never a
            // later turn's. Null only if assembly ran without a user row.
            ...(userMessageId ? { replyToUserMessageId: userMessageId } : {}),
            ...(outputRefs ? { outputRefs } : {}),
            ...(turnToolCalls.length > 0 ? { toolCalls: turnToolCalls } : {}),
            // F5: accumulatedReasoning is already capped during accumulation — no slice needed.
            ...(accumulatedReasoning.trim() ? { reasoning: accumulatedReasoning } : {}),
          });
        }

        // Release the durable claim (PR #291 round-6, #1). 'done' when a reply
        // persisted (retries replay it); 'failed' when the turn produced nothing
        // — error-only, empty, or config failure — so a retry can reclaim + re-
        // run (round-2 Retry-after-error recovery). Persist the reply BEFORE
        // marking done so a retry arriving in that window replays, never re-runs.
        await finalizeClaim(turnProducedReply ? "done" : "failed");

        // Post-turn compaction (graceful: never blocks/raises into the turn).
        // U13.6: on AoA Cloud, a compaction throw previously degraded SILENTLY
        // (R3) — the conversation just kept growing unbounded with no
        // founder-visible signal. Compaction stays best-effort (a failure
        // must NEVER fail the turn or the delivered reply); this only ADDS a
        // founder notification on the cloud path before falling through to
        // the existing "skip compaction this turn" behavior. Desktop failures
        // are left unnotified (unchanged) — see compaction-failure-notice.ts.
        try {
          await convService.summarizeIfNeeded(conversation.id, (transcript) =>
            summarizeViaCli({
              cliTool: (config as { cliTool?: string }).cliTool ?? "claude_cli",
              cheapModel: (config as { cheapModel?: string | null }).cheapModel ?? null,
              transcript,
              db,
              companyId: params.companyId,
            }),
          );
        } catch (compactionErr) {
          if (tenantIsolationEnforced()) {
            await notifyFounderOfCompactionFailure(
              db,
              params.companyId,
              compactionErr,
              conversation.id,
            ).catch(() => {
              // best-effort — never let the notification path affect the turn
            });
          }
          // swallow — a failed compaction must never affect the delivered reply
        }
      } catch (err: any) {
        // Mark the durable claim 'failed' so a retry can reclaim + re-run the
        // turn (#1). Best-effort — never let it mask the original error.
        await finalizeClaim("failed");
        yield {
          type: "error",
          message: err?.message ?? "An unexpected error occurred.",
        };
        yield {
          type: "done",
          summary: {
            runId: "",
            toolsCalled: [],
            durationMs: 0,
            costCents: 0,
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
          },
        };
      } finally {
        // Round-11 #3: release the claim on ANY early return that didn't already
        // finalize it — e.g. the config-absent path yields an error and returns
        // WITHOUT a finishTurn, which would otherwise leave the row 'running'
        // until the 35-min stale window and block the user's retries. Idempotent
        // via the turnFinalized latch (no-op after done/failed).
        await finalizeClaim("failed");
      }
    },
  };
}
