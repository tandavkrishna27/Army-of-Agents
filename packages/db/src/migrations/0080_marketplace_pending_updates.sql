CREATE TABLE IF NOT EXISTS "marketplace_pending_updates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "catalog_item_id" text NOT NULL,
  "catalog_item_name" text NOT NULL,
  "item_type" text NOT NULL,
  "current_version" text NOT NULL,
  "latest_version" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "detected_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "mpu_company_status_idx" ON "marketplace_pending_updates"("company_id","status");
CREATE UNIQUE INDEX IF NOT EXISTS "mpu_company_item_uq" ON "marketplace_pending_updates"("company_id","catalog_item_id");
