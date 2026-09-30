import {
  type AnyPgColumn,
  customType,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type { ShowRef } from "@armyofagents/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { memoryItems } from "./memory_items.js";
import { internalAgentRuns } from "./internal_agent.js";

/**
 * Custom Drizzle type for pgvector's `vector(N)` column.
 * Stores/retrieves a number[] and maps to the SQL `vector` type.
 * Mirrors the pattern in memory_items.ts. Runtime gating via
 * probeDbCapabilities() — embedded-postgres bundles do not ship pgvector,
 * so any code path that writes/reads this column must check capability first.
 */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    // pgvector returns "[0.1,0.2,...]" string
    return JSON.parse(value);
  },
});

// ── Table 1: discussions ──────────────────────────────────────────────────────

export const discussions = pgTable(
  "discussions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    title: text("title"), // nullable — auto-generated if not provided
    status: text("status").notNull().default("active"), // 'active' | 'archived'

    // Polymorphic scope — what this discussion is about
    scopeType: text("scope_type"), // 'department' | 'project' | 'goal' | null
    scopeId: uuid("scope_id"), // FK resolved at app level based on scopeType

    tags: jsonb("tags").default([]), // string array for flexible categorization

    // ── Threads v1: thread-container fields ──
    originSource: text("origin_source"), // ThreadOriginSource: human|agent|external|system
    originMedium: text("origin_medium"), // ThreadOriginMedium
    intent: jsonb("intent").default([]), // ThreadIntent[] (multi-tag)
    phase: text("phase").notNull().default("discuss"), // ThreadPhase: discuss|scope|assign|done
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }), // goal-as-property
    // ThreadVisibility: private|department|company (Phase 1 A2 canonicalized
    // from legacy open|private). Migration backfills existing "open" rows to
    // "company". The migration column-default change also flips new rows to
    // "company" instead of "open".
    visibility: text("visibility").notNull().default("company"),
    ownerUserId: text("owner_user_id"), // accountable human (TEXT like issues.assigneeUserId); null = Unclaimed
    autonomyLevel: integer("autonomy_level"), // 0..2 (Manual/Assist/Drive); null = fall back to internal_agent_config
    subtype: text("subtype").notNull().default("normal"), // ThreadSubtype: normal|live
    forkedFromId: uuid("forked_from_id").references((): AnyPgColumn => discussions.id, { onDelete: "set null" }),
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => discussions.id, { onDelete: "set null" }),
    summaryText: text("summary_text"),
    summaryNext: text("summary_next"),
    summaryUpdatedAt: timestamp("summary_updated_at", { withTimezone: true }),
    // Routing card — key entities + aliases for routing retrieval (Chronicler-written).
    // jsonb string[] (matches this table's tags/intent pattern; DB-validated, no
    // serialize/parse in readers). NULL on threads created before a card was seeded.
    routingTerms: jsonb("routing_terms").$type<string[]>(),
    entrySeq: integer("entry_seq").notNull().default(0), // atomic per-thread entry counter (Plan 7 seq assignment)

    // ── Phase 1 thread-native coordination (Task A2) ─────────────────────────
    // Public share link for read-only external view. Unique so the token
    // alone resolves to a single thread. Nullable — set on demand by founder.
    shareToken: text("share_token").unique(),
    // Slack channel binding (Phase 2 wiring — column added but not used yet).
    slackChannelId: text("slack_channel_id"),
    // When true, the Scribe (extraction) crew may propose memory items from
    // this thread's entries. When false, no memory suggestions are produced.
    allowMemoryExtraction: boolean("allow_memory_extraction").notNull().default(true),
    // Per-thread toggle for the Adjutant crew (Router/Planner/Dispatcher).
    // Independent of crewPaused (which is the broader "no crew at all" switch);
    // adjutantEnabled = false silences just the Adjutant while other roles
    // still run if crewPaused = false.
    adjutantEnabled: boolean("adjutant_enabled").notNull().default(true),
    // Semantic summary embedding for cross-thread retrieval. Populated by the
    // summarizer pipeline; gated by probeDbCapabilities() because embedded-postgres
    // does not ship pgvector. The HNSW index is added defensively in the
    // accompanying migration.
    summaryEmbedding: vector("summary_embedding"),

    // Plan 3 Task 8: thread-level crew kill-switch.
    // When true, no crew roles (Router, Planner, Dispatcher, Memory Keeper) fire
    // for this thread. Does NOT affect Scribe (extraction) — that is gated
    // separately by the outbox trigger. Company-level pause is in internal_agent_config.
    crewPaused: boolean("crew_paused").notNull().default(false),

    // P1-T11: Per-thread strangler flag.
    // When true, this thread uses the P1 orchestration controller path.
    // The old peer-wake pipeline (sweep-adjutant, dispatcher, advancePhase wakeups)
    // is dormant for this thread. Set on create for all new threads; false for
    // pre-existing threads (they stay on the old path).
    useControllerPath: boolean("use_controller_path").notNull().default(false),

    // Denormalized metadata
    entryCount: integer("entry_count").notNull().default(0),
    pendingItemCount: integer("pending_item_count").notNull().default(0),
    lastEntryAt: timestamp("last_entry_at", { withTimezone: true }),

    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("discussions_company_idx").on(table.companyId),
    companyStatusIdx: index("discussions_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    scopeIdx: index("discussions_scope_idx").on(table.scopeType, table.scopeId),
    lastEntryIdx: index("discussions_last_entry_idx").on(
      table.companyId,
      table.lastEntryAt,
    ),
  }),
);

