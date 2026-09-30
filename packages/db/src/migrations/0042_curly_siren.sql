CREATE TABLE "discussion_annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discussion_entry_id" uuid NOT NULL,
	"content" text NOT NULL,
	"anchor_start" integer,
	"anchor_end" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discussion_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discussion_id" uuid NOT NULL,
	"input_type" text NOT NULL,
	"raw_content" text NOT NULL,
	"title" text,
	"source_info" jsonb,
	"department_id" uuid,
	"project_id" uuid,
	"goal_id" uuid,
	"extraction_status" text DEFAULT 'pending' NOT NULL,
	"extraction_run_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discussion_extracted_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discussion_entry_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"suggested_priority" text,
	"suggested_assignee_id" uuid,
	"suggested_department_id" uuid,
	"suggested_project_id" uuid,
	"suggested_layer" text,
	"suggested_goal_id" uuid,
	"layer" text,
	"priority" text,
	"dedup_action" text,
	"selected_memory_id" uuid,
	"merged_content" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"result_task_id" uuid,
	"result_memory_id" uuid,
	"conflicts_with" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discussions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text,
	"status" text DEFAULT 'active' NOT NULL,
	"scope_type" text,
	"scope_id" uuid,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"pending_item_count" integer DEFAULT 0 NOT NULL,
	"last_entry_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discussion_annotations" ADD CONSTRAINT "discussion_annotations_discussion_entry_id_discussion_entries_id_fk" FOREIGN KEY ("discussion_entry_id") REFERENCES "public"."discussion_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_entries" ADD CONSTRAINT "discussion_entries_discussion_id_discussions_id_fk" FOREIGN KEY ("discussion_id") REFERENCES "public"."discussions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_entries" ADD CONSTRAINT "discussion_entries_department_id_projects_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_entries" ADD CONSTRAINT "discussion_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_entries" ADD CONSTRAINT "discussion_entries_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_extracted_items" ADD CONSTRAINT "discussion_extracted_items_discussion_entry_id_discussion_entries_id_fk" FOREIGN KEY ("discussion_entry_id") REFERENCES "public"."discussion_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_extracted_items" ADD CONSTRAINT "discussion_extracted_items_suggested_department_id_projects_id_fk" FOREIGN KEY ("suggested_department_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_extracted_items" ADD CONSTRAINT "discussion_extracted_items_suggested_project_id_projects_id_fk" FOREIGN KEY ("suggested_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_extracted_items" ADD CONSTRAINT "discussion_extracted_items_suggested_goal_id_goals_id_fk" FOREIGN KEY ("suggested_goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_extracted_items" ADD CONSTRAINT "discussion_extracted_items_selected_memory_id_memory_items_id_fk" FOREIGN KEY ("selected_memory_id") REFERENCES "public"."memory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_extracted_items" ADD CONSTRAINT "discussion_extracted_items_result_task_id_issues_id_fk" FOREIGN KEY ("result_task_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_extracted_items" ADD CONSTRAINT "discussion_extracted_items_result_memory_id_memory_items_id_fk" FOREIGN KEY ("result_memory_id") REFERENCES "public"."memory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discussion_annotations_entry_idx" ON "discussion_annotations" USING btree ("discussion_entry_id");--> statement-breakpoint
CREATE INDEX "discussion_entries_discussion_idx" ON "discussion_entries" USING btree ("discussion_id");--> statement-breakpoint
CREATE INDEX "discussion_entries_extraction_status_idx" ON "discussion_entries" USING btree ("extraction_status");--> statement-breakpoint
CREATE INDEX "discussion_entries_created_at_idx" ON "discussion_entries" USING btree ("discussion_id","created_at");--> statement-breakpoint
CREATE INDEX "discussion_extracted_items_entry_idx" ON "discussion_extracted_items" USING btree ("discussion_entry_id");--> statement-breakpoint
CREATE INDEX "discussion_extracted_items_status_idx" ON "discussion_extracted_items" USING btree ("discussion_entry_id","status");--> statement-breakpoint
CREATE INDEX "discussions_company_idx" ON "discussions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "discussions_company_status_idx" ON "discussions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "discussions_scope_idx" ON "discussions" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "discussions_last_entry_idx" ON "discussions" USING btree ("company_id","last_entry_at");