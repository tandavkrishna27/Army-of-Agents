CREATE TABLE IF NOT EXISTS "memory_extraction_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"total_files" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"input_type" text NOT NULL,
	"input_asset_id" uuid,
	"input_url" text,
	"extractor" text,
	"extracted_text" text,
	"extracted_metadata" jsonb,
	"progress_json" jsonb,
	"curator_run_id" uuid,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"result_memory_item_id" uuid,
	"result_artifact_id" uuid,
	"created_by" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"from_item_id" uuid NOT NULL,
	"to_item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_retrievals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"task_id" uuid,
	"triggered_by" text NOT NULL,
	"query" text,
	"item_id" uuid,
	"similarity_score" numeric(10, 6),
	"rank" integer,
	"shown_to_agent" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "validation_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "last_validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "pinned_to_skill" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_extraction_batches" ADD CONSTRAINT "memory_extraction_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extractions" ADD CONSTRAINT "memory_extractions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extractions" ADD CONSTRAINT "memory_extractions_batch_id_memory_extraction_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."memory_extraction_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extractions" ADD CONSTRAINT "memory_extractions_input_asset_id_assets_id_fk" FOREIGN KEY ("input_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extractions" ADD CONSTRAINT "memory_extractions_curator_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("curator_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extractions" ADD CONSTRAINT "memory_extractions_result_memory_item_id_memory_items_id_fk" FOREIGN KEY ("result_memory_item_id") REFERENCES "public"."memory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extractions" ADD CONSTRAINT "memory_extractions_result_artifact_id_artifacts_id_fk" FOREIGN KEY ("result_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_from_item_id_memory_items_id_fk" FOREIGN KEY ("from_item_id") REFERENCES "public"."memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_to_item_id_memory_items_id_fk" FOREIGN KEY ("to_item_id") REFERENCES "public"."memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_item_id_memory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."memory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extraction_batches_company_created_idx" ON "memory_extraction_batches" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extraction_batches_company_status_idx" ON "memory_extraction_batches" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extractions_company_status_idx" ON "memory_extractions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extractions_batch_idx" ON "memory_extractions" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extractions_result_memory_item_idx" ON "memory_extractions" USING btree ("result_memory_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extractions_company_created_idx" ON "memory_extractions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_relations_from_to_kind_uq" ON "memory_relations" USING btree ("from_item_id","to_item_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_relations_company_from_idx" ON "memory_relations" USING btree ("company_id","from_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_relations_company_to_idx" ON "memory_relations" USING btree ("company_id","to_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_relations_company_kind_idx" ON "memory_relations" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_retrievals_run_idx" ON "memory_retrievals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_retrievals_company_created_idx" ON "memory_retrievals" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_retrievals_agent_created_idx" ON "memory_retrievals" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_retrievals_item_created_idx" ON "memory_retrievals" USING btree ("item_id","created_at");--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_items_agent_scope_idx" ON "memory_items" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_items_pinned_skill_idx" ON "memory_items" USING btree ("company_id","pinned_to_skill","status");