// ── Table 2: discussion_entries ───────────────────────────────────────────────

export const discussionEntries = pgTable(
  "discussion_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discussionId: uuid("discussion_id")
      .notNull()
      .references(() => discussions.id, { onDelete: "cascade" }),

    // Input
    inputType: text("input_type").notNull(), // DiscussionEntryInputType: paste|write|voice|mcp|transcript|document|routine|webhook|integration|agent
    rawContent: text("raw_content").notNull(),
    title: text("title"), // nullable, optional per-entry title

    // Source metadata
    sourceInfo: jsonb("source_info"), // { transcriptionModel, mcpSource, mcpClientId, ... }

    // Scope override (entry-level > discussion-level, per Decision #61 pattern)
    departmentId: uuid("department_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    goalId: uuid("goal_id").references(() => goals.id, {
      onDelete: "set null",
    }),

    // Processing state
    extractionStatus: text("extraction_status").notNull().default("pending"),
    // 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'
    extractionRunId: uuid("extraction_run_id").references(
      () => internalAgentRuns.id,
      { onDelete: "set null" },
    ),

    // ── P1-T7: scope_proposal approval lifecycle ────────────────────────────
    // Dedicated status field for `inputType = "scope_proposal"` entries so the
    // Approve handler never has to overload `extractionStatus` (which belongs
    // to the LLM-extraction lifecycle and is mutated by the autonomous Scribe
    // drain / reprocess sweeps — both of which select by extractionStatus with
    // no inputType filter, so reusing it would corrupt approval state).
    //   null      — not a proposal (the column is meaningless for non-proposals)
    //   'pending' — proposal awaiting founder/team-lead approval
    //   'approved'— approved; deliverable tasks created (terminal)
    //   'rejected'— rejected by a human (terminal)
    // The claim-first idempotency guard transitions pending -> approved with a
    // single conditional UPDATE ... RETURNING so concurrent approves create
    // tasks exactly once.
    proposalStatus: text("proposal_status"), // null for non-proposal entries

    // ── Threads v1: nested replies + agent authorship ──
    parentEntryId: uuid("parent_entry_id").references((): AnyPgColumn => discussionEntries.id, { onDelete: "set null" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),

    // Plan 7: per-thread monotonic ordering for catch-up (reconnect-refetch).
    // Assigned atomically from discussions.entrySeq on insert (see
    // discussionService.addEntry). 0 = legacy rows created before Plan 7.
    seq: integer("seq").notNull().default(0),

    // #197: idempotency anchor for action-gated commits (thread-agent-actions).
    // The thread_agent_actions.id whose commit produced this entry; NULL for all
    // non-gated entries. The partial unique index below makes the gated commit
    // idempotent — the same action can never produce two entries. #198 extends
    // this guarantee to all action types.
    sourceActionId: uuid("source_action_id"),

    // Client-generated idempotency key for user Sends. A retried Send replays the
    // original entry. Nullable: agent/system/action-gated entries carry no key.
    clientSubmissionId: text("client_submission_id"),

    // Viewer Upgrade Phase 7B: navigational ShowRefs carried by crew run-result
    // entries so the Discussions viewer can open the delivered task/artifacts/
    // outputs. Nullable — only run-result delivery entries populate it. Mirrors
    // internal_agent_messages.output_refs (typed CommanderOutputRef[]); here the
    // superset ShowRef[] type covers v:2 navigational kinds.
    outputRefs: jsonb("output_refs").$type<ShowRef[]>(),

    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    discussionIdx: index("discussion_entries_discussion_idx").on(
      table.discussionId,
    ),
    // Enforce one entry per (discussion, submission key). Partial: null keys exempt.
    clientSubmissionUq: uniqueIndex("discussion_entries_client_submission_uq")
      .on(table.discussionId, table.clientSubmissionId)
      .where(sql`client_submission_id IS NOT NULL`),
    extractionStatusIdx: index("discussion_entries_extraction_status_idx").on(
      table.extractionStatus,
    ),
    createdAtIdx: index("discussion_entries_created_at_idx").on(
      table.discussionId,
      table.createdAt,
    ),
    // Plan 7: backstop the atomic counter — no two entries share a seq per
    // thread. Partial (WHERE seq <> 0) so legacy rows (all defaulting to 0
    // before Plan 7 assigned seqs) don't collide and block the migration.
    threadSeqUniq: uniqueIndex("discussion_entries_thread_seq_uniq")
      .on(table.discussionId, table.seq)
      .where(sql`${table.seq} <> 0`),
    // Task 2.1 (Crew Work-as-Tasks): one-pending-per-thread guard (D5/D6/D8).
    // At most one scope_proposal entry with proposalStatus='pending' may exist
    // per thread at any time. writeScopeProposal catches a violation on this
    // index and converts it to { existing: true } rather than failing —
    // making the write idempotent across concurrent Planner runs or retries.
    onePendingScopeProposalIdx: uniqueIndex(
      "discussion_entries_one_pending_scope_proposal_idx",
    )
      .on(table.discussionId)
      .where(
        sql`input_type = 'scope_proposal' AND proposal_status = 'pending'`,
      ),
    // #197: idempotent action-gated commit. At most one entry per
    // (discussion, source_action_id); partial so non-gated entries (NULL) are exempt.
    sourceActionUniq: uniqueIndex("discussion_entries_source_action_uq")
      .on(table.discussionId, table.sourceActionId)
      .where(sql`source_action_id IS NOT NULL`),
  }),
);

