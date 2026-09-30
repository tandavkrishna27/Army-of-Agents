CREATE TABLE IF NOT EXISTS "thread_orchestration_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"last_processed_entry_id" uuid,
	"run_epoch" integer DEFAULT 0 NOT NULL,
	"pending_run" boolean DEFAULT false NOT NULL,
	"hop_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_orchestration_state_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
ALTER TABLE "thread_orchestration_state" ADD CONSTRAINT "thread_orchestration_state_thread_id_discussions_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."discussions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_orchestration_state" ADD CONSTRAINT "thread_orchestration_state_last_processed_entry_id_discussion_entries_id_fk" FOREIGN KEY ("last_processed_entry_id") REFERENCES "public"."discussion_entries"("id") ON DELETE set null ON UPDATE no action;