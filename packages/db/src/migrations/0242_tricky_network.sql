-- JOB-012 — widen the cost/authoritative-cost surface: add the server-owned
-- authoritative-cost provenance columns to `cost_events` (source idempotency key +
-- rate id/version + rounding mode) with an at-most-once partial unique, and widen the
-- JOB-005 projection-receipt CHECK to carry the `authoritative_cost` governance
-- projection. Additive + idempotent: every new column is nullable (legacy cost_events
-- rows stay valid), the partial unique is exempt for legacy NULL rows, and the CHECK
-- widening is a superset of the prior constraint, so no existing row is invalidated.
--
-- C14 hand-edited idempotency guards: drizzle-kit emits bare DROP/ADD CONSTRAINT,
-- ADD COLUMN, and CREATE UNIQUE INDEX. DROP CONSTRAINT IF EXISTS + ADD COLUMN IF NOT
-- EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS + drop-before-add make every statement
-- replay-safe against a partially- or fully-applied database (mirrors 0240).
ALTER TABLE "job_projection_receipts" DROP CONSTRAINT IF EXISTS "job_projection_receipts_projection_kind_check";--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "source_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "rate_id" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "rate_version" integer;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "rounding_mode" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_events_source_idem_uq" ON "cost_events" USING btree ("company_id","source_idempotency_key") WHERE "cost_events"."source_idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "job_projection_receipts" ADD CONSTRAINT "job_projection_receipts_projection_kind_check" CHECK (projection_kind IN ('attempt_started', 'attempt_terminal', 'product_approval', 'runtime_decision', 'completion_policy', 'authoritative_cost'));
