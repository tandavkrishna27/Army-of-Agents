CREATE TABLE IF NOT EXISTS "marketplace_catalog_cache" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"schema_version" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"item_count" integer NOT NULL,
	"catalog_json" jsonb NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_status" text NOT NULL,
	"last_sync_error" text,
	"source" text NOT NULL
);
