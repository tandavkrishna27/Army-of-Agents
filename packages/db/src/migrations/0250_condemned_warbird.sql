-- DAT-004 (C14): drizzle-kit cannot emit idempotency guards, so the generated
-- ADD COLUMN statements below are hand-augmented with IF NOT EXISTS. Every
-- statement is additive + nullable (empty table, no backfill) and idempotent;
-- schema DDL is otherwise db:generate output (Critical Rule #1 / Decision #19).
-- These twelve nullable columns carry the RICH secret-handle model (non-secret
-- binding: ref_kind/ref_id/owner/materialization/use_policy/destination/
-- bound_target_generation + audit-as-columns: status/last_resolved_at/
-- resolve_count/revoked_at). NO secret value column exists — the resolver maps an
-- opaque handle onto a legacy value store and resolves the value BEHIND the fence.
-- They widen job_secret_handles, which inherits the whole-table aoa_app grant + RLS
-- + policy (0211) — no keystone reconciliation (DAT-004-D1).
ALTER TABLE "job_secret_handles" ADD COLUMN IF NOT EXISTS "ref_kind" text;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD COLUMN IF NOT EXISTS "ref_id" text;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD COLUMN IF NOT EXISTS "owner_principal_kind" text;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD COLUMN IF NOT EXISTS "owner_principal_id" text;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD COLUMN IF NOT EXISTS "materialization" text;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD COLUMN IF NOT EXISTS "use_policy" text;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD COLUMN IF NOT EXISTS "destination" text;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD COLUMN IF NOT EXISTS "bound_target_generation" integer;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD COLUMN IF NOT EXISTS "status" text;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD COLUMN IF NOT EXISTS "last_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD COLUMN IF NOT EXISTS "resolve_count" integer;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
