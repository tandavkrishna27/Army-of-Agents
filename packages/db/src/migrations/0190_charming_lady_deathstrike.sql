CREATE TABLE IF NOT EXISTS "provider_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"company_id" uuid,
	"connection_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_assignments_scope_uq" UNIQUE NULLS NOT DISTINCT("company_id","provider","scope_type","scope_id"),
	CONSTRAINT "provider_assignments_scope_shape_check" CHECK ((scope_type IN ('org_default','company_default') AND scope_id IS NULL) OR (scope_type IN ('agent_override','personal_execution_default') AND scope_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"company_id" uuid,
	"provider" text NOT NULL,
	"auth_method" text NOT NULL,
	"owner_user_id" text,
	"execution_target_id" text,
	"secret_ref" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"sharing_policy" text DEFAULT 'owner_only' NOT NULL,
	"max_concurrency" integer DEFAULT 1 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"terms_attested_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_connections_identity_uq" UNIQUE NULLS NOT DISTINCT("company_id","provider","auth_method","owner_user_id","execution_target_id"),
	CONSTRAINT "provider_connections_subscription_shape_check" CHECK ((auth_method <> 'personal_subscription') OR (owner_user_id IS NOT NULL AND execution_target_id IS NOT NULL AND secret_ref IS NULL)),
	CONSTRAINT "provider_connections_api_key_shape_check" CHECK ((auth_method <> 'api_key') OR (secret_ref IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_secret_ref_company_secrets_id_fk" FOREIGN KEY ("secret_ref") REFERENCES "public"."company_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_assignments_lookup_idx" ON "provider_assignments" USING btree ("company_id","provider","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_assignments_connection_idx" ON "provider_assignments" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_connections_org_provider_idx" ON "provider_connections" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_connections_company_provider_idx" ON "provider_connections" USING btree ("company_id","provider","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_connections_owner_idx" ON "provider_connections" USING btree ("owner_user_id");