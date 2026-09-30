CREATE TABLE IF NOT EXISTS "comment_wakeup_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"wakeup" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_token" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"next_retry_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discussion_mention_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"discussion_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"mentions" jsonb NOT NULL,
	"hop_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_token" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "upload_namespace" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "composer_validated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "discussion_entries" ADD COLUMN IF NOT EXISTS "client_submission_id" text;--> statement-breakpoint
ALTER TABLE "internal_agent_messages" ADD COLUMN IF NOT EXISTS "client_submission_id" text;--> statement-breakpoint
ALTER TABLE "internal_agent_messages" ADD COLUMN IF NOT EXISTS "reply_to_user_message_id" uuid;--> statement-breakpoint
ALTER TABLE "internal_agent_messages" ADD COLUMN IF NOT EXISTS "turn_status" text;--> statement-breakpoint
ALTER TABLE "internal_agent_messages" ADD COLUMN IF NOT EXISTS "turn_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "internal_agent_messages" ADD COLUMN IF NOT EXISTS "turn_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "client_submission_id" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "control_effects_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "wakeups_enqueued_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comment_wakeup_outbox_pending_due_idx" ON "comment_wakeup_outbox" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "comment_wakeup_outbox_comment_target_uniq" ON "comment_wakeup_outbox" USING btree ("comment_id","target_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discussion_mention_outbox_pending_due_idx" ON "discussion_mention_outbox" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discussion_mention_outbox_entry_idx" ON "discussion_mention_outbox" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_comment_wakeup_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE idempotency_key LIKE 'comment-wakeup:%';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discussion_entries_client_submission_uq" ON "discussion_entries" USING btree ("discussion_id","client_submission_id") WHERE client_submission_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ia_messages_client_submission_uq" ON "internal_agent_messages" USING btree ("conversation_id","client_submission_id") WHERE client_submission_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ia_messages_reply_to_user_idx" ON "internal_agent_messages" USING btree ("reply_to_user_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comments_client_submission_uq" ON "issue_comments" USING btree ("company_id","issue_id","client_submission_id") WHERE client_submission_id IS NOT NULL;