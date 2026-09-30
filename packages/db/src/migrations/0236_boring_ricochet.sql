-- C14 hand-appended idempotency guard; drizzle-kit cannot emit IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS "job_control_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"lease_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"command_seq" integer NOT NULL,
	"command_kind" text NOT NULL,
	"fence_token" text NOT NULL,
	"reason" text,
	"graceful" boolean,
	"deadline" timestamp with time zone,
	"command" jsonb NOT NULL,
	"ack_status" text,
	"ack_observed_at" timestamp with time zone,
	"ack_detail" text,
	"acked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_control_commands_org_lease_command_uq" UNIQUE("organization_id","lease_id","command_id"),
	CONSTRAINT "job_control_commands_org_lease_seq_uq" UNIQUE("organization_id","lease_id","command_seq"),
	CONSTRAINT "job_control_commands_kind_check" CHECK (command_kind IN ('cancel', 'drain', 'graceful_stop')),
	CONSTRAINT "job_control_commands_ack_status_check" CHECK (ack_status IS NULL OR ack_status IN ('accepted', 'completed', 'rejected', 'stale')),
	CONSTRAINT "job_control_commands_seq_check" CHECK (command_seq > 0),
	CONSTRAINT "job_control_commands_attempt_number_check" CHECK (attempt_number > 0)
);
--> statement-breakpoint
-- C14 hand-appended idempotency guards; drizzle-kit cannot emit ADD COLUMN IF NOT EXISTS.
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "backoff_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "dead_letter_reason" text;--> statement-breakpoint
-- C14 hand-appended idempotency guards; drizzle-kit cannot emit replay-safe ADD CONSTRAINT.
DO $$ BEGIN ALTER TABLE "job_control_commands" ADD CONSTRAINT "job_control_commands_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_control_commands" ADD CONSTRAINT "job_control_commands_attempt_fk" FOREIGN KEY ("organization_id","company_id","job_id","attempt_id") REFERENCES "public"."job_attempts"("organization_id","company_id","job_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_control_commands" ADD CONSTRAINT "job_control_commands_lease_fk" FOREIGN KEY ("organization_id","company_id","job_id","attempt_id","lease_id") REFERENCES "public"."leases"("organization_id","company_id","job_id","attempt_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
-- C14 hand-appended idempotency guard; drizzle-kit cannot emit IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS "job_control_commands_lease_seq_idx" ON "job_control_commands" USING btree ("organization_id","lease_id","command_seq");
