CREATE TABLE IF NOT EXISTS "company_user_capability_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"slug" text NOT NULL,
	"filename" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_standard" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "company_user_capability_documents" ADD CONSTRAINT "company_user_capability_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_user_capability_documents_company_user_slug_uq" ON "company_user_capability_documents" USING btree ("company_id","user_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_user_capability_documents_company_user_sort_idx" ON "company_user_capability_documents" USING btree ("company_id","user_id","sort_order");
