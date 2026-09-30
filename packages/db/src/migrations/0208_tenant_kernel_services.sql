-- IF NOT EXISTS added to every CREATE TABLE / CREATE INDEX below after
-- generation (drizzle-kit omits it; C14 / CLAUDE.md Critical Rule #1 narrow
-- exception, enforced by migration-idempotency.test.ts). Idempotent re-run
-- safety only — no data/DDL semantics changed from what db:generate emitted
-- (matches migrations 0203/0206/0207).
CREATE TABLE IF NOT EXISTS "job_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_secret_handles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_instances_status_check" CHECK (status IN ('pending', 'healthy', 'stopped', 'lost', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"desired_state" text DEFAULT 'running' NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_desired_state_check" CHECK (desired_state IN ('running', 'stopped', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"organization_id" uuid,
	"owner_user_id" uuid,
	"label" text NOT NULL,
	"status" text DEFAULT 'enrolled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workers_scope_check" CHECK (scope IN ('platform', 'organization', 'owner')),
	CONSTRAINT "workers_status_check" CHECK (status IN ('enrolled', 'active', 'draining', 'revoked')),
	CONSTRAINT "workers_scope_org_check" CHECK ((scope = 'platform' AND organization_id IS NULL) OR (scope IN ('organization', 'owner') AND organization_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD CONSTRAINT "job_artifacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD CONSTRAINT "job_artifacts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD CONSTRAINT "job_secret_handles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_secret_handles" ADD CONSTRAINT "job_secret_handles_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_instances" ADD CONSTRAINT "service_instances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_instances" ADD CONSTRAINT "service_instances_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_artifacts_organization_idx" ON "job_artifacts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_artifacts_job_idx" ON "job_artifacts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_secret_handles_organization_idx" ON "job_secret_handles" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_secret_handles_job_idx" ON "job_secret_handles" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_instances_organization_idx" ON "service_instances" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_instances_service_idx" ON "service_instances" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "services_organization_idx" ON "services" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "services_organization_company_idx" ON "services" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_organization_idx" ON "workers" USING btree ("organization_id");
