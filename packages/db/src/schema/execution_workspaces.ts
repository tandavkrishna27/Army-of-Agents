import {
  sql,
} from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projectWorkspaces } from "./project_workspaces.js";
import { projects } from "./projects.js";
// discussions imports issues (which imports execution_workspaces), so an eager
// import here would close the cycle. The lazy `(): AnyPgColumn => discussions.id`
// callback on threadId below is evaluated at table-build time after all modules
// have loaded — matches the existing executionWorkspaces ↔ issues / executionWorkspaces
// ↔ executionWorkspaces self-reference patterns above.
import { discussions } from "./discussions.js";

export const executionWorkspaces = pgTable(
  "execution_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    projectWorkspaceId: uuid("project_workspace_id").references(() => projectWorkspaces.id, { onDelete: "set null" }),
    sourceIssueId: uuid("source_issue_id").references((): AnyPgColumn => issues.id, { onDelete: "set null" }),
    // Per-thread workspace pointer (Phase 1 — Engineer interactive artifact
    // work). A workspace row is XOR: EITHER sourceIssueId is set (legacy
    // per-task) OR threadId is set (per-thread), never both, never neither.
    // The XOR invariant is enforced at the DB layer by a CHECK constraint
    // added in the accompanying migration. ON DELETE SET NULL mirrors the
    // sourceIssueId behaviour — the workspace can outlive its originating
    // thread (rare, but preserves audit/recovery without orphan cascades).
    threadId: uuid("thread_id").references((): AnyPgColumn => discussions.id, { onDelete: "set null" }),
    mode: text("mode").notNull(),
    strategyType: text("strategy_type").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    cwd: text("cwd"),
    repoUrl: text("repo_url"),
    baseRef: text("base_ref"),
    branchName: text("branch_name"),
    providerType: text("provider_type").notNull().default("local_fs"),
    providerRef: text("provider_ref"),
    derivedFromExecutionWorkspaceId: uuid("derived_from_execution_workspace_id")
      .references((): AnyPgColumn => executionWorkspaces.id, { onDelete: "set null" }),
    // Per-workspace run lock (slice 2).
    // activeRunId holds the UUID of the heartbeat run that currently owns this
    // workspace.  lockedAt is the wall-clock time the lock was acquired.  Both
    // are NULL when no run is holding the lock.  A stale lock (lockedAt older
    // than a configured threshold) can be reclaimed by a new run — see
    // tryClaimWorkspaceRun() in execution-workspaces.ts.
    activeRunId: uuid("active_run_id"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    cleanupEligibleAt: timestamp("cleanup_eligible_at", { withTimezone: true }),
    cleanupReason: text("cleanup_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectStatusIdx: index("execution_workspaces_company_project_status_idx").on(
      table.companyId,
      table.projectId,
      table.status,
    ),
    companyProjectWorkspaceStatusIdx: index("execution_workspaces_company_project_workspace_status_idx").on(
      table.companyId,
      table.projectWorkspaceId,
      table.status,
    ),
    companySourceIssueIdx: index("execution_workspaces_company_source_issue_idx").on(
      table.companyId,
      table.sourceIssueId,
    ),
    // Mirrors companySourceIssueIdx for the per-thread variant — every lookup
    // that joins workspace → thread will scope by companyId first.
    companyThreadIdx: index("execution_workspaces_company_thread_idx").on(
      table.companyId,
      table.threadId,
    ),
    activeTaskWorkspaceUq: uniqueIndex("execution_workspaces_active_task_workspace_uq")
      .on(table.companyId, table.sourceIssueId)
      .where(sql`source_issue_id IS NOT NULL AND status <> 'archived'`),
    // Mirrors activeTaskWorkspaceUq: at most one non-archived workspace per
    // (company, thread). Required so Phase B Engineer doesn't accidentally
    // open two parallel workspaces for the same thread.
    activeThreadWorkspaceUq: uniqueIndex("execution_workspaces_active_thread_workspace_uq")
      .on(table.companyId, table.threadId)
      .where(sql`thread_id IS NOT NULL AND status <> 'archived'`),
    companyLastUsedIdx: index("execution_workspaces_company_last_used_idx").on(
      table.companyId,
      table.lastUsedAt,
    ),
    companyBranchIdx: index("execution_workspaces_company_branch_idx").on(
      table.companyId,
      table.branchName,
    ),
  }),
);
