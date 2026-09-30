-- Process tracking columns (Paperclip 0055 equivalent)
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_group_id" integer;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_pid" integer;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_started_at" timestamp with time zone;

-- Output tracking (Paperclip 0070)
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_seq" integer DEFAULT 0 NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_stream" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_output_bytes" bigint;

-- Liveness columns (Paperclip 0069)
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "liveness_state" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "liveness_reason" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "continuation_attempt" integer DEFAULT 0 NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_useful_action_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "next_action" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_snapshot" jsonb;

-- Indexes
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_last_output_idx"
  ON "heartbeat_runs" ("company_id", "status", "last_output_at");
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_status_process_started_idx"
  ON "heartbeat_runs" ("company_id", "status", "process_started_at");
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_liveness_idx"
  ON "heartbeat_runs" ("company_id", "liveness_state", "created_at");

-- Watchdog decisions table
CREATE TABLE IF NOT EXISTS "heartbeat_run_watchdog_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "evaluation_issue_id" uuid,
  "decision" text NOT NULL,
  "snoozed_until" timestamp with time zone,
  "reason" text,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_by_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "heartbeat_run_watchdog_decisions"
  ADD CONSTRAINT "hb_watchdog_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION;
ALTER TABLE "heartbeat_run_watchdog_decisions"
  ADD CONSTRAINT "hb_watchdog_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "heartbeat_runs"("id") ON DELETE CASCADE;
ALTER TABLE "heartbeat_run_watchdog_decisions"
  ADD CONSTRAINT "hb_watchdog_evaluation_issue_fk" FOREIGN KEY ("evaluation_issue_id") REFERENCES "issues"("id") ON DELETE SET NULL;
ALTER TABLE "heartbeat_run_watchdog_decisions"
  ADD CONSTRAINT "hb_watchdog_created_by_agent_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
ALTER TABLE "heartbeat_run_watchdog_decisions"
  ADD CONSTRAINT "hb_watchdog_created_by_run_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "hb_watchdog_company_run_created_idx"
  ON "heartbeat_run_watchdog_decisions" ("company_id", "run_id", "created_at");
CREATE INDEX IF NOT EXISTS "hb_watchdog_company_run_snooze_idx"
  ON "heartbeat_run_watchdog_decisions" ("company_id", "run_id", "snoozed_until");
