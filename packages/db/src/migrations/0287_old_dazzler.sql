CREATE TABLE IF NOT EXISTS "universe_intake_parts" (
	"intake_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"part_index" integer NOT NULL,
	"object_key" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "universe_intake_parts_intake_id_part_index_pk" PRIMARY KEY("intake_id","part_index")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "universe_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_key" text NOT NULL,
	"client_key" uuid NOT NULL,
	"payload_sha256" text NOT NULL,
	"destination" jsonb NOT NULL,
	"filename" text NOT NULL,
	"declared_content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"state" text DEFAULT 'receiving' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"asset_id" uuid,
	"final_object_key" text,
	"final_byte_size" integer,
	"final_sha256" text,
	"reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "universe_intake_parts" ADD CONSTRAINT "universe_intake_parts_intake_id_universe_intakes_id_fk" FOREIGN KEY ("intake_id") REFERENCES "public"."universe_intakes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "universe_intake_parts" ADD CONSTRAINT "universe_intake_parts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "universe_intake_parts" ADD CONSTRAINT "universe_intake_parts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "universe_intakes" ADD CONSTRAINT "universe_intakes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "universe_intakes" ADD CONSTRAINT "universe_intakes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "universe_intakes" ADD CONSTRAINT "universe_intakes_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "universe_intake_parts_company_intake_idx" ON "universe_intake_parts" USING btree ("company_id","intake_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "universe_intake_parts_object_key_uq" ON "universe_intake_parts" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "universe_intakes_owner_client_uq" ON "universe_intakes" USING btree ("company_id","actor_key","client_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "universe_intakes_company_state_idx" ON "universe_intakes" USING btree ("company_id","state","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "universe_intakes_asset_idx" ON "universe_intakes" USING btree ("asset_id");