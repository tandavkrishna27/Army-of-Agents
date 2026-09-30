CREATE TABLE IF NOT EXISTS "runtime_provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_provider_keys" ADD CONSTRAINT "runtime_provider_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_provider_keys" ADD CONSTRAINT "runtime_provider_keys_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_provider_keys_company_idx" ON "runtime_provider_keys" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_provider_keys_company_provider_idx" ON "runtime_provider_keys" USING btree ("company_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_provider_keys_default_uq" ON "runtime_provider_keys" USING btree ("company_id","provider") WHERE "runtime_provider_keys"."is_default" IS TRUE;
