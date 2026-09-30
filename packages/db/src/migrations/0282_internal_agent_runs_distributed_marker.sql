-- MIG-006 — three nullable columns on internal_agent_runs mirroring heartbeat_runs' CLI-006
-- distributed-execution handoff marker. Everything here is `db:generate` output apart from the
-- C14 class (a) `IF NOT EXISTS` guards, which drizzle-kit cannot emit and which this file needs
-- for the same measured reason 0275/0278 state: migration-idempotency's static check matches only
-- /^\s*CREATE (UNIQUE )?(TABLE|INDEX)\s+"/, so a bare `ADD COLUMN` is covered by NO static check
-- and a re-apply raises 42701 — the delete-max-record-then-re-apply path that
-- migration-readiness.integration.test.ts exercises directly. The guards do NOT change the
-- snapshot, so the schema-migration drift gate stays clean.
ALTER TABLE "internal_agent_runs" ADD COLUMN IF NOT EXISTS "execution_owner" text;--> statement-breakpoint
ALTER TABLE "internal_agent_runs" ADD COLUMN IF NOT EXISTS "distributed_job_id" uuid;--> statement-breakpoint
ALTER TABLE "internal_agent_runs" ADD COLUMN IF NOT EXISTS "distributed_attempt_id" uuid;