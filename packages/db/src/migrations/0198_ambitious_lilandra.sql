ALTER TABLE "marketplace_install_operations" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "marketplace_install_operations" ADD COLUMN "error_docs" text;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "status_reason_code" text;