CREATE TABLE IF NOT EXISTS "company_mcp_connector_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_mcp_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"server_name" text NOT NULL,
	"display_name" text NOT NULL,
	"transport" text NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"header_template" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"env_template" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ref" text,
	"requires_secret" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'byo' NOT NULL,
	"trust_tier" text,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_mcp_connector_agents" ADD CONSTRAINT "company_mcp_connector_agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_mcp_connector_agents" ADD CONSTRAINT "company_mcp_connector_agents_connector_id_company_mcp_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."company_mcp_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_mcp_connector_agents" ADD CONSTRAINT "company_mcp_connector_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_mcp_connectors" ADD CONSTRAINT "company_mcp_connectors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_mcp_connector_agents_connector_idx" ON "company_mcp_connector_agents" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_mcp_connector_agents_agent_idx" ON "company_mcp_connector_agents" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_mcp_connector_agents_connector_agent_uq" ON "company_mcp_connector_agents" USING btree ("connector_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_mcp_connectors_company_idx" ON "company_mcp_connectors" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_mcp_connectors_company_name_uq" ON "company_mcp_connectors" USING btree ("company_id","server_name");