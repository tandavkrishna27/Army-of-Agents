ALTER TABLE "execution_targets" ALTER COLUMN "scope" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_targets" ALTER COLUMN "target_authority_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "execution_target_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "target_authority_key" SET NOT NULL;