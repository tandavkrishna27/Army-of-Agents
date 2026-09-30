-- C14: idempotency guards added to Drizzle-generated DDL; schema unchanged.
CREATE TABLE IF NOT EXISTS "universe_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"destination_kind" text NOT NULL,
	"destination_id" text NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"attachment_asset_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "universe_layout_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layout_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"acknowledged_revision" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "universe_layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "universe_drafts" ADD CONSTRAINT "universe_drafts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "universe_layout_operations" ADD CONSTRAINT "universe_layout_operations_layout_id_universe_layouts_id_fk" FOREIGN KEY ("layout_id") REFERENCES "public"."universe_layouts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "universe_layout_operations" ADD CONSTRAINT "universe_layout_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "universe_layouts" ADD CONSTRAINT "universe_layouts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "universe_drafts_company_user_idx" ON "universe_drafts" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "universe_drafts_owner_destination_uq" ON "universe_drafts" USING btree ("user_id","company_id","conversation_id","destination_kind","destination_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "universe_layout_operations_layout_op_uq" ON "universe_layout_operations" USING btree ("layout_id","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "universe_layouts_company_user_idx" ON "universe_layouts" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "universe_layouts_owner_conversation_uq" ON "universe_layouts" USING btree ("user_id","company_id","conversation_id");