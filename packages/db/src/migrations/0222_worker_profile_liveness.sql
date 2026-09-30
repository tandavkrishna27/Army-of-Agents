-- C14 hand-appended idempotency guard; drizzle-kit cannot emit IF NOT EXISTS here.
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
