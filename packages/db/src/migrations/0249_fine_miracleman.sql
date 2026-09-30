-- DAT-003 (C14): drizzle-kit cannot emit idempotency guards, so the generated
-- ADD COLUMN statements below are hand-augmented with IF NOT EXISTS. Every
-- statement is additive + nullable (empty table, no backfill) and idempotent;
-- schema DDL is otherwise db:generate output (Critical Rule #1 / Decision #19).
-- These three nullable columns carry the workspace-patch apply/review disposition
-- (base/result manifest digests + apply_status); they widen job_artifacts, which
-- inherits the whole-table aoa_app grant + RLS + policy (no keystone reconciliation).
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "base_manifest_hash" text;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "result_manifest_hash" text;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD COLUMN IF NOT EXISTS "apply_status" text;
