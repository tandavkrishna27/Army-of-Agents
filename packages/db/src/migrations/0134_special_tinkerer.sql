CREATE TABLE IF NOT EXISTS "company_brain_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"from_type" text NOT NULL,
	"from_id" text NOT NULL,
	"to_type" text NOT NULL,
	"to_id" text NOT NULL,
	"kind" text NOT NULL,
	"confidence" numeric(10, 6),
	"evidence" text,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "company_brain_edges_from_type_check" CHECK (from_type IN ('company', 'department', 'project', 'team', 'human', 'agent', 'goal', 'task', 'discussion', 'discussion_entry', 'memory_item', 'memory_asset', 'artifact')),
	CONSTRAINT "company_brain_edges_to_type_check" CHECK (to_type IN ('company', 'department', 'project', 'team', 'human', 'agent', 'goal', 'task', 'discussion', 'discussion_entry', 'memory_item', 'memory_asset', 'artifact')),
	CONSTRAINT "company_brain_edges_kind_check" CHECK (kind IN ('applies_to', 'related_to', 'supports', 'conflicts_with', 'supersedes', 'duplicate_of')),
	CONSTRAINT "company_brain_edges_status_check" CHECK (status IN ('active', 'archived')),
	CONSTRAINT "company_brain_edges_confidence_check" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "company_brain_edges" ADD CONSTRAINT "company_brain_edges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "company_brain_edges" ADD CONSTRAINT "company_brain_edges_from_type_check" CHECK (from_type IN ('company', 'department', 'project', 'team', 'human', 'agent', 'goal', 'task', 'discussion', 'discussion_entry', 'memory_item', 'memory_asset', 'artifact'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "company_brain_edges" ADD CONSTRAINT "company_brain_edges_to_type_check" CHECK (to_type IN ('company', 'department', 'project', 'team', 'human', 'agent', 'goal', 'task', 'discussion', 'discussion_entry', 'memory_item', 'memory_asset', 'artifact'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "company_brain_edges" ADD CONSTRAINT "company_brain_edges_kind_check" CHECK (kind IN ('applies_to', 'related_to', 'supports', 'conflicts_with', 'supersedes', 'duplicate_of'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "company_brain_edges" ADD CONSTRAINT "company_brain_edges_status_check" CHECK (status IN ('active', 'archived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "company_brain_edges" ADD CONSTRAINT "company_brain_edges_confidence_check" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_brain_edges_company_from_idx" ON "company_brain_edges" USING btree ("company_id","from_type","from_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_brain_edges_company_to_idx" ON "company_brain_edges" USING btree ("company_id","to_type","to_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_brain_edges_company_kind_status_idx" ON "company_brain_edges" USING btree ("company_id","kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_brain_edges_active_edge_uq" ON "company_brain_edges" USING btree ("company_id","from_type","from_id","to_type","to_id","kind") WHERE status = 'active';
