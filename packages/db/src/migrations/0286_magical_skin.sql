-- drizzle-kit generated this ADD COLUMN; IF NOT EXISTS is the C14 idempotency guard.
ALTER TABLE "internal_agent_messages" ADD COLUMN IF NOT EXISTS "submission_payload_hash" text;
