ALTER TABLE "job_artifacts" DROP CONSTRAINT "job_artifacts_job_id_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "job_artifacts" DROP CONSTRAINT "job_artifacts_org_job_fk";
--> statement-breakpoint
ALTER TABLE "job_attempts" DROP CONSTRAINT "job_attempts_job_id_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "job_attempts" DROP CONSTRAINT "job_attempts_org_job_fk";
--> statement-breakpoint
ALTER TABLE "job_secret_handles" DROP CONSTRAINT "job_secret_handles_job_id_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "job_secret_handles" DROP CONSTRAINT "job_secret_handles_org_job_fk";
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_org_company_fk";
--> statement-breakpoint
ALTER TABLE "leases" DROP CONSTRAINT "leases_attempt_id_job_attempts_id_fk";
--> statement-breakpoint
ALTER TABLE "leases" DROP CONSTRAINT "leases_org_attempt_fk";
--> statement-breakpoint
ALTER TABLE "service_instances" DROP CONSTRAINT "service_instances_service_id_services_id_fk";
--> statement-breakpoint
ALTER TABLE "service_instances" DROP CONSTRAINT "service_instances_org_service_fk";
--> statement-breakpoint
ALTER TABLE "services" DROP CONSTRAINT "services_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "services" DROP CONSTRAINT "services_org_company_fk";
--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD CONSTRAINT "job_artifacts_org_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_org_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD CONSTRAINT "job_secret_handles_org_job_fk" FOREIGN KEY ("organization_id","job_id") REFERENCES "public"."jobs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_org_attempt_fk" FOREIGN KEY ("organization_id","attempt_id") REFERENCES "public"."job_attempts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_instances" ADD CONSTRAINT "service_instances_org_service_fk" FOREIGN KEY ("organization_id","service_id") REFERENCES "public"."services"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_org_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE restrict ON UPDATE no action;