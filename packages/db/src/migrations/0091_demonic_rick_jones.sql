CREATE TABLE IF NOT EXISTS "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"env_vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connection_target" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "default_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environments_company_idx" ON "environments" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_name_uq" ON "environments" USING btree ("company_id","name");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_execution_environment_id_environments_id_fk" FOREIGN KEY ("execution_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;
