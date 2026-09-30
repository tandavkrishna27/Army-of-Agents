DROP INDEX IF EXISTS "plugin_config_plugin_id_idx";--> statement-breakpoint
ALTER TABLE "plugin_config" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
ALTER TABLE "plugin_version_snapshots" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "plugin_config" ADD CONSTRAINT "plugin_config_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "plugin_version_snapshots" ADD CONSTRAINT "plugin_version_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_config_company_plugin_idx" ON "plugin_config" USING btree ("company_id","plugin_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_config_company_idx" ON "plugin_config" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pvs_company_idx" ON "plugin_version_snapshots" USING btree ("company_id");