// ── Table 3: discussion_extracted_items ───────────────────────────────────────

export const discussionExtractedItems = pgTable(
  "discussion_extracted_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discussionEntryId: uuid("discussion_entry_id")
      .notNull()
      .references(() => discussionEntries.id, { onDelete: "cascade" }),

    // Item content
    type: text("type").notNull(),
    // ExtractionItemType: decision|task|insight|context|reference|preference|artifact|spin_off_thread
    title: text("title").notNull(),
    description: text("description"),

    // Suggestions from extraction
    suggestedPriority: text("suggested_priority"), // IssuePriority: 'critical' | 'high' | 'medium' | 'low'
    suggestedAssigneeId: uuid("suggested_assignee_id"),
    suggestedDepartmentId: uuid("suggested_department_id").references(
      () => projects.id,
      { onDelete: "set null" },
    ),
    suggestedProjectId: uuid("suggested_project_id").references(
      () => projects.id,
      { onDelete: "set null" },
    ),
    suggestedLayer: text("suggested_layer"), // 'identity' | 'domain' | 'active_context' | 'working'
    suggestedGoalId: uuid("suggested_goal_id").references(() => goals.id, {
      onDelete: "set null",
    }),

    // Founder overrides (applied during review)
    layer: text("layer"), // actual memory layer chosen by founder
    priority: text("priority"), // actual priority chosen by founder

    // Memory dedup
    dedupAction: text("dedup_action"), // 'create_separate' | 'update_existing' | 'replace'
    selectedMemoryId: uuid("selected_memory_id").references(
      () => memoryItems.id,
      { onDelete: "set null" },
    ),
    mergedContent: text("merged_content"), // preview of merge result

    // Status
    status: text("status").notNull().default("pending"),
    // 'pending' | 'approved' | 'rejected' | 'edited'

    // Result links (populated after approval)
    resultTaskId: uuid("result_task_id").references(() => issues.id, {
      onDelete: "set null",
    }),
    resultMemoryId: uuid("result_memory_id").references(() => memoryItems.id, {
      onDelete: "set null",
    }),

    // Conflict detection
    conflictsWith: jsonb("conflicts_with"), // array of { entityType, entityId, description }

    // ── Threads v1: committed per-item routing (agent|human discriminator) ──
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    assigneeUserId: text("assignee_user_id"), // TEXT (mirrors issues.assigneeUserId; no FK)
    departmentId: uuid("department_id").references(() => projects.id, { onDelete: "set null" }),

    // ── Phase 1 (Task A3): per-item embedding for cross-thread semantic
    // retrieval over extracted decisions/tasks/insights. Same gating
    // discipline as discussions.summaryEmbedding: any code path that
    // writes or reads this column must first check probeDbCapabilities()
    // — embedded-postgres bundles do not ship pgvector. The defensive
    // HNSW index lives in the accompanying migration.
    embedding: vector("embedding"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    entryIdx: index("discussion_extracted_items_entry_idx").on(
      table.discussionEntryId,
    ),
    statusIdx: index("discussion_extracted_items_status_idx").on(
      table.discussionEntryId,
      table.status,
    ),
  }),
);

