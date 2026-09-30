CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dependent_issue_id" uuid NOT NULL,
	"dependency_issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_dependent_issue_id_issues_id_fk" FOREIGN KEY ("dependent_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_dependency_issue_id_issues_id_fk" FOREIGN KEY ("dependency_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_dep_unique_idx" ON "task_dependencies" USING btree ("dependent_issue_id","dependency_issue_id");--> statement-breakpoint
CREATE INDEX "task_dep_dependent_idx" ON "task_dependencies" USING btree ("company_id","dependent_issue_id");--> statement-breakpoint
CREATE INDEX "task_dep_dependency_idx" ON "task_dependencies" USING btree ("company_id","dependency_issue_id");