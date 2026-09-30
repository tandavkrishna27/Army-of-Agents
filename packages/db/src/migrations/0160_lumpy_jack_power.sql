CREATE TABLE IF NOT EXISTS "agent_runtime_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"adapter_type" text NOT NULL,
	"adapter_session_id" text,
	"adapter_session_params" jsonb,
	"kind" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"nonce" text NOT NULL,
	"source_revision" integer DEFAULT 0 NOT NULL,
	"prompt_hash" text NOT NULL,
	"source_unique_key" text,
	"title" text NOT NULL,
	"summary" text,
	"prompt_text" text,
	"tool_name" text,
	"command" text,
	"cwd" text,
	"path" text,
	"network_target" text,
	"risk_class" text,
	"options" jsonb,
	"expires_at" timestamp with time zone,
	"timeout_policy" text NOT NULL,
	"decision" text,
	"answer_payload" jsonb,
	"answered_by_user_id" text,
	"answered_at" timestamp with time zone,
	"relayed_at" timestamp with time zone,
	"relay_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_runtime_trust_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"adapter_type" text NOT NULL,
	"tool_name" text,
	"command_hash" text,
	"path_scope" text,
	"network_scope" text,
	"risk_class" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runtime_decisions" ADD CONSTRAINT "agent_runtime_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_decisions" ADD CONSTRAINT "agent_runtime_decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_decisions" ADD CONSTRAINT "agent_runtime_decisions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_trust_rules" ADD CONSTRAINT "agent_runtime_trust_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_trust_rules" ADD CONSTRAINT "agent_runtime_trust_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runtime_decisions_company_status_expiry_idx" ON "agent_runtime_decisions" USING btree ("company_id","status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runtime_decisions_company_run_status_idx" ON "agent_runtime_decisions" USING btree ("company_id","run_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runtime_decisions_company_agent_created_idx" ON "agent_runtime_decisions" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_runtime_decisions_source_unique_idx" ON "agent_runtime_decisions" USING btree ("source_unique_key") WHERE source_unique_key is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runtime_trust_rules_company_agent_enabled_idx" ON "agent_runtime_trust_rules" USING btree ("company_id","agent_id","enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runtime_trust_rules_company_adapter_tool_idx" ON "agent_runtime_trust_rules" USING btree ("company_id","adapter_type","tool_name");
