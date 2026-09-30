CREATE TABLE IF NOT EXISTS "execution_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"owner_user_id" text,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"trust_class" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_targets_org_slug_uq" UNIQUE NULLS NOT DISTINCT("organization_id","slug")
);
--> statement-breakpoint
ALTER TABLE "execution_targets" ADD CONSTRAINT "execution_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_targets" ADD CONSTRAINT "execution_targets_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_targets_kind_status_idx" ON "execution_targets" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_targets_org_idx" ON "execution_targets" USING btree ("organization_id");