// ── Table 4: discussion_annotations ──────────────────────────────────────────

export const discussionAnnotations = pgTable(
  "discussion_annotations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discussionEntryId: uuid("discussion_entry_id")
      .notNull()
      .references(() => discussionEntries.id, { onDelete: "cascade" }),

    content: text("content").notNull(),

    // Position in the entry text (for inline annotations)
    // null = general annotation on the whole entry
    anchorStart: integer("anchor_start"), // character offset start
    anchorEnd: integer("anchor_end"), // character offset end

    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    entryIdx: index("discussion_annotations_entry_idx").on(
      table.discussionEntryId,
    ),
  }),
);

// ── Relations ────────────────────────────────────────────────────────────────

export const discussionsRelations = relations(discussions, ({ one, many }) => ({
  company: one(companies, {
    fields: [discussions.companyId],
    references: [companies.id],
  }),
  entries: many(discussionEntries),
}));

export const discussionEntriesRelations = relations(
  discussionEntries,
  ({ one, many }) => ({
    discussion: one(discussions, {
      fields: [discussionEntries.discussionId],
      references: [discussions.id],
    }),
    extractedItems: many(discussionExtractedItems),
    annotations: many(discussionAnnotations),
    department: one(projects, {
      fields: [discussionEntries.departmentId],
      references: [projects.id],
      relationName: "entryDepartment",
    }),
    project: one(projects, {
      fields: [discussionEntries.projectId],
      references: [projects.id],
      relationName: "entryProject",
    }),
    goal: one(goals, {
      fields: [discussionEntries.goalId],
      references: [goals.id],
    }),
    extractionRun: one(internalAgentRuns, {
      fields: [discussionEntries.extractionRunId],
      references: [internalAgentRuns.id],
    }),
  }),
);

export const discussionExtractedItemsRelations = relations(
  discussionExtractedItems,
  ({ one }) => ({
    entry: one(discussionEntries, {
      fields: [discussionExtractedItems.discussionEntryId],
      references: [discussionEntries.id],
    }),
    resultTask: one(issues, {
      fields: [discussionExtractedItems.resultTaskId],
      references: [issues.id],
    }),
    resultMemory: one(memoryItems, {
      fields: [discussionExtractedItems.resultMemoryId],
      references: [memoryItems.id],
      relationName: "extractedItemResultMemory",
    }),
  }),
);

export const discussionAnnotationsRelations = relations(
  discussionAnnotations,
  ({ one }) => ({
    entry: one(discussionEntries, {
      fields: [discussionAnnotations.discussionEntryId],
      references: [discussionEntries.id],
    }),
  }),
);
