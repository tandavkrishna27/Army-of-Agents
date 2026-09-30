-- Comprehensive FK cascade sweep across every child-of-company table.
--
-- Migration 0066 closes the same bug class that motivated 0064
-- (issue_read_states) and 0065 (assets) but proactively across the
-- entire schema surface. Without these cascades, DELETE /api/companies/:id
-- returns 500 for any company with rows in the child tables below.
--
-- Policy:
--   - companies.id FKs => cascade (child rows do not outlive their parent)
--   - non-nullable FKs to other parents (issue_id, run_id, agent_id where
--     notNull, etc.) => cascade
--   - nullable agent/user/issue/project/goal attribution FKs => set null
--     (deleting an agent/user does not delete the audit record; it just
--     clears the attribution)
--
-- ASCII-only comments (lesson learned in 0065): Postgres on the WIN1252
-- console used by embedded-postgres rejects non-ASCII characters.
--
-- 0062 created heartbeat_run_watchdog_decisions with constraint names
-- following an older shorthand convention (hb_watchdog_*_fk). We drop
-- both the legacy and the canonical drizzle names defensively before
-- re-creating with the canonical names.

ALTER TABLE "activity_log" DROP CONSTRAINT IF EXISTS "activity_log_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_log" DROP CONSTRAINT IF EXISTS "activity_log_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_log" DROP CONSTRAINT IF EXISTS "activity_log_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "agent_api_keys" DROP CONSTRAINT IF EXISTS "agent_api_keys_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_api_keys" DROP CONSTRAINT IF EXISTS "agent_api_keys_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "agent_config_revisions" DROP CONSTRAINT IF EXISTS "agent_config_revisions_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_config_revisions" ADD CONSTRAINT "agent_config_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "agent_projects" DROP CONSTRAINT IF EXISTS "agent_projects_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_projects" ADD CONSTRAINT "agent_projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "agent_runtime_state" DROP CONSTRAINT IF EXISTS "agent_runtime_state_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runtime_state" DROP CONSTRAINT IF EXISTS "agent_runtime_state_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD CONSTRAINT "agent_runtime_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD CONSTRAINT "agent_runtime_state_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "agent_task_sessions" DROP CONSTRAINT IF EXISTS "agent_task_sessions_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" DROP CONSTRAINT IF EXISTS "agent_task_sessions_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" DROP CONSTRAINT IF EXISTS "agent_task_sessions_last_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD CONSTRAINT "agent_task_sessions_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "agent_wakeup_requests" DROP CONSTRAINT IF EXISTS "agent_wakeup_requests_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" DROP CONSTRAINT IF EXISTS "agent_wakeup_requests_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD CONSTRAINT "agent_wakeup_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD CONSTRAINT "agent_wakeup_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_reports_to_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_reports_to_agents_id_fk" FOREIGN KEY ("reports_to") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "approval_comments" DROP CONSTRAINT IF EXISTS "approval_comments_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "approval_comments" DROP CONSTRAINT IF EXISTS "approval_comments_approval_id_approvals_id_fk";
--> statement-breakpoint
ALTER TABLE "approval_comments" DROP CONSTRAINT IF EXISTS "approval_comments_author_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_comments" ADD CONSTRAINT "approval_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT IF EXISTS "approvals_requested_by_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "company_memberships" DROP CONSTRAINT IF EXISTS "company_memberships_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "company_secrets" DROP CONSTRAINT IF EXISTS "company_secrets_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "company_skills" DROP CONSTRAINT IF EXISTS "company_skills_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_goal_id_goals_id_fk";
--> statement-breakpoint
ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_heartbeat_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "document_revisions" DROP CONSTRAINT IF EXISTS "document_revisions_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "execution_workspaces" DROP CONSTRAINT IF EXISTS "execution_workspaces_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "feedback_exports" DROP CONSTRAINT IF EXISTS "feedback_exports_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "feedback_votes" DROP CONSTRAINT IF EXISTS "feedback_votes_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "feedback_votes" DROP CONSTRAINT IF EXISTS "feedback_votes_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "finance_events" DROP CONSTRAINT IF EXISTS "finance_events_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "finance_events" DROP CONSTRAINT IF EXISTS "finance_events_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "finance_events" DROP CONSTRAINT IF EXISTS "finance_events_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "finance_events" DROP CONSTRAINT IF EXISTS "finance_events_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "finance_events" DROP CONSTRAINT IF EXISTS "finance_events_goal_id_goals_id_fk";
--> statement-breakpoint
ALTER TABLE "finance_events" DROP CONSTRAINT IF EXISTS "finance_events_heartbeat_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "finance_events" DROP CONSTRAINT IF EXISTS "finance_events_cost_event_id_cost_events_id_fk";
--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "finance_events" ADD CONSTRAINT "finance_events_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "goals" DROP CONSTRAINT IF EXISTS "goals_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "goals" DROP CONSTRAINT IF EXISTS "goals_parent_id_goals_id_fk";
--> statement-breakpoint
ALTER TABLE "goals" DROP CONSTRAINT IF EXISTS "goals_owner_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_parent_id_goals_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

