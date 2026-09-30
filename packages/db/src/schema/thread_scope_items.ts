import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { artifacts, artifactVersions } from "./artifacts.js";
import { companies } from "./companies.js";
import { discussionExtractedItems } from "./discussions.js";
import { issues } from "./issues.js";
import { memoryItems } from "./memory_items.js";
import { threadScopeVersions } from "./thread_scope_versions.js";

export const threadScopeItems = pgTable(
  "thread_scope_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scopeVersionId: uuid("scope_version_id")
      .notNull()
      .references(() => threadScopeVersions.id, { onDelete: "cascade" }),
    itemOrder: integer("item_order").notNull().default(0),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("draft"),
    title: text("title").notNull(),
    description: text("description"),
    payload: jsonb("payload").notNull().default({}),
    sourceEntryIds: jsonb("source_entry_ids").notNull().default([]),
    extractedItemId: uuid("extracted_item_id").references(() => discussionExtractedItems.id, { onDelete: "set null" }),
    targetIssueId: uuid("target_issue_id").references(() => issues.id, { onDelete: "set null" }),
    resultIssueId: uuid("result_issue_id").references(() => issues.id, { onDelete: "set null" }),
    resultMemoryId: uuid("result_memory_id").references(() => memoryItems.id, { onDelete: "set null" }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    artifactVersionId: uuid("artifact_version_id").references(() => artifactVersions.id, { onDelete: "set null" }),
    // #198 PR-A: idempotency anchor for action-gated scope-item commits
    // (thread-agent-actions). The thread_agent_actions.id whose commit produced
    // this item; NULL for all non-gated items. The partial unique index below
    // makes the gated commit idempotent — the same action can never produce two
    // scope items.
    sourceActionId: uuid("source_action_id"),
    appliedByUserId: text("applied_by_user_id"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeVersionIdx: index("thread_scope_items_scope_version_idx").on(table.scopeVersionId),
    kindStatusIdx: index("thread_scope_items_kind_status_idx").on(table.kind, table.status),
    targetIssueIdx: index("thread_scope_items_target_issue_idx").on(table.targetIssueId),
    resultIssueIdx: index("thread_scope_items_result_issue_idx").on(table.resultIssueId),
    // #198 PR-A: idempotent action-gated scope-item commit. At most one item per
    // (company, source_action_id); partial so non-gated items (NULL) are exempt.
    sourceActionUniq: uniqueIndex("thread_scope_items_source_action_uq")
      .on(table.companyId, table.sourceActionId)
      .where(sql`source_action_id IS NOT NULL`),
  }),
);

export const threadScopeArtifactLinks = pgTable(
  "thread_scope_artifact_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scopeVersionId: uuid("scope_version_id")
      .notNull()
      .references(() => threadScopeVersions.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id").notNull().references(() => artifacts.id, { onDelete: "cascade" }),
    artifactVersionId: uuid("artifact_version_id").references(() => artifactVersions.id, { onDelete: "set null" }),
    role: text("role").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeVersionIdx: index("thread_scope_artifact_links_scope_version_idx").on(table.scopeVersionId),
    artifactIdx: index("thread_scope_artifact_links_artifact_idx").on(table.artifactId),
  }),
);
