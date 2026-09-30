import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { internalAgentConversations } from "./internal_agent.js";
import { workQuestions } from "./work_questions.js";
import type { WorkQuestionContinuationEnvelope } from "@armyofagents/shared";
import { jsonb } from "drizzle-orm/pg-core";

export const workQuestionContinuationRequests = pgTable(
  "work_question_continuation_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    questionId: uuid("question_id").notNull().references(() => workQuestions.id, { onDelete: "cascade" }),
    answerVersion: integer("answer_version").notNull(),
    targetRunKind: text("target_run_kind").notNull(),
    targetAgentId: uuid("target_agent_id").references(() => agents.id, { onDelete: "set null" }),
    targetConversationId: uuid("target_conversation_id").references(
      () => internalAgentConversations.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    lastError: text("last_error"),
    continuationEnvelope: jsonb("continuation_envelope").$type<WorkQuestionContinuationEnvelope>(),
    downstreamIdempotencyKey: text("downstream_idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    questionAnswerVersionUq: uniqueIndex("work_question_continuation_question_answer_uq").on(
      table.questionId,
      table.answerVersion,
    ),
    companyDownstreamKeyUq: uniqueIndex("work_question_continuation_company_downstream_uq").on(
      table.companyId,
      table.downstreamIdempotencyKey,
    ),
    pendingRetryIdx: index("work_question_continuation_pending_retry_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    companyQuestionIdx: index("work_question_continuation_company_question_idx").on(
      table.companyId,
      table.questionId,
    ),
    statusValid: check(
      "work_question_continuation_status_check",
      sql`status IN ('pending', 'claimed', 'dispatched', 'failed', 'cancelled')`,
    ),
    targetRunKindValid: check(
      "work_question_continuation_target_kind_check",
      sql`target_run_kind IN ('heartbeat', 'internal_agent')`,
    ),
    answerVersionValid: check(
      "work_question_continuation_answer_version_check",
      sql`answer_version > 0`,
    ),
    attemptsValid: check(
      "work_question_continuation_attempts_check",
      sql`attempts >= 0`,
    ),
  }),
);
