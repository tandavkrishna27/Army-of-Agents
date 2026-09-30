CREATE TABLE IF NOT EXISTS "routine_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "latest_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_revisions_routine_created_at_idx" ON "routine_revisions" USING btree ("routine_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_revisions_company_idx" ON "routine_revisions" USING btree ("company_id");