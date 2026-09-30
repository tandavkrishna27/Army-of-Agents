CREATE TABLE IF NOT EXISTS "home_board_layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"layout" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "home_board_layouts" ADD CONSTRAINT "home_board_layouts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_board_layouts" ADD CONSTRAINT "home_board_layouts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "home_board_layouts_company_idx" ON "home_board_layouts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "home_board_layouts_user_idx" ON "home_board_layouts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "home_board_layouts_user_company_uq" ON "home_board_layouts" USING btree ("user_id","company_id");