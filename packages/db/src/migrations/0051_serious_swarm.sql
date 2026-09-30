ALTER TABLE "projects" ADD COLUMN "function_type" text DEFAULT 'general';--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN "workspace_mode" text DEFAULT 'department_default';