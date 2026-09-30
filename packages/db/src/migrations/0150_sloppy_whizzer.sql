ALTER TABLE "embedding_queue" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "embedding_queue" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embedding_queue_pending_due_idx" ON "embedding_queue" USING btree ("status","next_retry_at");