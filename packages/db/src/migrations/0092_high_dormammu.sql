CREATE TABLE IF NOT EXISTS "issue_monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"kind" text DEFAULT 'generic' NOT NULL,
	"scheduled_by" text DEFAULT 'board' NOT NULL,
	"next_check_at" timestamp with time zone NOT NULL,
	"last_triggered_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"clear_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer,
	"timeout_at" timestamp with time zone,
	"notes" text,
	"external_ref" text,
	"recovery_policy" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "retry_of_run_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "scheduled_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "scheduled_retry_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "scheduled_retry_reason" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_comment_status" text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_comment_satisfied_by_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "issue_comment_retry_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_monitors" ADD CONSTRAINT "issue_monitors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_monitors" ADD CONSTRAINT "issue_monitors_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_monitors" ADD CONSTRAINT "issue_monitors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_monitors_company_issue_status_idx" ON "issue_monitors" USING btree ("company_id","issue_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_monitors_company_due_idx" ON "issue_monitors" USING btree ("company_id","status","next_check_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_monitors_company_agent_status_idx" ON "issue_monitors" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_monitors_one_active_per_kind_uq" ON "issue_monitors" USING btree ("company_id","issue_id","kind") WHERE status in ('scheduled', 'triggered');--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_retry_of_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_company_idempotency_key_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE idempotency_key is not null and reason in ('max_turn_continuation_retry', 'issue_monitor_due', 'finish_successful_run_handoff');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_scheduled_retry_idx" ON "heartbeat_runs" USING btree ("company_id","status","scheduled_retry_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_retry_of_run_idx" ON "heartbeat_runs" USING btree ("retry_of_run_id");
