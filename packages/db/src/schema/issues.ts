import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";
import { artifacts } from "./artifacts.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { environments } from "./environments.js";
// discussions imports issues, creating a circular module-init dependency.
// The lazy `(): AnyPgColumn => discussions.id` callback below is evaluated at
// table-build time (after both modules have finished loading), matching the
// existing executionWorkspaces ↔ issues circular pattern.
import { discussions } from "./discussions.js";
import { threadScopeVersions } from "./thread_scope_versions.js";

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => issues.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("backlog"),
    // The status a task held immediately before it was auto-blocked by a
    // dependency. Restored on unblock so an auto-blocked `backlog` task is not
    // silently promoted to `todo` (and auto-dispatched). Nullable; only set
    // while a task is in the `blocked` state, cleared when unblocked. (A-M10)
    blockedFromStatus: text("blocked_from_status"),
    workMode: text("work_mode").notNull().default("standard"),
    priority: text("priority").notNull().default("medium"),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    assigneeUserId: text("assignee_user_id"),
    responsibleUserId: text("responsible_user_id"),
    // Polymorphic run lock: holds a heartbeat_runs.id (org agents) OR an internal_agent_runs.id (crew, Decision #100).
    // No FK — the column is polymorphic across two run tables, so it cannot reference a single one.
    checkoutRunId: uuid("checkout_run_id"),
    executionRunId: uuid("execution_run_id"),
    executionAgentNameKey: text("execution_agent_name_key"),
    executionLockedAt: timestamp("execution_locked_at", { withTimezone: true }),
    executionWorkspaceId: uuid("execution_workspace_id")
      .references((): AnyPgColumn => executionWorkspaces.id, { onDelete: "set null" }),
    executionWorkspacePreference: text("execution_workspace_preference"),
    executionWorkspaceSettings: jsonb("execution_workspace_settings").$type<Record<string, unknown>>(),
    executionEnvironmentId: uuid("execution_environment_id").references(
      () => environments.id,
      { onDelete: "set null" },
    ),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    issueNumber: integer("issue_number"),
    identifier: text("identifier"),
    requestDepth: integer("request_depth").notNull().default(0),
    billingCode: text("billing_code"),
    assigneeAdapterOverrides: jsonb("assignee_adapter_overrides").$type<Record<string, unknown>>(),
    source: text("source"),
    reviewerUserId: text("reviewer_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    reviewerSource: text("reviewer_source"),
    acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull().default([]),
    agentCompletionPolicy: text("agent_completion_policy").notNull().default("review_required"),
    agentCompletionPolicyOverride: text("agent_completion_policy_override"),
    agentCompletionPolicySource: text("agent_completion_policy_source")
      .notNull()
      .default("legacy_backfill"),
    agentCompletionPolicySourceId: text("agent_completion_policy_source_id"),
    agentCompletionPolicyResolvedAt: timestamp("agent_completion_policy_resolved_at", {
      withTimezone: true,
    }).notNull().defaultNow(),
    dueDate: timestamp("due_date", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    originKind: text("origin_kind"),
    originId: text("origin_id"),
    originRunId: uuid("origin_run_id"),
    // Phase 1 (Task A3): the discussion thread that produced this task via
    // Dispatcher's scope_proposal acceptance. Nullable; ON DELETE SET NULL
    // so deleting the source thread does not cascade-delete tasks that were
    // spawned from it (the task can outlive the thread). Lazy FK reference
    // because discussions.ts imports issues (see top of file).
    sourceDiscussionId: uuid("source_discussion_id").references(
      (): AnyPgColumn => discussions.id,
      { onDelete: "set null" },
    ),
    scopeVersionId: uuid("scope_version_id").references(
      (): AnyPgColumn => threadScopeVersions.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("issues_company_status_idx").on(table.companyId, table.status),
    assigneeStatusIdx: index("issues_company_assignee_status_idx").on(
      table.companyId,
      table.assigneeAgentId,
      table.status,
    ),
    assigneeUserStatusIdx: index("issues_company_assignee_user_status_idx").on(
      table.companyId,
      table.assigneeUserId,
      table.status,
    ),
    responsibleUserStatusIdx: index("issues_company_responsible_user_status_idx").on(
      table.companyId,
      table.responsibleUserId,
      table.status,
    ),
    parentIdx: index("issues_company_parent_idx").on(table.companyId, table.parentId),
    projectIdx: index("issues_company_project_idx").on(table.companyId, table.projectId),
    // Per-company (Phase 1): issue_counter is per-company, so PAP-1 is unique
    // within a company even when two companies (in different Orgs) share prefix.
    identifierIdx: uniqueIndex("issues_identifier_idx").on(table.companyId, table.identifier),
    originRoutineUq: index("issues_open_routine_execution_uq")
      .on(table.originKind, table.originId)
      .where(sql`origin_kind IS NOT NULL AND status NOT IN ('done', 'cancelled')`),
    executionWorkspaceIdx: index("issues_company_execution_workspace_idx").on(table.companyId, table.executionWorkspaceId),
    sourceDiscussionIdx: index("issues_source_discussion_idx").on(table.sourceDiscussionId),
    scopeVersionIdx: index("issues_scope_version_idx").on(table.scopeVersionId),
    companyOriginKindIdx: index("issues_company_origin_kind_idx").on(table.companyId, table.originKind),
  }),
);
