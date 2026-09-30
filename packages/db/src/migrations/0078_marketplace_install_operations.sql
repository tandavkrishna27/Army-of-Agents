CREATE TABLE IF NOT EXISTS "marketplace_install_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"catalog_item_id" text NOT NULL,
	"item_type" text NOT NULL,
	"target_department_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"result_entity_id" text,
	"error_message" text,
	"cascade_results" jsonb,
	"idempotency_key" text,
	"requested_by_user_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "template_origin" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "template_version" text;--> statement-breakpoint
ALTER TABLE "marketplace_install_operations" ADD CONSTRAINT "marketplace_install_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "midx_install_op_idemp" ON "marketplace_install_operations" USING btree ("company_id","idempotency_key") WHERE "marketplace_install_operations"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "midx_install_op_snapshot" ON "marketplace_install_operations" USING btree ("company_id","catalog_item_id","target_department_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "midx_install_op_company_created" ON "marketplace_install_operations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_template_origin_idx" ON "agents" USING btree ("company_id","template_origin");
