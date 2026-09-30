CREATE TABLE IF NOT EXISTS "discussion_entry_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discussion_entry_id" uuid NOT NULL,
	"asset_id" uuid,
	"artifact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scope_item_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_item_id" uuid NOT NULL,
	"blocked_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "thread_inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"raw_content" text NOT NULL,
	"origin_source" text,
	"origin_medium" text,
	"router_confidence" double precision,
	"router_decision" text,
	"suggested_thread_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "thread_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"from_thread_id" uuid NOT NULL,
	"to_thread_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "thread_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"role" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "thread_plan_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"step_order" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"collapsed" boolean DEFAULT false NOT NULL,
	"linked_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discussion_entries" ADD COLUMN "parent_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "discussion_entries" ADD COLUMN "author_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "discussion_extracted_items" ADD COLUMN "assignee_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "discussion_extracted_items" ADD COLUMN "assignee_user_id" text;--> statement-breakpoint
ALTER TABLE "discussion_extracted_items" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "origin_source" text;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "origin_medium" text;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "intent" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "phase" text DEFAULT 'discuss' NOT NULL;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "visibility" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "autonomy_level" integer;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "subtype" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "forked_from_id" uuid;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "summary_text" text;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "summary_next" text;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "summary_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "entry_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_thread_visibility" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "discussion_entry_attachments" ADD CONSTRAINT "discussion_entry_attachments_discussion_entry_id_discussion_entries_id_fk" FOREIGN KEY ("discussion_entry_id") REFERENCES "public"."discussion_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_entry_attachments" ADD CONSTRAINT "discussion_entry_attachments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_entry_attachments" ADD CONSTRAINT "discussion_entry_attachments_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_item_dependencies" ADD CONSTRAINT "scope_item_dependencies_blocker_item_id_discussion_extracted_items_id_fk" FOREIGN KEY ("blocker_item_id") REFERENCES "public"."discussion_extracted_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_item_dependencies" ADD CONSTRAINT "scope_item_dependencies_blocked_item_id_discussion_extracted_items_id_fk" FOREIGN KEY ("blocked_item_id") REFERENCES "public"."discussion_extracted_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_inbox_items" ADD CONSTRAINT "thread_inbox_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_inbox_items" ADD CONSTRAINT "thread_inbox_items_suggested_thread_id_discussions_id_fk" FOREIGN KEY ("suggested_thread_id") REFERENCES "public"."discussions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_links" ADD CONSTRAINT "thread_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_links" ADD CONSTRAINT "thread_links_from_thread_id_discussions_id_fk" FOREIGN KEY ("from_thread_id") REFERENCES "public"."discussions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_links" ADD CONSTRAINT "thread_links_to_thread_id_discussions_id_fk" FOREIGN KEY ("to_thread_id") REFERENCES "public"."discussions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_participants" ADD CONSTRAINT "thread_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_participants" ADD CONSTRAINT "thread_participants_thread_id_discussions_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."discussions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_plan_steps" ADD CONSTRAINT "thread_plan_steps_thread_id_discussions_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."discussions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_plan_steps" ADD CONSTRAINT "thread_plan_steps_linked_item_id_discussion_extracted_items_id_fk" FOREIGN KEY ("linked_item_id") REFERENCES "public"."discussion_extracted_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discussion_entry_attachments_entry_idx" ON "discussion_entry_attachments" USING btree ("discussion_entry_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scope_item_dependencies_blocker_idx" ON "scope_item_dependencies" USING btree ("blocker_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scope_item_dependencies_blocked_idx" ON "scope_item_dependencies" USING btree ("blocked_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_inbox_items_company_status_idx" ON "thread_inbox_items" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_links_from_idx" ON "thread_links" USING btree ("from_thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_links_to_idx" ON "thread_links" USING btree ("to_thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_participants_thread_idx" ON "thread_participants" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_participants_principal_idx" ON "thread_participants" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_participants_company_idx" ON "thread_participants" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "thread_participants_unique" ON "thread_participants" USING btree ("thread_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_plan_steps_thread_idx" ON "thread_plan_steps" USING btree ("thread_id");--> statement-breakpoint
ALTER TABLE "discussion_entries" ADD CONSTRAINT "discussion_entries_parent_entry_id_discussion_entries_id_fk" FOREIGN KEY ("parent_entry_id") REFERENCES "public"."discussion_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_entries" ADD CONSTRAINT "discussion_entries_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_extracted_items" ADD CONSTRAINT "discussion_extracted_items_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_extracted_items" ADD CONSTRAINT "discussion_extracted_items_department_id_projects_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_forked_from_id_discussions_id_fk" FOREIGN KEY ("forked_from_id") REFERENCES "public"."discussions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_merged_into_id_discussions_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."discussions"("id") ON DELETE set null ON UPDATE no action;