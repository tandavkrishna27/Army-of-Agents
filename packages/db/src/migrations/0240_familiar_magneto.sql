-- JOB-011 — widen the JOB-005 projection-receipt + JOB-006 control-command surfaces
-- to carry SERVER-authored governance projections (product approvals / runtime
-- decisions / completion policy) and their E1 result controls. Additive + idempotent:
-- the new column is nullable (JOB-005 rows stay valid) and both CHECK widenings are
-- supersets of the prior constraint, so no existing row is invalidated.
--
-- C14 hand-edited idempotency guards: drizzle-kit emits bare DROP/ADD CONSTRAINT and
-- ADD COLUMN. DROP CONSTRAINT IF EXISTS + ADD COLUMN IF NOT EXISTS + drop-before-add
-- make every statement replay-safe against a partially- or fully-applied database.
ALTER TABLE "job_control_commands" DROP CONSTRAINT IF EXISTS "job_control_commands_kind_check";--> statement-breakpoint
ALTER TABLE "job_projection_receipts" DROP CONSTRAINT IF EXISTS "job_projection_receipts_projection_kind_check";--> statement-breakpoint
ALTER TABLE "job_projection_receipts" ADD COLUMN IF NOT EXISTS "aggregate_kind" text;--> statement-breakpoint
ALTER TABLE "job_control_commands" ADD CONSTRAINT "job_control_commands_kind_check" CHECK (command_kind IN ('cancel', 'drain', 'graceful_stop', 'product_approval_result', 'runtime_decision_result'));--> statement-breakpoint
ALTER TABLE "job_projection_receipts" ADD CONSTRAINT "job_projection_receipts_projection_kind_check" CHECK (projection_kind IN ('attempt_started', 'attempt_terminal', 'product_approval', 'runtime_decision', 'completion_policy'));
