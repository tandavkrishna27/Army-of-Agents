ALTER TABLE "issues" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "reviewer_user_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "due_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;