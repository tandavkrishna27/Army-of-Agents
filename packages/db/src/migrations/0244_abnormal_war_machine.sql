-- JOB-013 — widen the JOB-005 projection-receipt CHECK to carry the `activity_audit`
-- governance projection (transactional activity/hub audit parity). An `activity_audit`
-- receipt links an `activity_log` row (the transactional audit for one accepted
-- state/control/accounting mutation) to the distributed attempt, written `applied` in
-- the SAME tenant tx as the activity insert. Superset widening: the new CHECK is a
-- strict superset of the prior one, so NO existing row is invalidated. CHECK-only —
-- JOB-013 adds no columns and no indexes.
--
-- C14 hand-edited idempotency guards: drizzle-kit emits a bare DROP/ADD CONSTRAINT.
-- DROP CONSTRAINT IF EXISTS + drop-before-add make both statements replay-safe against
-- a partially- or fully-applied database (mirrors 0242).
ALTER TABLE "job_projection_receipts" DROP CONSTRAINT IF EXISTS "job_projection_receipts_projection_kind_check";--> statement-breakpoint
ALTER TABLE "job_projection_receipts" ADD CONSTRAINT "job_projection_receipts_projection_kind_check" CHECK (projection_kind IN ('attempt_started', 'attempt_terminal', 'product_approval', 'runtime_decision', 'completion_policy', 'authoritative_cost', 'activity_audit'));
