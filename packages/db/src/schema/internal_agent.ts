import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  index,
  uniqueIndex,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";

// ── Table 5: internal_agent_config ──────────────────────────────────────────

export const internalAgentConfig = pgTable(
  "internal_agent_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .unique()
      .references(() => companies.id, { onDelete: "cascade" }),

    // Execution mode — Sprint 2A (Decision #91) made CLI the only dispatched
    // path. 'api' is still a valid historical value in existing rows and the
    // column stays for rollback safety, but agent-loop.ts no longer branches
    // on it — every Commander turn goes through cli-mode.ts.
    executionMode: text("execution_mode").notNull().default("cli"), // 'api' | 'cli'

    // Crew provider (provider-switching). READ by resolveCrewAdapterForCompany to
    // pick the crew CLI adapter (claude_local/codex_local/gemini_local/opencode_local).
    // This is the live source of truth for the AoA crew — NOT dormant.
    provider: text("provider").default("anthropic"), // 'anthropic'|'openai'|'google'|'opencode'
    model: text("model").default("claude-sonnet-4-6"), // Commander cli-mode model (codex --model)
    // Crew model override (provider-switching reconnect). When set + valid for the
    // company's `provider`, resolveCrewAdapterFor uses it instead of the per-provider
    // default. Validated per provider (codex-model.ts) — an invalid value falls back
    // to the default, never breaks a run.
    crewModel: text("crew_model"),
    // Cheap-model fallback (D4): if set and monthly spend ≥ 80% of budget,
    // heartbeat swaps adapter model to this value for the rest of the month.
    cheapModel: text("cheap_model"),

    // CLI mode settings
    cliTool: text("cli_tool"), // 'claude_cli' | 'codex' | 'opencode' | null

    // ── Autonomy — TWO INDEPENDENT DIALS (D18 split, Decision #109 addendum) ──
    //
    // Before the split ONE column drove Commander, crew task runs, org-agent
    // heartbeat runs AND Adjutant/thread scope-compilation. D18: "one dial must
    // not secretly drive two systems." These are now separate columns; moving
    // one must never move the other.

    // COMMANDER ONLY. 0-2 (Manual/Assist/Drive). Commander's own chat loop does
    // not consult this value at runtime today — Commander's tool gating is the
    // runtime-approval policy (`mcp-bridge.ts` → `runtime-approvals.ts`), which
    // is unconditional for `actorType:"commander"`. The column is retained as
    // the Commander-side dial (its declared home per D18) and is carried by
    // company-portability bundles; it is NOT read by crew, heartbeat, or any
    // thread flow. Do not re-point agent-execution code at this column.
    autonomyLevel: integer("autonomy_level").notNull().default(1),

    // AGENT WORK (named `crew_*` per D18). 0-2 (Manual/Assist/Drive). This is
    // the dial every agent-execution path reads:
    //   - crew task runs + crew wakeups (`dispatcher.ts`)
    //   - org-agent heartbeat runs (`heartbeat.ts`)
    //   - Adjutant scope-compilation + thread participation + proactive wakes
    //     (`controller-adjutant-runner.ts`, `thread-participation-runner.ts`,
    //      `thread-events.ts`, `thread-agent-actions.ts`, `threads.ts`)
    // `discussions.autonomy_level` remains the finer-grained PER-THREAD
    // override; this column is the company-level fallback for those flows.
    //
    // Default is Assist (1): a fresh company's crew must be able to hand a
    // finished task to review (in_review) out of the box. At Manual (0) the A4
    // dial-gate forbids ANY advance, so every crew run left its task stuck
    // in_progress and the completion guard failed it (Decision #109). Assist
    // advances only to in_review — completing to `done` still requires Drive
    // (2). A schema-default change affects NEW rows only; the D18 split
    // migration backfills existing rows from `autonomy_level` so no live
    // company's behaviour moved.
    crewAutonomyLevel: integer("crew_autonomy_level").notNull().default(1),

    // Capabilities
    enabledCapabilities: jsonb("enabled_capabilities").notNull().default([
      "discussion_processing",
      "proactive_suggestions",
      "organizational_queries",
      "system_actions",
      "context_briefing",
      "memory_management",
      "conflict_detection",
      "budget_awareness",
      "workflow_coaching",
      "workflow_discovery",
      "cross_department_coordination",
      "department_personas",
    ]),

    // Notifications
    notificationPreference: text("notification_preference")
      .notNull()
      .default("realtime"), // 'silent' | 'digest' | 'realtime'

    // Context
    contextTokenBudget: integer("context_token_budget").notNull().default(8000),

    // Budget (cents — DA-25)
    budgetMonthlyCents: integer("budget_monthly_cents"), // null = unlimited
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),

    // Proactive scheduling
    proactiveIntervalMinutes: integer("proactive_interval_minutes")
      .notNull()
      .default(240), // 4 hours
    lastProactiveRunAt: timestamp("last_proactive_run_at", {
      withTimezone: true,
    }),

    // Metadata
    metadata: jsonb("metadata").default({}),

    // Per-tool permission overrides for Commander. Keys are tool names.
    // Null = use system defaults (enabled=true, requireConfirmation=false, minimumRole=team_member).
    commanderToolPermissions: jsonb("commander_tool_permissions"),

    // Runtime approvals govern Commander tool execution. Vendor bypass only
    // controls whether AoA forwards approvals to the underlying CLI.
    runtimeApprovalsEnabled: boolean("runtime_approvals_enabled")
      .notNull()
      .default(true),
    runtimeAllowAlwaysEnabled: boolean("runtime_allow_always_enabled")
      .notNull()
      .default(true),
    vendorCliBypassEnabled: boolean("vendor_cli_bypass_enabled")
      .notNull()
      .default(true),

    // Plan 3 Task 8: company-level crew kill-switch.
    // When true, no crew roles fire for ANY thread in this company.
    // Thread-level pause is in discussions.crewPaused.
    crewPaused: boolean("crew_paused").notNull().default(false),

    // Task 0.2 (Inbound Dirty-Data Routing): per-company routing dial.
    // Values: 'off' | 'suggest' | 'auto_attach' | 'full_auto'
    // 'off'         = inbound items queue as pending_route but router never fires.
    // 'suggest'     = router scores + suggests; founder approves attachment.
    // 'auto_attach' = router auto-attaches confident matches; suggests branch/new.
    // 'full_auto'   = router auto-attaches and auto-creates when confident.
    // Default 'off' — teams opt-in as they build trust (mirrors D5 teaching
    // default philosophy).
    inboundRoutingLevel: text("inbound_routing_level").notNull().default("off"),

    // Viewer Upgrade Phase 5: per-company default for how much of the viewer
    // agents may drive. 'manual' | 'own_output' | 'full' (see
    // packages/shared/src/viewer-control.ts). Per-user overrides live in
    // viewer_preferences (null there = inherit this company default).
    viewerControlLevel: text("viewer_control_level").notNull().default("own_output"),

    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: uniqueIndex("internal_agent_config_company_uq").on(
      table.companyId,
    ),
  }),
);

