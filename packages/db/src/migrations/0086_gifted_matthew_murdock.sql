UPDATE "plugins" SET "company_id" = (SELECT id FROM companies ORDER BY created_at LIMIT 1) WHERE "company_id" IS NULL;--> statement-breakpoint
UPDATE "plugin_config" SET "company_id" = p."company_id" FROM "plugins" p WHERE "plugin_config"."plugin_id" = p."id" AND "plugin_config"."company_id" IS NULL;--> statement-breakpoint
UPDATE "plugin_version_snapshots" SET "company_id" = p."company_id" FROM "plugins" p WHERE "plugin_version_snapshots"."plugin_id" = p."id" AND "plugin_version_snapshots"."company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "plugin_config" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_version_snapshots" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ALTER COLUMN "company_id" SET NOT NULL;
