-- BRW-004 / E8-F002 — the distributed (agent-less, run-less) runtime decision.
--
-- C14 hand-appended idempotency guard. Everything below is `db:generate` output — two
-- `DROP NOT NULL`s and the `ADD CONSTRAINT` — EXCEPT the single
-- `DROP CONSTRAINT IF EXISTS` line, which drizzle-kit cannot emit and which is the
-- narrow exception's class (a). Same pattern and same reason as `0264_public_patch.sql`.
--
-- ★★★ THE GUARD IS NECESSARY, NOT DEFENSIVE, and CI proved it rather than a reviewer:
-- `migration-readiness.integration.test.ts`'s third case deletes the LAST row from
-- `drizzle.__drizzle_migrations` and re-runs the privileged migration job, asserting the
-- pending tail re-applies IDEMPOTENTLY. `ALTER COLUMN ... DROP NOT NULL` is idempotent;
-- `ADD CONSTRAINT` is NOT — Postgres raises 42710 `constraint ... already exists`. This
-- migration is the tail, so without the guard a re-apply fails and the app never recovers
-- to READY. Observed as `verify (2)` red on PR #356, then reproduced locally against real
-- Postgres before the fix and re-run green after it.
--
-- It is the same class as the ADD COLUMN trap this programme has already paid for once:
-- "generated DDL" and "re-appliable DDL" are not the same property, and only the second
-- one is what the migration job actually requires.
ALTER TABLE "agent_runtime_decisions" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_decisions" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_decisions" DROP CONSTRAINT IF EXISTS "agent_runtime_decisions_legacy_binding_all_or_nothing";--> statement-breakpoint
ALTER TABLE "agent_runtime_decisions" ADD CONSTRAINT "agent_runtime_decisions_legacy_binding_all_or_nothing" CHECK ((agent_id is null) = (run_id is null));