// ── Table 6: internal_agent_conversations ───────────────────────────────────

export const internalAgentConversations = pgTable(
  "internal_agent_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),

    status: text("status").notNull().default("active"), // 'active' | 'archived'

    // Summarized context from older messages
    summarizedContext: text("summarized_context"), // compressed history for token management
    summarizedUpToMessageId: uuid("summarized_up_to_message_id"), // last message included in summary

    messageCount: integer("message_count").notNull().default(0), // denormalized

    // Multi-chat (Sprint 3): user-visible conversation title, archive timestamp,
    // and founder-visible sharing flag (RBAC option C).
    title: text("title"),            // null = auto-title from first message
    archivedAt: timestamp("archived_at", { withTimezone: true }), // null = active
    pinned: boolean("pinned").notNull().default(false),
    sharedWithCompany: boolean("shared_with_company").notNull().default(false),

    // Manual drag-and-drop ordering of the session list. null = not manually
    // ordered (the list falls back to recency/date groups). Once the user drags,
    // every visible conversation gets an explicit index here and the UI switches
    // to a flat user-arranged list. (Batch 2: Commander session reorder.)
    sortOrder: integer("sort_order"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("ia_conversations_company_user_idx").on(
      table.companyId,
      table.userId,
    ),
    activeIdx: index("ia_conversations_active_idx").on(
      table.companyId,
      table.userId,
      table.status,
    ),
  }),
);

// ── Table 7: internal_agent_messages ────────────────────────────────────────

