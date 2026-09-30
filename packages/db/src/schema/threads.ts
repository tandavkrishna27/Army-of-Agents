import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  doublePrecision,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { assets } from "./assets.js";
import { artifacts } from "./artifacts.js";
import {
  discussions,
  discussionEntries,
  discussionExtractedItems,
} from "./discussions.js";

// ── thread_participants: who's on a thread (humans + agents) ──
export const threadParticipants = pgTable(
  "thread_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").notNull().references(() => discussions.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(), // ThreadParticipantPrincipalType: user|agent
    principalId: text("principal_id").notNull(), // user id (text) OR agent id (uuid stored as text)
    role: text("role").notNull(), // ThreadParticipantRole: owner|co_owner|collaborator|viewer|worker
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    threadIdx: index("thread_participants_thread_idx").on(table.threadId),
    principalIdx: index("thread_participants_principal_idx").on(table.principalType, table.principalId),
    companyIdx: index("thread_participants_company_idx").on(table.companyId),
    // Eng-review A1: prevents duplicate owner rows; Plan 2 upserts via onConflictDoNothing
    uniqParticipant: uniqueIndex("thread_participants_unique").on(
      table.threadId, table.principalType, table.principalId,
    ),
  }),
);

// ── thread_links: typed relationships between threads ──
export const threadLinks = pgTable(
  "thread_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    fromThreadId: uuid("from_thread_id").notNull().references(() => discussions.id, { onDelete: "cascade" }),
    toThreadId: uuid("to_thread_id").notNull().references(() => discussions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // ThreadLinkKind: link|spinoff|fork|merge|goal_cluster|spawned_from_task
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    fromIdx: index("thread_links_from_idx").on(table.fromThreadId),
    toIdx: index("thread_links_to_idx").on(table.toThreadId),
  }),
);

// ── scope_item_dependencies: pre-task -> pre-task blocking (before tasks exist) ──
export const scopeItemDependencies = pgTable(
  "scope_item_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blockerItemId: uuid("blocker_item_id").notNull().references(() => discussionExtractedItems.id, { onDelete: "cascade" }),
    blockedItemId: uuid("blocked_item_id").notNull().references(() => discussionExtractedItems.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    blockerIdx: index("scope_item_dependencies_blocker_idx").on(table.blockerItemId),
    blockedIdx: index("scope_item_dependencies_blocked_idx").on(table.blockedItemId),
  }),
);

// ── thread_plan_steps: the live ordered Plan in the Scope tab ──
export const threadPlanSteps = pgTable(
  "thread_plan_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull().references(() => discussions.id, { onDelete: "cascade" }),
    stepOrder: integer("step_order").notNull().default(0), // "order" is a SQL reserved word -> step_order
    title: text("title").notNull(),
    collapsed: boolean("collapsed").notNull().default(false),
    linkedItemId: uuid("linked_item_id").references(() => discussionExtractedItems.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    threadIdx: index("thread_plan_steps_thread_idx").on(table.threadId),
  }),
);

// ── thread_inbox_items: the Unlisted queue (un-routed inbound) ──
export const threadInboxItems = pgTable(
  "thread_inbox_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    rawContent: text("raw_content").notNull(),
    originSource: text("origin_source"), // ThreadOriginSource
    originMedium: text("origin_medium"), // ThreadOriginMedium
    routerConfidence: doublePrecision("router_confidence"), // 0..1 internal score (never shown raw)
    routerDecision: text("router_decision"), // ThreadRouterDecision: auto_attach|suggest|human
    suggestedThreadId: uuid("suggested_thread_id").references(() => discussions.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"), // ThreadInboxStatus: pending|attached|dismissed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // Task 0.2 (Inbound Dirty-Data Routing) ─────────────────────────────────
    // Durable dedup key — a PURE CONTENT HASH derived in inbox-producer.ts
    // (`computeDedupKey`): SHA-256 of NUL-delimited
    // (companyId + originMedium + (originSource ?? "") + rawContent). It is NOT
    // a transport/message-id — there is no inbound-adapter-provided id involved.
    // Paired with the unique index below to prevent double-insert on retry
    // across ALL statuses (Codex #8: status moves pending→attached must not
    // allow a re-delivered item to sneak in as a second row).
    //
    // COLLISION SEMANTICS: because the key is a content hash, byte-identical
    // content from the SAME (company, medium, source) is treated as a DUPLICATE
    // and silently deduped to the existing row — even a legitimately distinct
    // re-send. A producer that must force a distinct row for identical content
    // has to vary one of the hashed fields (e.g. originSource). This is the
    // intended trade-off (idempotent re-delivery > guaranteed-distinct re-sends).
    dedupKey: text("dedup_key"),

    // Router lifecycle (Codex #9): sweep distinguishes not-yet-routed vs
    // in-progress vs routed vs escalated-pending-founder vs failed.
    // Values: 'pending_route' | 'routing' | 'routed' | 'escalated' | 'failed'
    routingStatus: text("routing_status").notNull().default("pending_route"),

    // Populated when routingStatus='failed'; machine-readable error code for
    // the sweep and for UI display (e.g. 'confidence_too_low', 'timeout').
    routingErrorCode: text("routing_error_code"),

    // Timestamp when routingStatus last moved to 'routed' or 'escalated'.
    routedAt: timestamp("routed_at", { withTimezone: true }),

    // UUID of the HeartbeatRun / wakeup that the navigator spawned for this
    // item. Nullable — only populated when routerDecision='auto_attach' and
    // the navigator wakeup was actually queued.
    navigatorWakeupId: uuid("navigator_wakeup_id"),

    // Timestamp when the atomic claim (pending_route → routing) was executed.
    // Used by sweep-inbox.ts to reclaim items stranded in 'routing'/'escalated'
    // that have been in-flight longer than RECLAIM_THRESHOLD_MS (C4 / #37).
    routingClaimedAt: timestamp("routing_claimed_at", { withTimezone: true }),

    // Proposed title when the Navigator suggests creating a new thread (D2 suggest_new).
    // NULL for attach suggestions.
    suggestedThreadTitle: text("suggested_thread_title"),

    // Snapshot of the candidate cards the Navigator could see at decision time.
    // Written by routeInboxItem in the escalate path. Enables reproducible-decision
    // audit ("what did the Navigator have available?"). NULL for items routed
    // before this column existed. (A2 / Codex #12 — now core, not deferred.)
    routingCardSnapshot: jsonb("routing_card_snapshot"),
  },
  (table) => ({
    companyStatusIdx: index("thread_inbox_items_company_status_idx").on(table.companyId, table.status),
    // Durable cross-status unique guard: prevents re-delivered inbound items
    // from producing a second row after status moves pending→attached.
    // Non-partial (no WHERE) by design — Codex #8.
    companyDedupIdx: uniqueIndex("thread_inbox_items_company_dedup_idx").on(table.companyId, table.dedupKey),
  }),
);

// ── discussion_entry_attachments: link assets/artifacts to entries ──
export const discussionEntryAttachments = pgTable(
  "discussion_entry_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discussionEntryId: uuid("discussion_entry_id").notNull().references(() => discussionEntries.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entryIdx: index("discussion_entry_attachments_entry_idx").on(table.discussionEntryId),
  }),
);
