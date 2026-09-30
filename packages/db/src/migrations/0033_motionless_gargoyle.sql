CREATE TABLE "agent_trust_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"total_completed" integer DEFAULT 0 NOT NULL,
	"approved_without_changes" integer DEFAULT 0 NOT NULL,
	"recent_completed" integer DEFAULT 0 NOT NULL,
	"recent_approved" integer DEFAULT 0 NOT NULL,
	"current_score" real DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version_number" text NOT NULL,
	"source" text NOT NULL,
	"source_detail" text,
	"changelog" text,
	"parent_version_id" uuid,
	"content" text,
	"file_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_feedback_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pattern_type" text NOT NULL,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'detected' NOT NULL,
	"evidence" jsonb,
	"source_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_item_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_item_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"category" text NOT NULL,
	"action_type" text NOT NULL,
	"action_payload" jsonb,
	"title" text NOT NULL,
	"evidence" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"related_memory_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_trust_scores" ADD CONSTRAINT "agent_trust_scores_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_trust_scores" ADD CONSTRAINT "agent_trust_scores_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_parent_version_id_artifact_versions_id_fk" FOREIGN KEY ("parent_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_current_version_id_artifact_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_feedback_patterns" ADD CONSTRAINT "memory_feedback_patterns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_feedback_patterns" ADD CONSTRAINT "memory_feedback_patterns_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_item_versions" ADD CONSTRAINT "memory_item_versions_memory_item_id_memory_items_id_fk" FOREIGN KEY ("memory_item_id") REFERENCES "public"."memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_related_memory_item_id_memory_items_id_fk" FOREIGN KEY ("related_memory_item_id") REFERENCES "public"."memory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_trust_scores_agent_idx" ON "agent_trust_scores" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_trust_scores_company_idx" ON "agent_trust_scores" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "artifact_versions_artifact_idx" ON "artifact_versions" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "artifacts_company_idx" ON "artifacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "artifacts_company_status_idx" ON "artifacts" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "memory_feedback_patterns_company_idx" ON "memory_feedback_patterns" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "memory_feedback_patterns_company_status_idx" ON "memory_feedback_patterns" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "memory_item_versions_item_idx" ON "memory_item_versions" USING btree ("memory_item_id");--> statement-breakpoint
CREATE INDEX "memory_item_versions_item_status_idx" ON "memory_item_versions" USING btree ("memory_item_id","status");--> statement-breakpoint
CREATE INDEX "suggestions_company_idx" ON "suggestions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "suggestions_company_status_idx" ON "suggestions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "suggestions_company_category_idx" ON "suggestions" USING btree ("company_id","category");