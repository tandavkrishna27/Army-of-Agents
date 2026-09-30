import type {
  IssueCommentAuthorType,
  IssueCommentMetadata,
  IssueCommentPresentation,
} from "@armyofagents/shared";
import { pgTable, uuid, text, timestamp, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const issueComments = pgTable(
  "issue_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
    authorType: text("author_type").$type<IssueCommentAuthorType>(),
    presentation: jsonb("presentation").$type<IssueCommentPresentation | null>(),
    metadata: jsonb("metadata").$type<IssueCommentMetadata | null>(),
    body: text("body").notNull(),
    // Client-generated idempotency key for user Sends. A retried Send replays the
    // original comment. Nullable: agent/system-authored comments carry no key.
    clientSubmissionId: text("client_submission_id"),
    // Deterministic completion marker for the comment's control effects
    // (reopen/interrupt) — PR #291 round-6 (#2). The comment commits BEFORE its
    // control effects, so a post-insert failure leaves them incomplete. Set once
    // the insert winner's applyIssueCommentControlEffects succeeds. On the replay
    // fast-path: SET → effects are truly done, skip them (a stale retry can't
    // re-reopen a task the founder legitimately re-closed); NULL → resume them.
    controlEffectsCompletedAt: timestamp("control_effects_completed_at", { withTimezone: true }),
    // Completion marker for the comment's @mention/assignee wakeups — PR #291
    // round-7 (#3), symmetric with control_effects_completed_at. The comment
    // commits BEFORE wakeups are enqueued, so a request that dies after the
    // comment (e.g. during activity logging or file storage) never reaches
    // enqueueIssueCommentWakeups. Set once the winner reaches the enqueue step;
    // a replay/race-loser resumes wakeups ONLY when NULL, so a mentioned agent is
    // never left un-woken and a completed wakeup is never double-fired.
    wakeupsEnqueuedAt: timestamp("wakeups_enqueued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("issue_comments_issue_idx").on(table.issueId),
    // Enforce one comment per (company, task, submission key). Scoped by issueId
    // to match the replay lookup (getCommentByClientSubmissionId), so a client
    // that legitimately reuses a submission id across DIFFERENT tasks does not
    // collide — and the race fallback can never return a comment from another
    // task (PR #291 round-4 review). Partial: null keys exempt.
    clientSubmissionUq: uniqueIndex("issue_comments_client_submission_uq")
      .on(table.companyId, table.issueId, table.clientSubmissionId)
      .where(sql`client_submission_id IS NOT NULL`),
    companyIdx: index("issue_comments_company_idx").on(table.companyId),
    companyIssueCreatedAtIdx: index("issue_comments_company_issue_created_at_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    companyAuthorIssueCreatedAtIdx: index("issue_comments_company_author_issue_created_at_idx").on(
      table.companyId,
      table.authorUserId,
      table.issueId,
      table.createdAt,
    ),
  }),
);