-- 0062 created heartbeat_run_watchdog_decisions with shorthand constraint
-- names; drop both legacy and canonical names defensively before recreating
-- with cascade/set-null policies.
ALTER TABLE "heartbeat_run_watchdog_decisions" DROP CONSTRAINT IF EXISTS "hb_watchdog_company_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" DROP CONSTRAINT IF EXISTS "hb_watchdog_run_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" DROP CONSTRAINT IF EXISTS "hb_watchdog_evaluation_issue_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" DROP CONSTRAINT IF EXISTS "hb_watchdog_created_by_agent_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" DROP CONSTRAINT IF EXISTS "hb_watchdog_created_by_run_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" DROP CONSTRAINT IF EXISTS "heartbeat_run_watchdog_decisions_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" DROP CONSTRAINT IF EXISTS "heartbeat_run_watchdog_decisions_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
-- NOTE: PG identifier limit is 63 chars. The three constraints below have
-- names that exceed this and get silently truncated by Postgres. Both DROP
-- and ADD truncate the same way, so the operations match -- but future FKs
-- on heartbeat_run_watchdog_decisions with the same first 63 chars would
-- collide on the truncated name. Consider renaming the table to
-- hb_watchdog_decisions in a future migration if more FKs are added.
ALTER TABLE "heartbeat_run_watchdog_decisions" DROP CONSTRAINT IF EXISTS "heartbeat_run_watchdog_decisions_evaluation_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" DROP CONSTRAINT IF EXISTS "heartbeat_run_watchdog_decisions_created_by_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" DROP CONSTRAINT IF EXISTS "heartbeat_run_watchdog_decisions_created_by_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_evaluation_issue_id_issues_id_fk" FOREIGN KEY ("evaluation_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_watchdog_decisions" ADD CONSTRAINT "heartbeat_run_watchdog_decisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "heartbeat_run_events" DROP CONSTRAINT IF EXISTS "heartbeat_run_events_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" DROP CONSTRAINT IF EXISTS "heartbeat_run_events_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" DROP CONSTRAINT IF EXISTS "heartbeat_run_events_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD CONSTRAINT "heartbeat_run_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "heartbeat_runs" DROP CONSTRAINT IF EXISTS "heartbeat_runs_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" DROP CONSTRAINT IF EXISTS "heartbeat_runs_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" DROP CONSTRAINT IF EXISTS "heartbeat_runs_wakeup_request_id_agent_wakeup_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_wakeup_request_id_agent_wakeup_requests_id_fk" FOREIGN KEY ("wakeup_request_id") REFERENCES "public"."agent_wakeup_requests"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "invites" DROP CONSTRAINT IF EXISTS "invites_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "issue_approvals" DROP CONSTRAINT IF EXISTS "issue_approvals_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_approvals" ADD CONSTRAINT "issue_approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "issue_attachments" DROP CONSTRAINT IF EXISTS "issue_attachments_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_attachments" ADD CONSTRAINT "issue_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "issue_comments" DROP CONSTRAINT IF EXISTS "issue_comments_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_comments" DROP CONSTRAINT IF EXISTS "issue_comments_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_comments" DROP CONSTRAINT IF EXISTS "issue_comments_author_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "issue_documents" DROP CONSTRAINT IF EXISTS "issue_documents_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_documents" ADD CONSTRAINT "issue_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_goal_id_goals_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_parent_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_assignee_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_created_by_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_id_issues_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "join_requests" DROP CONSTRAINT IF EXISTS "join_requests_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "join_requests" DROP CONSTRAINT IF EXISTS "join_requests_invite_id_invites_id_fk";
--> statement-breakpoint
ALTER TABLE "join_requests" DROP CONSTRAINT IF EXISTS "join_requests_created_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_created_agent_id_agents_id_fk" FOREIGN KEY ("created_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "principal_permission_grants" DROP CONSTRAINT IF EXISTS "principal_permission_grants_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "principal_permission_grants" ADD CONSTRAINT "principal_permission_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "project_goals" DROP CONSTRAINT IF EXISTS "project_goals_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "project_goals" ADD CONSTRAINT "project_goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "project_workspaces" DROP CONSTRAINT IF EXISTS "project_workspaces_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD CONSTRAINT "project_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_goal_id_goals_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_lead_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "workspace_operations" DROP CONSTRAINT IF EXISTS "workspace_operations_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "workspace_runtime_services" DROP CONSTRAINT IF EXISTS "workspace_runtime_services_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
