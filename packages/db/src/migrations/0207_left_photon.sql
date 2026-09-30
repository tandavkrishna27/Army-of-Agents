ALTER TABLE "feedback_exports" ALTER COLUMN "schema_version" SET DEFAULT 'aoa-feedback-envelope-v2';--> statement-breakpoint
ALTER TABLE "feedback_exports" ALTER COLUMN "bundle_version" SET DEFAULT 'aoa-feedback-bundle-v2';--> statement-breakpoint
ALTER TABLE "feedback_exports" ALTER COLUMN "payload_version" SET DEFAULT 'aoa-feedback-v1';