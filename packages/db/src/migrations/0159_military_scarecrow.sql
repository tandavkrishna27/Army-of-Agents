ALTER TABLE "notifications" ADD COLUMN "curation_group_label" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "curation_group_summary" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "curation_reason" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "curation_priority_reason" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "curation_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "curated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "curated_by_agent_id" uuid;