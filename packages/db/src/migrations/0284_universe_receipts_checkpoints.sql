-- C14: idempotency guards added to Drizzle-generated DDL; schema unchanged.
CREATE TABLE IF NOT EXISTS "universe_panel_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"panel_key" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "universe_layout_operations" ADD COLUMN IF NOT EXISTS "acknowledgement" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "universe_panel_checkpoints" ADD CONSTRAINT "universe_panel_checkpoints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "universe_checkpoints_owner_version_uq" ON "universe_panel_checkpoints" USING btree ("company_id","user_id","conversation_id","panel_key","source_version_id");