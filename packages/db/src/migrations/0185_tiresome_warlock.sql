CREATE TABLE IF NOT EXISTS "agent_provider_credential_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"execution_target_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "agent_provider_credential_bindings" ADD CONSTRAINT "agent_provider_credential_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "agent_provider_credential_bindings" ADD CONSTRAINT "agent_provider_credential_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "agent_provider_credential_bindings" ADD CONSTRAINT "agent_provider_credential_bindings_credential_id_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "agent_provider_credential_bindings" ADD CONSTRAINT "agent_provider_credential_bindings_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_provider_credential_bindings_agent_idx" ON "agent_provider_credential_bindings" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_provider_credential_bindings_agent_credential_uq" ON "agent_provider_credential_bindings" USING btree ("agent_id","credential_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_credentials_owner_idx" ON "provider_credentials" USING btree ("company_id","owner_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_credentials_target_idx" ON "provider_credentials" USING btree ("company_id","execution_target_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_credentials_identity_uq" ON "provider_credentials" USING btree ("company_id","provider","owner_user_id","execution_target_id","kind");