export const internalAgentMessages = pgTable(
  "internal_agent_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => internalAgentConversations.id, { onDelete: "cascade" }),

    role: text("role").notNull(), // 'user' | 'assistant' | 'system' | 'tool_call' | 'tool_result'
    content: text("content"), // nullable for tool_call messages where content is in toolCalls

    // Tool interaction
    toolCalls: jsonb("tool_calls"), // array of { id, name, input }
    toolResults: jsonb("tool_results"), // array of { toolCallId, result }
    outputRefs: jsonb("output_refs"), // CommanderOutputRef[] — distilled viewer refs (design 2026-06-11 §3d)
    reasoning: text("reasoning"), // assistant's extended-thinking text (accumulated, capped at 16000 — not redacted; model output, rendered escaped like content)

    // Context at time of message
    pageContext: text("page_context"), // which page the user was on
    departmentContext: uuid("department_context"), // if agent was in department persona mode

    // Metadata
    tokenCount: integer("token_count"), // estimated tokens this message consumed
    runId: uuid("run_id").references(() => internalAgentRuns.id, {
      onDelete: "set null",
    }),

    // Client-generated idempotency key for a user Send. A retried Send replays
    // the original turn instead of persisting a duplicate user message or
    // starting a second CLI run. Nullable: assistant/system/tool rows carry none.
    clientSubmissionId: text("client_submission_id"),

    // Explicit link from an assistant reply to the user message that triggered
    // it (PR #291 review). Replay must return THIS turn's reply, not simply the
    // first assistant row created after the user's timestamp — which could be a
    // later, unrelated turn's reply if the original send died before replying.
    // Nullable: user/system/tool rows and legacy assistant rows carry none.
    replyToUserMessageId: uuid("reply_to_user_message_id"),

    // Durable cross-instance turn claim (PR #291 round-6 review). Meaningful on
    // USER rows carrying a clientSubmissionId: the CLI run is claimed via an
    // atomic CAS (turn_status NULL/'failed'/stale-'running' → 'running') so that
    // two retries handled by DIFFERENT Node processes cannot both execute the
    // turn — the in-process Set could not guarantee that across workers, and the
    // message unique index only dedups rows, not the prior-row run path.
    //   NULL → never claimed (fresh row) | 'running' → in flight (see
    //   turn_claimed_at for staleness) | 'done' → completed (reply persisted) |
    //   'failed' → ended without a reply (reclaimable by a retry).
    turnStatus: text("turn_status"),
    turnClaimedAt: timestamp("turn_claimed_at", { withTimezone: true }),
    // Owner token for the durable claim lease (PR #291 round-7 #1). claimTurn
    // mints a fresh token on each win; heartbeatTurn/finishTurn only act when the
    // token still matches — so a request whose stale claim was reclaimed by a
    // duplicate can neither keep bumping the lease nor overwrite the new owner's
    // status. turn_claimed_at is now a LEASE-FRESHNESS signal, bumped by the
    // owner's heartbeat during a long turn so a live turn never ages into the
    // staleness window.
    turnClaimToken: uuid("turn_claim_token"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    conversationIdx: index("ia_messages_conversation_idx").on(
      table.conversationId,
    ),
    // Enforce one message per (conversation, submission key). Partial: null exempt.
    clientSubmissionUq: uniqueIndex("ia_messages_client_submission_uq")
      .on(table.conversationId, table.clientSubmissionId)
      .where(sql`client_submission_id IS NOT NULL`),
    conversationTimeIdx: index("ia_messages_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    runIdx: index("ia_messages_run_idx").on(table.runId),
    // Replay lookup: the assistant reply linked to a given user turn.
    replyToUserIdx: index("ia_messages_reply_to_user_idx").on(
      table.replyToUserMessageId,
    ),
  }),
);

// ── Table 8: internal_agent_runs ────────────────────────────────────────────

