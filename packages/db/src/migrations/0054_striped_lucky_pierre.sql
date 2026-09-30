CREATE TABLE "sidebar_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"department_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"project_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sidebar_preferences" ADD CONSTRAINT "sidebar_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sidebar_preferences" ADD CONSTRAINT "sidebar_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sidebar_preferences_company_idx" ON "sidebar_preferences" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "sidebar_preferences_user_idx" ON "sidebar_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sidebar_preferences_user_company_uq" ON "sidebar_preferences" USING btree ("user_id","company_id");