CREATE TABLE IF NOT EXISTS "job_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_outbox_attempt_kind_uq" UNIQUE("organization_id","attempt_id","kind"),
	CONSTRAINT "job_outbox_status_check" CHECK (status IN ('pending', 'claimed', 'delivered', 'retry', 'dead_letter')),
	CONSTRAINT "job_outbox_kind_check" CHECK (kind IN ('attempt_ready'))
);
--> statement-breakpoint
ALTER TABLE "job_attempts" DROP CONSTRAINT IF EXISTS "job_attempts_org_job_fk";
--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "workload_type" text DEFAULT 'batch' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "authenticated_principal_kind" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "authenticated_principal_id" text DEFAULT 'legacy-kernel' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "authenticated_source_kind" text DEFAULT 'legacy_kernel' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "authenticated_source_identity" text DEFAULT 'legacy-kernel' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "idempotency_key" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "command_digest" text DEFAULT 'legacy-kernel' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "source_kind" text DEFAULT 'legacy_kernel' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "source_identity" text DEFAULT 'legacy-kernel' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "source_intent" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "requester_principal_kind" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "requester_principal_id" text DEFAULT 'legacy-kernel' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "executor_principal_kind" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "executor_principal_id" text DEFAULT 'legacy-kernel' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "input" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "input_hash" text DEFAULT 'legacy-kernel' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "policy_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "policy_hash" text DEFAULT 'legacy-kernel' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "requirements" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "placement_request" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Data-only rolling backfill (AGENTS narrow exception): idempotent and derived
-- from the already tenant-bound parent job before 0217 applies NOT NULL.
UPDATE "job_attempts" AS attempt
SET "company_id" = job."company_id"
FROM "jobs" AS job
WHERE attempt."organization_id" = job."organization_id"
  AND attempt."job_id" = job."id"
  AND attempt."company_id" IS NULL;--> statement-breakpoint
-- C14: drizzle-kit emits unguarded constraints; duplicate-object guards make replay safe.
DO $$ BEGIN ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_company_id_uq" UNIQUE("organization_id","company_id","id"); EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "jobs" ADD CONSTRAINT "jobs_submission_idempotency_uq" UNIQUE("organization_id","company_id","authenticated_principal_kind","authenticated_principal_id","authenticated_source_kind","authenticated_source_identity","idempotency_key"); EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_org_company_id_uq" UNIQUE("organization_id","company_id","id"); EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_org_company_job_id_uq" UNIQUE("organization_id","company_id","job_id","id"); EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_number_uq" UNIQUE("organization_id","company_id","job_id","attempt_number"); EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_org_job_fk" FOREIGN KEY ("organization_id","company_id","job_id") REFERENCES "public"."jobs"("organization_id","company_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_outbox" ADD CONSTRAINT "job_outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_outbox" ADD CONSTRAINT "job_outbox_attempt_fk" FOREIGN KEY ("organization_id","company_id","job_id","attempt_id") REFERENCES "public"."job_attempts"("organization_id","company_id","job_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_outbox_claim_idx" ON "job_outbox" USING btree ("organization_id","status","available_at","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_outbox_organization_job_idx" ON "job_outbox" USING btree ("organization_id","job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_claim_idx" ON "jobs" USING btree ("organization_id","status","available_at","priority","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_operator_list_idx" ON "jobs" USING btree ("organization_id","company_id","created_at","id");
