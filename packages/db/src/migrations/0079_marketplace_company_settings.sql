CREATE TABLE IF NOT EXISTS "marketplace_company_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL UNIQUE REFERENCES "companies"("id") ON DELETE CASCADE,
  "settings" jsonb DEFAULT '{}' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
