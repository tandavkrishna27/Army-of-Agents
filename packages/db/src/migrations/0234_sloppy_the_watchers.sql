-- C14 hand-appended idempotency guard; drizzle-kit cannot emit IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS "job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"lease_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"fence_token" text NOT NULL,
	"event_digest" text NOT NULL,
	"event" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_events_org_event_uq" UNIQUE("organization_id","event_id"),
	CONSTRAINT "job_events_org_attempt_seq_uq" UNIQUE("organization_id","attempt_id","sequence"),
	CONSTRAINT "job_events_event_type_check" CHECK (event_type IN (
        'attempt_started', 'log', 'progress', 'usage', 'artifact_prepared',
        'browser_observation', 'browser_approval_requested', 'runtime_decision_requested',
        'service_instance_started', 'service_health', 'service_checkpoint_prepared',
        'service_checkpoint_restored', 'service_graceful_stop_observed',
        'service_instance_stopped', 'service_instance_lost', 'service_provider_interrupted',
        'service_provider_resumed', 'network_denied', 'terminal'
      )),
	CONSTRAINT "job_events_digest_check" CHECK (event_digest ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "job_events_sequence_check" CHECK (sequence > 0),
	CONSTRAINT "job_events_attempt_number_check" CHECK (attempt_number > 0)
);
--> statement-breakpoint
-- C14 hand-appended idempotency guard; drizzle-kit cannot emit IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS "job_projection_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"projection_kind" text NOT NULL,
	"source_identity" text NOT NULL,
	"source_digest" text NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"source_fence" text NOT NULL,
	"status" text NOT NULL,
	"target_aggregate_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "job_projection_receipts_identity_uq" UNIQUE("organization_id","company_id","projection_kind","source_identity"),
	CONSTRAINT "job_projection_receipts_projection_kind_check" CHECK (projection_kind IN ('attempt_started', 'attempt_terminal')),
	CONSTRAINT "job_projection_receipts_status_check" CHECK (status IN ('pending', 'applied')),
	CONSTRAINT "job_projection_receipts_applied_check" CHECK ((status = 'applied' AND applied_at IS NOT NULL) OR (status = 'pending' AND applied_at IS NULL)),
	CONSTRAINT "job_projection_receipts_digest_check" CHECK (source_digest ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
-- C14 hand-appended idempotency guards; drizzle-kit cannot emit replay-safe ADD CONSTRAINT.
DO $$ BEGIN ALTER TABLE "job_events" ADD CONSTRAINT "job_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_events" ADD CONSTRAINT "job_events_attempt_fk" FOREIGN KEY ("organization_id","company_id","job_id","attempt_id") REFERENCES "public"."job_attempts"("organization_id","company_id","job_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_events" ADD CONSTRAINT "job_events_lease_fk" FOREIGN KEY ("organization_id","company_id","job_id","attempt_id","lease_id") REFERENCES "public"."leases"("organization_id","company_id","job_id","attempt_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_projection_receipts" ADD CONSTRAINT "job_projection_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_projection_receipts" ADD CONSTRAINT "job_projection_receipts_attempt_fk" FOREIGN KEY ("organization_id","company_id","job_id","attempt_id") REFERENCES "public"."job_attempts"("organization_id","company_id","job_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
-- C14 hand-appended idempotency guards; drizzle-kit cannot emit IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS "job_events_attempt_idx" ON "job_events" USING btree ("organization_id","attempt_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_projection_receipts_attempt_idx" ON "job_projection_receipts" USING btree ("organization_id","company_id","job_id","attempt_id");
