CREATE TABLE IF NOT EXISTS "hub_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"hub_item_id" uuid,
	"idempotency_key" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"authority_basis" text,
	"autonomy_level" text,
	"prior_state" jsonb,
	"source_revision" text,
	"reason" text,
	"undo_deadline" timestamp with time zone,
	"irreversible_side_effects" jsonb,
	"relay_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hub_item_user_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"hub_item_id" uuid NOT NULL,
	"principal_type" text DEFAULT 'user' NOT NULL,
	"principal_id" text NOT NULL,
	"read_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "semantic_type" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "group_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "sla_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "scope_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "source_unique_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "source_permission_revision" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "owner_pool" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hub_audit" ADD CONSTRAINT "hub_audit_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_audit" ADD CONSTRAINT "hub_audit_hub_item_id_notifications_id_fk" FOREIGN KEY ("hub_item_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_item_user_state" ADD CONSTRAINT "hub_item_user_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_item_user_state" ADD CONSTRAINT "hub_item_user_state_hub_item_id_notifications_id_fk" FOREIGN KEY ("hub_item_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_audit_item_idx" ON "hub_audit" USING btree ("hub_item_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_audit_company_idx" ON "hub_audit" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hub_audit_idem_uq" ON "hub_audit" USING btree ("company_id","idempotency_key") WHERE "hub_audit"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hub_item_user_state_principal_item_uq" ON "hub_item_user_state" USING btree ("hub_item_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_item_user_state_principal_idx" ON "hub_item_user_state" USING btree ("company_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_items_open_idx" ON "notifications" USING btree ("company_id","semantic_type","created_at") WHERE "notifications"."status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_items_owner_open_idx" ON "notifications" USING btree ("company_id","owner_user_id") WHERE "notifications"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hub_items_source_unique_idx" ON "notifications" USING btree ("source_unique_key");--> statement-breakpoint
-- W1a backfill: map legacy notifications onto the hub model. Idempotent.
-- The unique index above is created over an all-NULL source_unique_key column
-- (Postgres treats multiple NULLs as DISTINCT, so no collision at create time);
-- this backfill then populates a per-id-unique key (company_id||':notification:'||id),
-- so the populated values can never collide either.
UPDATE "notifications" SET
  "status" = COALESCE("status", 'open'),
  "source_type" = COALESCE("source_type", 'notification'),
  "source_id" = COALESCE("source_id", "id"::text),
  "semantic_type" = COALESCE("semantic_type",
     CASE
       WHEN "type" LIKE 'marketplace.%' THEN 'marketplace_op'
       WHEN "type" LIKE 'thread.mention%' THEN 'mention'
       WHEN "type" = 'internal_agent.reminder' THEN 'reminder'
       WHEN "type" = 'internal_agent_proactive' THEN 'proactive'
       WHEN "type" = 'thread.human_input_needed' THEN 'human_input_needed'
       WHEN "type" = 'thread.scope_proposal_posted' THEN 'scope_proposal'
       WHEN "type" = 'discussion.extraction_failed' THEN 'extraction_failed'
       WHEN "type" LIKE 'budget.%' THEN 'budget_alert'
       WHEN "type" LIKE 'routine.%' THEN 'routine_outcome'
       WHEN "type" LIKE 'sweep.%' THEN 'routine_outcome'
       WHEN "type" = 'internal_agent.notification' THEN 'mention'
       ELSE 'legacy_other'
     END),
  "source_unique_key" = COALESCE("source_unique_key",
     "company_id"::text || ':notification:' || "id"::text)
WHERE "source_unique_key" IS NULL;--> statement-breakpoint
-- Resolved legacy rows (already dismissed) leave the open hot set.
UPDATE "notifications" SET "status" = 'archived', "archived_at" = COALESCE("archived_at", "dismissed_at")
WHERE "dismissed_at" IS NOT NULL AND "status" = 'open';