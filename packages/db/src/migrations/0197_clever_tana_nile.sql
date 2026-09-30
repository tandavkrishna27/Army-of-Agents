DROP INDEX "companies_org_issue_prefix_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_issue_prefix_idx" ON "companies" USING btree ("issue_prefix");
