import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  integer,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { companies } from "./companies.js";

// ── Table 11: notifications ─────────────────────────────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(), // recipient

    // Notification content
    type: text("type").notNull(),
    // 'discussion.extraction_complete' | 'discussion.extraction_failed'
    // | 'internal_agent.reminder' | 'internal_agent.proactive'
    // | 'internal_agent.action_result'
    // | 'thread.mention' | 'thread.scope_proposal_posted'
    // | 'thread.artifact_needs_review' | 'thread.crew_failed'
    // | 'thread.spinoff_suggested' | 'thread.human_input_needed'
    title: text("title").notNull(),
    message: text("message"),

    // Link to related entity
    relatedEntityType: text("related_entity_type"),
    // 'discussion' | 'task' | 'goal' | 'agent' | 'memory' | 'reminder'
    relatedEntityId: uuid("related_entity_id"),

    // State
    readAt: timestamp("read_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),

    // Delivery tracking (Phase G2, T26).
    // `deliveryAttempts` increments on every retry attempt. `deliveredAt` is
    // stamped when the row is considered successfully delivered (or queued
    // for the realtime channel — concrete delivery adapters land later).
    // `deliveryError` is the most recent failure message; rows with a non-
    // null error and < MAX_DELIVERY_ATTEMPTS attempts are picked up by the
    // notification retry worker. See server/src/services/notifications.ts.
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveryError: text("delivery_error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // ── Hub control-plane columns (W1a) ──
    semanticType: text("semantic_type"), // HubSemanticType; null on legacy rows until backfilled
    status: text("status").notNull().default("open"), // HubItemStatus
    priority: text("priority").notNull().default("normal"),
    groupKey: text("group_key"),
    slaAt: timestamp("sla_at", { withTimezone: true }),
    sourceType: text("source_type"), // e.g. "approval" | "heartbeat_run" | "discussion"
    sourceId: text("source_id"),
    scopeKey: text("scope_key"), // department/project/goal scope for RBAC + dedupe
    sourceUniqueKey: text("source_unique_key"), // company+sourceType+sourceId+semanticType+scopeKey
    summary: text("summary"), // REDACTED denormalized body (redact-before-persist)
    sourcePermissionRevision: text("source_permission_revision"),
    ownerUserId: text("owner_user_id"), // nullable (pool-owned items)
    ownerPool: text("owner_pool"), // HubOwnerPool when no single owner
    claimedByUserId: text("claimed_by_user_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    version: integer("version").notNull().default(0), // optimistic concurrency token
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),

    // W4 Steward display-only curation metadata. These fields have their own
    // revision so background explanation updates never bump lifecycle version.
    curationGroupLabel: text("curation_group_label"),
    curationGroupSummary: text("curation_group_summary"),
    curationReason: text("curation_reason"),
    curationPriorityReason: text("curation_priority_reason"),
    curationRevision: integer("curation_revision").notNull().default(0),
    curatedAt: timestamp("curated_at", { withTimezone: true }),
    curatedByAgentId: uuid("curated_by_agent_id"),
  },
  (table) => ({
    companyUserIdx: index("notifications_company_user_idx").on(
      table.companyId,
      table.userId,
    ),
    unreadIdx: index("notifications_unread_idx").on(
      table.companyId,
      table.userId,
      table.readAt,
    ),
    createdAtIdx: index("notifications_created_at_idx").on(
      table.companyId,
      table.createdAt,
    ),
    retryQueueIdx: index("notifications_retry_queue_idx")
      .on(table.deliveryAttempts, table.deliveryError)
      .where(
        sql`delivery_error IS NOT NULL AND delivered_at IS NULL`,
      ),

    // ── Hub control-plane indexes (W1a) ──
    // Hot set = open items only; active-hub queries touch a small working set.
    hubOpenIdx: index("hub_items_open_idx")
      .on(table.companyId, table.semanticType, table.createdAt)
      .where(sql`${table.status} = 'open'`),
    hubOwnerOpenIdx: index("hub_items_owner_open_idx")
      .on(table.companyId, table.ownerUserId)
      .where(sql`${table.status} = 'open'`),
    hubClaimedOpenIdx: index("hub_items_claimed_open_idx")
      .on(table.companyId, table.claimedByUserId)
      .where(sql`${table.status} = 'open'`),
    hubGroupOpenIdx: index("hub_items_group_open_idx")
      .on(table.companyId, table.groupKey, table.createdAt)
      .where(sql`${table.status} = 'open'`),
    hubScopeOpenIdx: index("hub_items_scope_open_idx")
      .on(table.companyId, table.scopeKey, table.createdAt)
      .where(sql`${table.status} = 'open'`),
    hubSourceOpenIdx: index("hub_items_source_open_idx")
      .on(table.companyId, table.sourceType, table.createdAt)
      .where(sql`${table.status} = 'open'`),
    hubSourceUniqueIdx: uniqueIndex("hub_items_source_unique_idx").on(
      table.sourceUniqueKey,
    ),
  }),
);

// ── Relations ───────────────────────────────────────────────────────────────

export const notificationsRelations = relations(
  notifications,
  ({ one }) => ({
    company: one(companies, {
      fields: [notifications.companyId],
      references: [companies.id],
    }),
  }),
);

// ── Hub alias (W1a) ─────────────────────────────────────────────────────────
// Canonical hub name; same physical `notifications` table (evolve, don't rename).
// The `notifications` export stays for un-migrated call sites (deprecated alias).
export const hubItems = notifications;
