-- C14 idempotency guards, hand-appended after `pnpm db:generate` (CLAUDE.md rule 1, the
-- narrow exception; precedent: 36 existing migrations including 0061 and 0189). drizzle-kit
-- cannot emit `IF NOT EXISTS` on ADD COLUMN, and this migration MUST be re-appliable.
--
-- ★ WHY, MEASURED: `migration-readiness.integration.test.ts` deletes the LAST ledger row and
-- has the privileged migrate job re-apply the pending tail, asserting it succeeds. A bare
-- `ADD COLUMN` raises 42701 on the second application, so the job returns ok:false. 0270 --
-- the previous tail -- was all CREATE OR REPLACE / DROP IF EXISTS / REVOKE / GRANT and was
-- idempotent by construction; this is the first plain ADD COLUMN to land in that slot, which
-- is why it is the first to fail that test. The schema DDL itself is still db:generate output;
-- only the guards are hand-added.
ALTER TABLE "legacy_resource_reconciliation" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "legacy_resource_reconciliation" ADD COLUMN IF NOT EXISTS "resolved_by" text;--> statement-breakpoint
ALTER TABLE "legacy_resource_reconciliation" ADD COLUMN IF NOT EXISTS "resolution_reason" text;