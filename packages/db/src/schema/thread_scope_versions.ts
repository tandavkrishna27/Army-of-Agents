import {
  type AnyPgColumn,
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
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { discussions, discussionEntries } from "./discussions.js";

export const threadScopeVersions = pgTable(
  "thread_scope_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").notNull().references(() => discussions.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    status: text("status").notNull().default("draft"),
    sourceStartSeq: integer("source_start_seq").notNull(),
    sourceEndSeq: integer("source_end_seq").notNull(),
    baseVersionId: uuid("base_version_id").references((): AnyPgColumn => threadScopeVersions.id, {
      onDelete: "set null",
    }),
    proposalEntryId: uuid("proposal_entry_id").references(() => discussionEntries.id, { onDelete: "set null" }),
    summary: text("summary").notNull(),
    assumptions: jsonb("assumptions").notNull().default([]),
    decisions: jsonb("decisions").notNull().default([]),
    openQuestions: jsonb("open_questions").notNull().default([]),
    createdBy: text("created_by").notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    acceptedByUserId: text("accepted_by_user_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyThreadIdx: index("thread_scope_versions_company_thread_idx").on(table.companyId, table.threadId),
    threadVersionUq: uniqueIndex("thread_scope_versions_thread_version_uq").on(table.threadId, table.versionNumber),
    oneDraftUq: uniqueIndex("thread_scope_versions_one_draft_uq")
      .on(table.threadId)
      .where(sql`${table.status} = 'draft'`),
  }),
);
