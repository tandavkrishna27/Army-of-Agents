-- Phase G2 (T26): notification delivery retry queue.
--
-- Tracks per-row delivery state so a transient DB hiccup doesn't drop a
-- notification on the floor. The retry worker
-- (server/src/services/notification-retry-worker.ts) drains rows where
-- delivery_error IS NOT NULL AND delivered_at IS NULL AND
-- delivery_attempts < MAX_DELIVERY_ATTEMPTS.
--
-- The partial index makes that sweep O(failure-count) rather than a
-- full-table scan, and stays empty in the happy path (typical workload
-- has zero retry-eligible rows).
--
-- IF NOT EXISTS on the index follows the C14 idempotency rule
-- (see packages/db/src/__tests__/migration-idempotency.test.ts).

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "delivery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "delivery_error" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_retry_queue_idx" ON "notifications" USING btree ("delivery_attempts","delivery_error") WHERE delivery_error IS NOT NULL AND delivered_at IS NULL;