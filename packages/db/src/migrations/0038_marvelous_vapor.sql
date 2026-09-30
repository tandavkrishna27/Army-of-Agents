DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS vector; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pgvector extension not available, skipping'; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_client_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"api_key_id" uuid,
	"user_id" text NOT NULL,
	"client_name" text,
	"client_version" text,
	"user_agent" text,
	"transport" text DEFAULT 'http' NOT NULL,
	"remote_address" text,
	"last_method" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "brief_items" ADD COLUMN "suggested_layer" text; EXCEPTION WHEN duplicate_column THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "brief_items" ADD COLUMN "layer" text; EXCEPTION WHEN duplicate_column THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "brief_items" ADD COLUMN "dedup_action" text; EXCEPTION WHEN duplicate_column THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "brief_items" ADD COLUMN "selected_memory_id" uuid; EXCEPTION WHEN duplicate_column THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "brief_items" ADD COLUMN "merged_content" text; EXCEPTION WHEN duplicate_column THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "briefs" ADD COLUMN "goal_id" uuid; EXCEPTION WHEN duplicate_column THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "companies" ADD COLUMN "mcp_enabled" boolean DEFAULT false NOT NULL; EXCEPTION WHEN duplicate_column THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "debriefs" ADD COLUMN "goal_id" uuid; EXCEPTION WHEN duplicate_column THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE "memory_items" ADD COLUMN "embedding" vector(1536);
  END IF;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "mcp_api_keys" ADD CONSTRAINT "mcp_api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "mcp_client_connections" ADD CONSTRAINT "mcp_client_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "mcp_client_connections" ADD CONSTRAINT "mcp_client_connections_api_key_id_mcp_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."mcp_api_keys"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_api_keys_key_hash_idx" ON "mcp_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_api_keys_company_user_idx" ON "mcp_api_keys" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_client_connections_company_last_seen_idx" ON "mcp_client_connections" USING btree ("company_id","last_seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_client_connections_api_key_last_seen_idx" ON "mcp_client_connections" USING btree ("api_key_id","last_seen_at");--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "brief_items" ADD CONSTRAINT "brief_items_selected_memory_id_memory_items_id_fk" FOREIGN KEY ("selected_memory_id") REFERENCES "public"."memory_items"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "briefs" ADD CONSTRAINT "briefs_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "debriefs" ADD CONSTRAINT "debriefs_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
