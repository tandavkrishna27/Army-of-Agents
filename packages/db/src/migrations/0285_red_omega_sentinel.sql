-- drizzle-kit generated these ADD COLUMN statements; IF NOT EXISTS is the C14 idempotency guard.
ALTER TABLE "universe_drafts" ADD COLUMN IF NOT EXISTS "payload" jsonb;--> statement-breakpoint
ALTER TABLE "universe_drafts" ADD COLUMN IF NOT EXISTS "pending_attempt" jsonb;
