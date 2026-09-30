DROP INDEX IF EXISTS "company_secrets_company_name_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_secrets_company_name_uq" ON "company_secrets" USING btree ("company_id","name") WHERE "company_secrets"."deleted_at" IS NULL;
