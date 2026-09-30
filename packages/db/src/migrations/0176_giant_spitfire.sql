DROP INDEX "braindump_captures_idempotency_uq";--> statement-breakpoint
ALTER TABLE "braindump_captures" ALTER COLUMN "department_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "braindump_captures" ADD COLUMN "scope" text DEFAULT 'department' NOT NULL;--> statement-breakpoint
ALTER TABLE "braindump_captures" ADD COLUMN "asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "braindump_captures_company_idempotency_uq" ON "braindump_captures" USING btree ("company_id","idempotency_key") WHERE "braindump_captures"."department_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "braindump_captures_idempotency_uq" ON "braindump_captures" USING btree ("company_id","department_id","idempotency_key") WHERE "braindump_captures"."department_id" IS NOT NULL;