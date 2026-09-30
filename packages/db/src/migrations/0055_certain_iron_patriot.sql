CREATE TABLE "inbox_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_dismissals" ADD CONSTRAINT "inbox_dismissals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_dismissals_company_idx" ON "inbox_dismissals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "inbox_dismissals_user_idx" ON "inbox_dismissals" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_dismissals_user_company_item_uq" ON "inbox_dismissals" USING btree ("user_id","company_id","item_key");