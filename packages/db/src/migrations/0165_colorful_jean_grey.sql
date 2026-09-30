ALTER TABLE "artifact_versions" ADD COLUMN "storage_kind" text DEFAULT 'inline' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "asset_id" uuid;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "filename" text;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "extension" text;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "byte_size" integer;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_versions_asset_idx" ON "artifact_versions" USING btree ("asset_id");
