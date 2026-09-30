ALTER TABLE "user" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "invited_by" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "layer" text;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "visibility" text DEFAULT 'scoped' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "source_artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "source_context" text;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "accessed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_source_artifact_id_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_current_version_id_memory_item_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."memory_item_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_items_company_layer_status_idx" ON "memory_items" USING btree ("company_id","layer","status");--> statement-breakpoint
CREATE INDEX "memory_items_goal_active_context_idx" ON "memory_items" USING btree ("goal_id","expires_at");--> statement-breakpoint
CREATE INDEX "memory_items_task_working_idx" ON "memory_items" USING btree ("task_id");