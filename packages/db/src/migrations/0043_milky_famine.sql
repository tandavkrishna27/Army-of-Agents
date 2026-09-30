CREATE TABLE "internal_agent_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_mode" text DEFAULT 'api' NOT NULL,
	"provider" text DEFAULT 'anthropic',
	"model" text DEFAULT 'claude-sonnet-4-6',
	"cli_tool" text,
	"autonomy_level" integer DEFAULT 0 NOT NULL,
	"enabled_capabilities" jsonb DEFAULT '["discussion_processing","proactive_suggestions","organizational_queries","system_actions","context_briefing","memory_management","conflict_detection","budget_awareness","workflow_coaching","workflow_discovery","cross_department_coordination","department_personas"]'::jsonb NOT NULL,
	"notification_preference" text DEFAULT 'realtime' NOT NULL,
	"context_token_budget" integer DEFAULT 8000 NOT NULL,
	"budget_monthly_cents" integer,
	"spent_monthly_cents" integer DEFAULT 0 NOT NULL,
	"proactive_interval_minutes" integer DEFAULT 240 NOT NULL,
	"last_proactive_run_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "internal_agent_config_company_id_unique" UNIQUE("company_id")
);
--> statement-breakpoint
CREATE TABLE "internal_agent_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"summarized_context" text,
	"summarized_up_to_message_id" uuid,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text,
	"tool_calls" jsonb,
	"tool_results" jsonb,
	"page_context" text,
	"department_context" uuid,
	"token_count" integer,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_agent_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"trigger_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"fired_run_id" uuid,
	"related_entity_type" text,
	"related_entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_source" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error_message" text,
	"tools_called" jsonb DEFAULT '[]'::jsonb,
	"summary" text,
	"token_usage" jsonb,
	"cost_cents" integer,
	"duration_ms" integer,
	"department_context" uuid,
	"user_id" text,
	"conversation_message_id" uuid,
	"related_entity_type" text,
	"related_entity_id" uuid,
	"provider" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"message" text,
	"related_entity_type" text,
	"related_entity_id" uuid,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"steps" jsonb NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"instantiation_count" integer DEFAULT 0 NOT NULL,
	"last_instantiated_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "internal_agent_config" ADD CONSTRAINT "internal_agent_config_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_conversations" ADD CONSTRAINT "internal_agent_conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_messages" ADD CONSTRAINT "internal_agent_messages_conversation_id_internal_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."internal_agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_messages" ADD CONSTRAINT "internal_agent_messages_run_id_internal_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."internal_agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_reminders" ADD CONSTRAINT "internal_agent_reminders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_reminders" ADD CONSTRAINT "internal_agent_reminders_fired_run_id_internal_agent_runs_id_fk" FOREIGN KEY ("fired_run_id") REFERENCES "public"."internal_agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_runs" ADD CONSTRAINT "internal_agent_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_runs" ADD CONSTRAINT "internal_agent_runs_department_context_projects_id_fk" FOREIGN KEY ("department_context") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "internal_agent_config_company_uq" ON "internal_agent_config" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ia_conversations_company_user_idx" ON "internal_agent_conversations" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "ia_conversations_active_idx" ON "internal_agent_conversations" USING btree ("company_id","user_id","status");--> statement-breakpoint
CREATE INDEX "ia_messages_conversation_idx" ON "internal_agent_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "ia_messages_conversation_time_idx" ON "internal_agent_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "ia_messages_run_idx" ON "internal_agent_messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "ia_reminders_company_user_idx" ON "internal_agent_reminders" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "ia_reminders_pending_idx" ON "internal_agent_reminders" USING btree ("status","trigger_at");--> statement-breakpoint
CREATE INDEX "ia_runs_company_idx" ON "internal_agent_runs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ia_runs_company_status_idx" ON "internal_agent_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "ia_runs_trigger_idx" ON "internal_agent_runs" USING btree ("company_id","trigger_type","trigger_source");--> statement-breakpoint
CREATE INDEX "ia_runs_created_at_idx" ON "internal_agent_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "ia_runs_related_entity_idx" ON "internal_agent_runs" USING btree ("related_entity_type","related_entity_id");--> statement-breakpoint
CREATE INDEX "notifications_company_user_idx" ON "notifications" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("company_id","user_id","read_at");--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_templates_company_idx" ON "workflow_templates" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "discussion_entries" ADD CONSTRAINT "discussion_entries_extraction_run_id_internal_agent_runs_id_fk" FOREIGN KEY ("extraction_run_id") REFERENCES "public"."internal_agent_runs"("id") ON DELETE set null ON UPDATE no action;