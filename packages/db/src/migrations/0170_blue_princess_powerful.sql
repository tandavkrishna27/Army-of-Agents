CREATE TABLE IF NOT EXISTS "user_entity_follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"followed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_entity_follows_entity_type_check" CHECK (entity_type IN ('task', 'project', 'goal'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"body" text DEFAULT '' NOT NULL,
	"color" text DEFAULT 'yellow' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_question_continuation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"answer_version" integer NOT NULL,
	"target_run_kind" text NOT NULL,
	"target_agent_id" uuid,
	"target_conversation_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"last_error" text,
	"continuation_envelope" jsonb,
	"downstream_idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_question_continuation_status_check" CHECK (status IN ('pending', 'claimed', 'dispatched', 'failed', 'cancelled')),
	CONSTRAINT "work_question_continuation_target_kind_check" CHECK (target_run_kind IN ('heartbeat', 'internal_agent')),
	CONSTRAINT "work_question_continuation_answer_version_check" CHECK (answer_version > 0),
	CONSTRAINT "work_question_continuation_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid,
	"issue_identifier_snapshot" text,
	"issue_title_snapshot" text,
	"asking_agent_id" uuid,
	"asking_agent_name_snapshot" text,
	"originating_run_kind" text,
	"originating_run_id" uuid,
	"producer_invocation_id" text,
	"producer_payload_fingerprint" text,
	"execution_workspace_id" uuid,
	"source_discussion_id" uuid,
	"source_discussion_entry_id" uuid,
	"source_commander_conversation_id" uuid,
	"primary_recipient_user_id" text NOT NULL,
	"current_recipient_user_id" text NOT NULL,
	"title" text NOT NULL,
	"question" text NOT NULL,
	"context" jsonb,
	"options" jsonb,
	"blocking" boolean DEFAULT true NOT NULL,
	"sla_duration_hours" integer DEFAULT 24 NOT NULL,
	"sla_source" text DEFAULT 'company' NOT NULL,
	"sla_source_id" uuid,
	"due_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	"sla_breached_at" timestamp with time zone,
	"sla_notifications_completed_at" timestamp with time zone,
	"escalation_recipient_user_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"answer" jsonb,
	"answer_idempotency_key" text,
	"answered_by_user_id" text,
	"answered_at" timestamp with time zone,
	"continuation_status" text DEFAULT 'not_needed' NOT NULL,
	"continuation_run_kind" text,
	"continuation_run_id" uuid,
	"continuation_error" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "agent_wakeup_requests_company_idempotency_key_uq";--> statement-breakpoint
