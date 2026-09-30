-- Phase 1 (Task B1, Decision D2): write-behind embedding queue.
--
-- Writers enqueue (text, target_table, target_id, target_column) rows
-- synchronously; a background worker pulls pending rows and generates
-- embeddings via OpenAI, then UPDATEs the target row's vector column.
-- This decouples app insert latency from OpenAI API health.
--
-- IF NOT EXISTS on every CREATE follows the C14 idempotency rule
-- (see packages/db/src/__tests__/migration-idempotency.test.ts) so a
-- partially-applied migration can safely re-run.

CREATE TABLE IF NOT EXISTS "embedding_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_table" text NOT NULL,
	"target_id" uuid NOT NULL,
	"target_column" text NOT NULL,
	"input_text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embedding_queue_status_idx" ON "embedding_queue" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embedding_queue_target_idx" ON "embedding_queue" USING btree ("target_table","target_id");
