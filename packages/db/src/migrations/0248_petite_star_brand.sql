-- DAT-002 (C14): drizzle-kit cannot emit idempotency guards, so the generated
-- ADD COLUMN / CREATE INDEX statements below are hand-augmented with IF NOT EXISTS.
-- Every statement is additive + nullable (empty table, no backfill) and idempotent;
-- schema DDL is otherwise db:generate output (Critical Rule #1 / Decision #19).
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "object_key" text;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "sha256" text;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "content_type" text;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "kind" text;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "sensitivity" text;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "retention" text;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "attempt" integer;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "lease_id" uuid;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "fence_token" text;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "version_number" integer;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "status" text;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "committed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_artifacts_committed_identity_uidx" ON "job_artifacts" USING btree ("organization_id","job_id","attempt","identifier") WHERE status = 'committed';
