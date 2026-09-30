CREATE TABLE IF NOT EXISTS "hub_counter_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"open_count" integer DEFAULT 0 NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"invalidated_at" timestamp with time zone,
	"computed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_counter_snapshots" ADD CONSTRAINT "hub_counter_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_counter_snapshots" ADD CONSTRAINT "hub_counter_snapshots_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hub_counter_snapshots_company_user_uq" ON "hub_counter_snapshots" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_counter_snapshots_invalidated_idx" ON "hub_counter_snapshots" USING btree ("company_id","invalidated_at");
