import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { discussionEntries, discussions } from "./discussions.js";
import { internalAgentRuns } from "./internal_agent.js";
import { threadScopeItems } from "./thread_scope_items.js";
import { threadScopeVersions } from "./thread_scope_versions.js";

export const threadAgentActions = pgTable(
  "thread_agent_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").notNull().references(() => discussions.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => internalAgentRuns.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    actionType: text("action_type").notNull(),
    status: text("status").notNull().default("proposed"),
    payload: jsonb("payload").notNull().default({}),
    idempotencyKey: text("idempotency_key").notNull(),
    freshness: jsonb("freshness").notNull().default({}),
    // Bounded retry accounting. A per-action commit failure sets status="failed"
    // and bumps attemptCount; the commit SELECT re-picks failed rows until
    // attemptCount >= maxAttempts, at which point a poison row is left alone so
    // the orchestration cursor can finally advance past it. (Review fix (c).)
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    blockedReason: text("blocked_reason"),
    committedEntryId: uuid("committed_entry_id").references(() => discussionEntries.id, { onDelete: "set null" }),
    committedScopeVersionId: uuid("committed_scope_version_id").references(() => threadScopeVersions.id, {
      onDelete: "set null",
    }),
    committedScopeItemId: uuid("committed_scope_item_id").references(() => threadScopeItems.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyThreadStatusIdx: index("thread_agent_actions_company_thread_status_idx").on(
      table.companyId,
      table.threadId,
      table.status,
      table.createdAt,
    ),
    runIdx: index("thread_agent_actions_run_idx").on(table.runId),
    idempotencyUq: uniqueIndex("thread_agent_actions_company_idempotency_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
  }),
);
