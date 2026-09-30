CREATE TABLE "memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"category" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"department_id" uuid,
	"project_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_department_id_projects_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_items_company_idx" ON "memory_items" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "memory_items_company_category_idx" ON "memory_items" USING btree ("company_id","category");--> statement-breakpoint
CREATE INDEX "memory_items_company_status_idx" ON "memory_items" USING btree ("company_id","status");