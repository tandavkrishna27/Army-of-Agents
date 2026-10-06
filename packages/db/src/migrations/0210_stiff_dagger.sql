CREATE TABLE "company_import_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"actor_user_id" text,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_token" uuid,
	"lease_until" timestamp with time zone,
	"checkpoints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_import_operations" ADD CONSTRAINT "company_import_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_import_operations" ADD CONSTRAINT "company_import_operations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_import_operations_company_operation_uq" ON "company_import_operations" USING btree ("company_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_import_operations_org_operation_uq" ON "company_import_operations" USING btree ("organization_id","operation_id");