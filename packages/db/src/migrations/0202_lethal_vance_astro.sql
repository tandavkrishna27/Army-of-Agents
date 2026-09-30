CREATE TABLE IF NOT EXISTS "mcp_connector_oauth_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"catalog_entry_id" text,
	"oauth_policy_version" integer,
	"state" text NOT NULL,
	"pkce_verifier" text NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"authorization_endpoint" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_connector_oauth_refresh_leases" (
	"secret_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_token" uuid NOT NULL,
	"fencing_token" bigint NOT NULL,
	"expected_secret_version" integer NOT NULL,
	"phase" text DEFAULT 'acquired' NOT NULL,
	"request_started_at" timestamp with time zone,
	"leased_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_mcp_connectors" ADD COLUMN IF NOT EXISTS "catalog_entry_id" text;--> statement-breakpoint
ALTER TABLE "company_mcp_connectors" ADD COLUMN IF NOT EXISTS "oauth_policy_version" integer;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mcp_connector_oauth_flows" ADD CONSTRAINT "mcp_connector_oauth_flows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mcp_connector_oauth_flows" ADD CONSTRAINT "mcp_connector_oauth_flows_connector_id_company_mcp_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."company_mcp_connectors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mcp_connector_oauth_refresh_leases" ADD CONSTRAINT "mcp_connector_oauth_refresh_leases_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "mcp_connector_oauth_refresh_leases" ADD CONSTRAINT "mcp_connector_oauth_refresh_leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_connector_oauth_flows_state_idx" ON "mcp_connector_oauth_flows" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_connector_oauth_flows_connector_idx" ON "mcp_connector_oauth_flows" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_connector_oauth_flows_company_idx" ON "mcp_connector_oauth_flows" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_connector_oauth_flows_status_expires_idx" ON "mcp_connector_oauth_flows" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_connector_oauth_flows_status_updated_idx" ON "mcp_connector_oauth_flows" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_mcp_connectors_company_catalog_entry_uq" ON "company_mcp_connectors" USING btree ("company_id","catalog_entry_id") WHERE "company_mcp_connectors"."catalog_entry_id" IS NOT NULL;
