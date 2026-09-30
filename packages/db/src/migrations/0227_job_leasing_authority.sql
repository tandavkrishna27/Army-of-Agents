-- C14 hand-appended idempotency guard; drizzle-kit cannot emit IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS "worker_operation_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"worker_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_authority_key" text NOT NULL,
	"target_generation" integer NOT NULL,
	"profile_hash" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"semantic_digest" text NOT NULL,
	"outcome" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_operation_receipts_scope_key_uq" UNIQUE("organization_id","worker_id","target_id","target_generation","profile_hash","operation","idempotency_key"),
	CONSTRAINT "worker_operation_receipts_operation_check" CHECK (operation IN ('lease_ack', 'lease_renew')),
	CONSTRAINT "worker_operation_receipts_digest_check" CHECK (semantic_digest ~ '^[0-9a-f]{64}$' AND profile_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "worker_operation_receipts_generation_check" CHECK (target_generation > 0),
	CONSTRAINT "worker_operation_receipts_retention_check" CHECK (expires_at > created_at)
);
--> statement-breakpoint
-- C14 hand-appended idempotency guards; drizzle-kit cannot emit IF NOT EXISTS for columns.
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "job_id" uuid;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "attempt_number" integer;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "worker_id" uuid;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "target_id" uuid;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "target_authority_key" text;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "target_generation" integer;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "profile_hash" text;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "provider_constraint_hash" text;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "ack_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN IF NOT EXISTS "activated_at" timestamp with time zone;--> statement-breakpoint
-- C14 hand-appended constraint guards; drizzle-kit cannot emit replay-safe ADD CONSTRAINT.
DO $$ BEGIN ALTER TABLE "leases" ADD CONSTRAINT "leases_org_company_job_attempt_id_uq" UNIQUE("organization_id","company_id","job_id","attempt_id","id"); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_lease_fk" FOREIGN KEY ("organization_id","company_id","job_id","attempt_id","lease_id") REFERENCES "public"."leases"("organization_id","company_id","job_id","attempt_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_worker_fk" FOREIGN KEY ("organization_id","worker_id") REFERENCES "public"."workers"("organization_id","id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worker_operation_receipts" ADD CONSTRAINT "worker_operation_receipts_target_fk" FOREIGN KEY ("target_authority_key","target_id") REFERENCES "public"."execution_targets"("target_authority_key","id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_operation_receipts_expiry_idx" ON "worker_operation_receipts" USING btree ("organization_id","expires_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_operation_receipts_lease_idx" ON "worker_operation_receipts" USING btree ("organization_id","lease_id");--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "leases" ADD CONSTRAINT "leases_org_company_job_attempt_fk" FOREIGN KEY ("organization_id","company_id","job_id","attempt_id") REFERENCES "public"."job_attempts"("organization_id","company_id","job_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "leases" ADD CONSTRAINT "leases_org_worker_fk" FOREIGN KEY ("organization_id","worker_id") REFERENCES "public"."workers"("organization_id","id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "leases" ADD CONSTRAINT "leases_target_authority_fk" FOREIGN KEY ("target_authority_key","target_id") REFERENCES "public"."execution_targets"("target_authority_key","id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "leases" ADD CONSTRAINT "leases_authority_atomic_check" CHECK ((
        company_id IS NULL AND job_id IS NULL AND attempt_number IS NULL AND
        worker_id IS NULL AND target_id IS NULL AND target_authority_key IS NULL AND
        target_generation IS NULL AND profile_hash IS NULL AND
        provider_constraint_hash IS NULL AND ack_deadline IS NULL AND expires_at IS NULL
      ) OR (
        company_id IS NOT NULL AND job_id IS NOT NULL AND attempt_number > 0 AND
        worker_id IS NOT NULL AND target_id IS NOT NULL AND target_authority_key IS NOT NULL AND
        target_generation > 0 AND profile_hash ~ '^[0-9a-f]{64}$' AND
        provider_constraint_hash ~ '^[0-9a-f]{64}$' AND
        ack_deadline IS NOT NULL AND expires_at IS NOT NULL AND ack_deadline < expires_at
      )); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
-- C14 permitted idempotent data backfill for E2-valid active leases before leases_activation_check.
UPDATE leases SET activated_at = COALESCE(updated_at, created_at) WHERE status = 'active' AND activated_at IS NULL;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "leases" ADD CONSTRAINT "leases_activation_check" CHECK ((status = 'active' AND activated_at IS NOT NULL) OR (status = 'offered' AND activated_at IS NULL) OR status IN ('released', 'expired', 'revoked')); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