ALTER TABLE "agent_runtime_trust_rules" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runtime_trust_rules" ADD COLUMN "grant_scope" text DEFAULT 'persistent' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "agent_completion_policy_default" text DEFAULT 'review_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "agent_completion_review_guardrail" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "human_question_sla_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "active_execution_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "human_question_wait_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "runtime_permission_wait_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "total_wall_clock_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_agent_runs" ADD COLUMN "active_execution_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_agent_runs" ADD COLUMN "human_question_wait_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_agent_runs" ADD COLUMN "runtime_permission_wait_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_agent_runs" ADD COLUMN "total_wall_clock_ms" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_agent_runs" ADD COLUMN "continuation_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "reviewer_source" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "agent_completion_policy" text DEFAULT 'review_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "agent_completion_policy_override" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "agent_completion_policy_source" text DEFAULT 'legacy_backfill' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "agent_completion_policy_source_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "agent_completion_policy_resolved_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "agent_completion_policy_default" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "human_question_sla_hours" integer;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "agent_completion_policy_override" text;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN "agent_completion_policy_override" text;--> statement-breakpoint
ALTER TABLE "user_entity_follows" ADD CONSTRAINT "user_entity_follows_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_entity_follows" ADD CONSTRAINT "user_entity_follows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_question_continuation_requests" ADD CONSTRAINT "work_question_continuation_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_question_continuation_requests" ADD CONSTRAINT "work_question_continuation_requests_question_id_work_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."work_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_question_continuation_requests" ADD CONSTRAINT "work_question_continuation_requests_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_question_continuation_requests" ADD CONSTRAINT "work_question_continuation_requests_target_conversation_id_internal_agent_conversations_id_fk" FOREIGN KEY ("target_conversation_id") REFERENCES "public"."internal_agent_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_questions" ADD CONSTRAINT "work_questions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_questions" ADD CONSTRAINT "work_questions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_questions" ADD CONSTRAINT "work_questions_asking_agent_id_agents_id_fk" FOREIGN KEY ("asking_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_questions" ADD CONSTRAINT "work_questions_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_questions" ADD CONSTRAINT "work_questions_source_discussion_id_discussions_id_fk" FOREIGN KEY ("source_discussion_id") REFERENCES "public"."discussions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_questions" ADD CONSTRAINT "work_questions_source_discussion_entry_id_discussion_entries_id_fk" FOREIGN KEY ("source_discussion_entry_id") REFERENCES "public"."discussion_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_questions" ADD CONSTRAINT "work_questions_source_commander_conversation_id_internal_agent_conversations_id_fk" FOREIGN KEY ("source_commander_conversation_id") REFERENCES "public"."internal_agent_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_questions" ADD CONSTRAINT "work_questions_primary_recipient_user_id_user_id_fk" FOREIGN KEY ("primary_recipient_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_questions" ADD CONSTRAINT "work_questions_current_recipient_user_id_user_id_fk" FOREIGN KEY ("current_recipient_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_questions" ADD CONSTRAINT "work_questions_escalation_recipient_user_id_user_id_fk" FOREIGN KEY ("escalation_recipient_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_questions" ADD CONSTRAINT "work_questions_answered_by_user_id_user_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_entity_follows_user_company_entity_uq" ON "user_entity_follows" USING btree ("user_id","company_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_entity_follows_company_entity_idx" ON "user_entity_follows" USING btree ("company_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_notes_user_company_idx" ON "user_notes" USING btree ("user_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_question_continuation_question_answer_uq" ON "work_question_continuation_requests" USING btree ("question_id","answer_version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_question_continuation_company_downstream_uq" ON "work_question_continuation_requests" USING btree ("company_id","downstream_idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_question_continuation_pending_retry_idx" ON "work_question_continuation_requests" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_question_continuation_company_question_idx" ON "work_question_continuation_requests" USING btree ("company_id","question_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_questions_company_recipient_status_idx" ON "work_questions" USING btree ("company_id","current_recipient_user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_questions_issue_status_created_idx" ON "work_questions" USING btree ("issue_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_questions_source_discussion_created_idx" ON "work_questions" USING btree ("source_discussion_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_questions_workspace_created_idx" ON "work_questions" USING btree ("execution_workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_questions_originating_run_idx" ON "work_questions" USING btree ("originating_run_kind","originating_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_questions_continuation_status_idx" ON "work_questions" USING btree ("continuation_status","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_questions_open_due_at_idx" ON "work_questions" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_questions_producer_invocation_uq" ON "work_questions" USING btree ("company_id","originating_run_kind","originating_run_id","producer_invocation_id") WHERE producer_invocation_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_questions_open_payload_fingerprint_uq" ON "work_questions" USING btree ("company_id","originating_run_kind","originating_run_id","producer_payload_fingerprint") WHERE status = 'open' AND producer_payload_fingerprint IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_questions_source_commander_created_idx" ON "work_questions" USING btree ("source_commander_conversation_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_runtime_trust_rules" ADD CONSTRAINT "agent_runtime_trust_rules_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runtime_trust_rules_run_scope_idx" ON "agent_runtime_trust_rules" USING btree ("run_id","enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_processing_lease_idx" ON "agent_wakeup_requests" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ia_runs_continuation_idempotency_uq" ON "internal_agent_runs" USING btree ("company_id","continuation_idempotency_key") WHERE continuation_idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_company_idempotency_key_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE idempotency_key is not null and reason in ('max_turn_continuation_retry', 'issue_monitor_due', 'finish_successful_run_handoff', 'work_question_continuation');
