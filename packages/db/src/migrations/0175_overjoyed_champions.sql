CREATE TABLE IF NOT EXISTS "braindump_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"content" text NOT NULL,
	"content_length" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"librarian_agent_id" uuid,
	"run_id" uuid,
	"proposed_memory_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_reason" text,
	"dispatch_started_at" timestamp with time zone,
	"dispatch_completed_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "braindump_captures" ADD CONSTRAINT "braindump_captures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "braindump_captures" ADD CONSTRAINT "braindump_captures_department_id_projects_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "braindump_captures" ADD CONSTRAINT "braindump_captures_librarian_agent_id_agents_id_fk" FOREIGN KEY ("librarian_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "braindump_captures" ADD CONSTRAINT "braindump_captures_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "braindump_captures_idempotency_uq" ON "braindump_captures" USING btree ("company_id","department_id","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "braindump_captures_company_department_status_idx" ON "braindump_captures" USING btree ("company_id","department_id","status");