import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { WorkQuestionAnswer, WorkQuestionOption } from "@armyofagents/shared";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { discussionEntries, discussions } from "./discussions.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { internalAgentConversations } from "./internal_agent.js";
import { issues } from "./issues.js";

export const workQuestions = pgTable(
  "work_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    issueIdentifierSnapshot: text("issue_identifier_snapshot"),
    issueTitleSnapshot: text("issue_title_snapshot"),
    askingAgentId: uuid("asking_agent_id").references(() => agents.id, { onDelete: "set null" }),
    askingAgentNameSnapshot: text("asking_agent_name_snapshot"),
    originatingRunKind: text("originating_run_kind"),
    // V1 uses heartbeat_runs. internal_agent is reserved for a future
    // runtime-specific continuation path and must not be routed via heartbeat.
    originatingRunId: uuid("originating_run_id"),
    producerInvocationId: text("producer_invocation_id"),
    producerPayloadFingerprint: text("producer_payload_fingerprint"),
    executionWorkspaceId: uuid("execution_workspace_id").references(
      () => executionWorkspaces.id,
      { onDelete: "set null" },
    ),
    sourceDiscussionId: uuid("source_discussion_id").references(() => discussions.id, {
      onDelete: "set null",
    }),
    sourceDiscussionEntryId: uuid("source_discussion_entry_id").references(
      () => discussionEntries.id,
      { onDelete: "set null" },
    ),
    sourceCommanderConversationId: uuid("source_commander_conversation_id").references(
      () => internalAgentConversations.id,
      { onDelete: "set null" },
    ),
    primaryRecipientUserId: text("primary_recipient_user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    currentRecipientUserId: text("current_recipient_user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    question: text("question").notNull(),
    context: jsonb("context").$type<Record<string, unknown>>(),
    options: jsonb("options").$type<WorkQuestionOption[]>(),
    blocking: boolean("blocking").notNull().default(true),
    slaDurationHours: integer("sla_duration_hours").notNull().default(24),
    slaSource: text("sla_source").notNull().default("company"),
    slaSourceId: uuid("sla_source_id"),
    dueAt: timestamp("due_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
    slaBreachedAt: timestamp("sla_breached_at", { withTimezone: true }),
    slaNotificationsCompletedAt: timestamp("sla_notifications_completed_at", { withTimezone: true }),
    escalationRecipientUserId: text("escalation_recipient_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("open"),
    answer: jsonb("answer").$type<WorkQuestionAnswer>(),
    answerIdempotencyKey: text("answer_idempotency_key"),
    answeredByUserId: text("answered_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    continuationStatus: text("continuation_status").notNull().default("not_needed"),
    continuationRunKind: text("continuation_run_kind"),
    // V1 uses heartbeat_runs; internal-agent continuation is future scope.
    continuationRunId: uuid("continuation_run_id"),
    continuationError: text("continuation_error"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRecipientStatusIdx: index("work_questions_company_recipient_status_idx").on(
      table.companyId,
      table.currentRecipientUserId,
      table.status,
    ),
    issueStatusCreatedIdx: index("work_questions_issue_status_created_idx").on(
      table.issueId,
      table.status,
      table.createdAt,
    ),
    sourceDiscussionCreatedIdx: index("work_questions_source_discussion_created_idx").on(
      table.sourceDiscussionId,
      table.createdAt,
    ),
    workspaceCreatedIdx: index("work_questions_workspace_created_idx").on(
      table.executionWorkspaceId,
      table.createdAt,
    ),
    originatingRunIdx: index("work_questions_originating_run_idx").on(
      table.originatingRunKind,
      table.originatingRunId,
    ),
    continuationStatusIdx: index("work_questions_continuation_status_idx").on(
      table.continuationStatus,
      table.updatedAt,
    ),
    openDueAtIdx: index("work_questions_open_due_at_idx").on(
      table.status,
      table.dueAt,
    ),
    producerInvocationUq: uniqueIndex("work_questions_producer_invocation_uq")
      .on(
        table.companyId,
        table.originatingRunKind,
        table.originatingRunId,
        table.producerInvocationId,
      )
      .where(sql`producer_invocation_id IS NOT NULL`),
    openPayloadFingerprintUq: uniqueIndex("work_questions_open_payload_fingerprint_uq")
      .on(
        table.companyId,
        table.originatingRunKind,
        table.originatingRunId,
        table.producerPayloadFingerprint,
      )
      .where(sql`status = 'open' AND producer_payload_fingerprint IS NOT NULL`),
    sourceCommanderCreatedIdx: index("work_questions_source_commander_created_idx").on(
      table.sourceCommanderConversationId,
      table.createdAt,
    ),
  }),
);
