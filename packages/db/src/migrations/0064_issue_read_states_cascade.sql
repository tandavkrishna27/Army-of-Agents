-- Add ON DELETE CASCADE to issue_read_states FKs.
-- Drops and recreates both FKs (company_id, issue_id) so a DELETE on
-- companies or issues no longer aborts when read-state rows exist.
ALTER TABLE "issue_read_states" DROP CONSTRAINT IF EXISTS "issue_read_states_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_read_states" DROP CONSTRAINT IF EXISTS "issue_read_states_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_read_states" ADD CONSTRAINT "issue_read_states_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
