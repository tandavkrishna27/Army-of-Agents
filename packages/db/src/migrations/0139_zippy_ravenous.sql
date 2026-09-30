CREATE TABLE IF NOT EXISTS "user_entity_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_entity_pins" ADD CONSTRAINT "user_entity_pins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_entity_pins" ADD CONSTRAINT "user_entity_pins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_entity_pins_user_company_entity_uq" ON "user_entity_pins" USING btree ("user_id","company_id","entity_type","entity_id");