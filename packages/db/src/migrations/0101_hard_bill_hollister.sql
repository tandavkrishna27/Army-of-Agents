CREATE TABLE IF NOT EXISTS "aoa_agent_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "internal_agent_config" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "internal_agent_runs" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "aoa_agent_triggers" ADD CONSTRAINT "aoa_agent_triggers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aoa_agent_triggers" ADD CONSTRAINT "aoa_agent_triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aoa_triggers_company_agent_idx" ON "aoa_agent_triggers" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aoa_triggers_company_kind_enabled_idx" ON "aoa_agent_triggers" USING btree ("company_id","kind","enabled");--> statement-breakpoint
ALTER TABLE "internal_agent_config" ADD CONSTRAINT "internal_agent_config_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_runs" ADD CONSTRAINT "internal_agent_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ia_runs_agent_idx" ON "internal_agent_runs" USING btree ("company_id","agent_id");
