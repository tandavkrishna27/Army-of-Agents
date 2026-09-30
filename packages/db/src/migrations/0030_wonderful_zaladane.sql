CREATE TABLE "brief_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brief_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"suggested_assignee_id" uuid,
	"suggested_priority" text,
	"suggested_department_id" uuid,
	"suggested_project_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"result_task_id" uuid,
	"result_memory_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"debrief_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"department_id" uuid,
	"project_id" uuid,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debriefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text,
	"input_type" text NOT NULL,
	"raw_content" text NOT NULL,
	"artifact_url" text,
	"department_id" uuid,
	"project_id" uuid,
	"source_info" jsonb,
	"status" text DEFAULT 'processing' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brief_items" ADD CONSTRAINT "brief_items_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_items" ADD CONSTRAINT "brief_items_suggested_department_id_projects_id_fk" FOREIGN KEY ("suggested_department_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_items" ADD CONSTRAINT "brief_items_suggested_project_id_projects_id_fk" FOREIGN KEY ("suggested_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_items" ADD CONSTRAINT "brief_items_result_task_id_issues_id_fk" FOREIGN KEY ("result_task_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_items" ADD CONSTRAINT "brief_items_result_memory_id_memory_items_id_fk" FOREIGN KEY ("result_memory_id") REFERENCES "public"."memory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_debrief_id_debriefs_id_fk" FOREIGN KEY ("debrief_id") REFERENCES "public"."debriefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_department_id_projects_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debriefs" ADD CONSTRAINT "debriefs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debriefs" ADD CONSTRAINT "debriefs_department_id_projects_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debriefs" ADD CONSTRAINT "debriefs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brief_items_brief_idx" ON "brief_items" USING btree ("brief_id");--> statement-breakpoint
CREATE INDEX "brief_items_brief_status_idx" ON "brief_items" USING btree ("brief_id","status");--> statement-breakpoint
CREATE INDEX "briefs_company_idx" ON "briefs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "briefs_debrief_idx" ON "briefs" USING btree ("debrief_id");--> statement-breakpoint
CREATE INDEX "briefs_company_status_idx" ON "briefs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "debriefs_company_idx" ON "debriefs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "debriefs_company_status_idx" ON "debriefs" USING btree ("company_id","status");