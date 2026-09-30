-- TEN-004 composite tenant integrity. Two hand-edits were applied to the
-- db:generate output below (no DDL text changed — Rule #1 / C14):
--   1. STATEMENT REORDER: drizzle-kit emits the composite FOREIGN KEY
--      ADD CONSTRAINTs BEFORE the UNIQUE constraints they reference, but Postgres
--      requires the referenced (organization_id, id) UNIQUE to exist first (else
--      42830 "no unique constraint matching given keys"). The five FK-target
--      UNIQUE ADDs are moved AHEAD of the seven composite FK ADDs so the chain
--      applies. Statements are otherwise verbatim drizzle-kit output.
--   2. IF NOT EXISTS added to the one CREATE UNIQUE INDEX (drizzle-kit omits it;
--      C14 / CLAUDE.md Critical Rule #1 narrow exception, enforced by
--      migration-idempotency.test.ts). Idempotent re-run safety only — matches
--      migrations 0207/0208.
-- The composite FKs use ON DELETE no action (default); actual cascade/restrict
-- delete behavior stays governed by the pre-existing single-column FKs (0207/0208).
ALTER TABLE "companies" ADD CONSTRAINT "companies_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_org_id_uq" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD CONSTRAINT "job_artifacts_org_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_org_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD CONSTRAINT "job_secret_handles_org_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_org_attempt_fk" FOREIGN KEY ("organization_id","attempt_id") REFERENCES "public"."job_attempts"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_instances" ADD CONSTRAINT "service_instances_org_service_fk" FOREIGN KEY ("organization_id","service_id") REFERENCES "public"."services"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_org_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leases_active_per_attempt_idx" ON "leases" USING btree ("attempt_id") WHERE status in ('offered', 'active');