export const internalAgentRuns = pgTable(
  "internal_agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),

    // Trigger classification (DA-27)
    triggerType: text("trigger_type").notNull(), // 'conversation' | 'proactive' | 'event' | 'sub_agent'
    triggerSource: text("trigger_source").notNull(), // extensible: 'user_message', 'discussion_entry', etc.

    // Execution state
    status: text("status").notNull().default("running"), // 'running' | 'completed' | 'failed' | 'cancelled'
    errorMessage: text("error_message"), // populated on failure

    // What the agent did
    toolsCalled: jsonb("tools_called").default([]), // array of { name, input, output, durationMs, success }
    summary: text("summary"), // human-readable summary of what happened

    // Outbox SEAL key-set (Decision #99 completion, Mechanism B'). The idempotency keys of the
    // thread_agent_actions this run PROPOSED this turn. Appended by proposeThreadAction (which
    // runs in the bridge subprocess) and read by the runner / controller on run SUCCESS to seal
    // those actions proposed→ready (the producer-success gate). Durable here because the bridge
    // and the seal site are different processes — an in-memory key-set cannot cross. A run that
    // fails/crashes never seals → its proposed rows are never drained (the GC reaps them).
    proposedActionKeys: jsonb("proposed_action_keys")
      .$type<string[]>()
      .notNull()
      .default([]),

    // Cost tracking (DA-25: cents, not USD)
    tokenUsage: jsonb("token_usage"), // { inputTokens, outputTokens, cachedInputTokens }
    costCents: integer("cost_cents"),
    durationMs: integer("duration_ms"),
    activeExecutionMs: bigint("active_execution_ms", { mode: "number" }).notNull().default(0),
    humanQuestionWaitMs: bigint("human_question_wait_ms", { mode: "number" }).notNull().default(0),
    runtimePermissionWaitMs: bigint("runtime_permission_wait_ms", { mode: "number" }).notNull().default(0),
    totalWallClockMs: bigint("total_wall_clock_ms", { mode: "number" }).notNull().default(0),

    // Context
    departmentContext: uuid("department_context").references(
      () => projects.id,
      { onDelete: "set null" },
    ),
    userId: text("user_id"), // who triggered (null for proactive/event)
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    // Plain uuid, not a FK — mutual reference with messages.runId would create
    // insert ordering issues (message references run, run references message)
    conversationMessageId: uuid("conversation_message_id"),

    // Related entity
    relatedEntityType: text("related_entity_type"), // 'discussion' | 'task' | 'agent' | 'goal' | 'memory' | null
    relatedEntityId: uuid("related_entity_id"),
    continuationIdempotencyKey: text("continuation_idempotency_key"),

    // LLM info
    provider: text("provider"), // 'anthropic' | 'openai' | 'google'
    model: text("model"), // specific model used

    // Audit: redacted+capped snapshot of the assembled system prompt delivered
    // to the agent CLI. Populated best-effort — never fails the run.
    // Capped at ~16 000 chars; secrets stripped via redactAndCapPrompt().
    promptSnapshot: text("prompt_snapshot"),

    // T1 (crew observability): pointer to this run's NDJSON transcript in the
    // shared run-log store, mirroring heartbeat_runs.log_store/log_ref. Written
    // best-effort right after runLogStore.begin() — nullable because a run whose
    // transcript could not be opened (or which predates T1) still exists.
    logStore: text("log_store"),
    logRef: text("log_ref"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyIdx: index("ia_runs_company_idx").on(table.companyId),
    companyStatusIdx: index("ia_runs_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    triggerIdx: index("ia_runs_trigger_idx").on(
      table.companyId,
      table.triggerType,
      table.triggerSource,
    ),
    createdAtIdx: index("ia_runs_created_at_idx").on(
      table.companyId,
      table.createdAt,
    ),
    relatedEntityIdx: index("ia_runs_related_entity_idx").on(
      table.relatedEntityType,
      table.relatedEntityId,
    ),
    agentIdx: index("ia_runs_agent_idx").on(table.companyId, table.agentId),
    continuationIdempotencyUq: uniqueIndex("ia_runs_continuation_idempotency_uq")
      .on(table.companyId, table.continuationIdempotencyKey)
      .where(sql`continuation_idempotency_key IS NOT NULL`),
  }),
);

// ── Table 9: internal_agent_reminders ───────────────────────────────────────

export const internalAgentReminders = pgTable(
  "internal_agent_reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),

    content: text("content").notNull(), // "Follow up on dashboard project"
    triggerAt: timestamp("trigger_at", { withTimezone: true }).notNull(),

    status: text("status").notNull().default("pending"), // 'pending' | 'fired' | 'cancelled'

    firedRunId: uuid("fired_run_id").references(() => internalAgentRuns.id, {
      onDelete: "set null",
    }),

    // Optional link to entity
    relatedEntityType: text("related_entity_type"),
    relatedEntityId: uuid("related_entity_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("ia_reminders_company_user_idx").on(
      table.companyId,
      table.userId,
    ),
    pendingIdx: index("ia_reminders_pending_idx").on(
      table.status,
      table.triggerAt,
    ),
  }),
);

// ── Relations ───────────────────────────────────────────────────────────────

export const internalAgentConfigRelations = relations(
  internalAgentConfig,
  ({ one }) => ({
    company: one(companies, {
      fields: [internalAgentConfig.companyId],
      references: [companies.id],
    }),
    agent: one(agents, {
      fields: [internalAgentConfig.agentId],
      references: [agents.id],
    }),
  }),
);

export const internalAgentConversationsRelations = relations(
  internalAgentConversations,
  ({ one, many }) => ({
    company: one(companies, {
      fields: [internalAgentConversations.companyId],
      references: [companies.id],
    }),
    messages: many(internalAgentMessages),
  }),
);

export const internalAgentMessagesRelations = relations(
  internalAgentMessages,
  ({ one }) => ({
    conversation: one(internalAgentConversations, {
      fields: [internalAgentMessages.conversationId],
      references: [internalAgentConversations.id],
    }),
    run: one(internalAgentRuns, {
      fields: [internalAgentMessages.runId],
      references: [internalAgentRuns.id],
    }),
  }),
);

export const internalAgentRunsRelations = relations(
  internalAgentRuns,
  ({ one }) => ({
    company: one(companies, {
      fields: [internalAgentRuns.companyId],
      references: [companies.id],
    }),
    department: one(projects, {
      fields: [internalAgentRuns.departmentContext],
      references: [projects.id],
    }),
  }),
);

export const internalAgentRemindersRelations = relations(
  internalAgentReminders,
  ({ one }) => ({
    company: one(companies, {
      fields: [internalAgentReminders.companyId],
      references: [companies.id],
    }),
  }),
);
