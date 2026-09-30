CREATE TABLE "feedback_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"feedback_vote_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"project_id" uuid,
	"author_user_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"vote" text NOT NULL,
	"status" text DEFAULT 'local_only' NOT NULL,
	"destination" text,
	"export_id" text,
	"consent_version" text,
	"schema_version" text DEFAULT 'paperclip-feedback-envelope-v2' NOT NULL,
	"bundle_version" text DEFAULT 'paperclip-feedback-bundle-v2' NOT NULL,
	"payload_version" text DEFAULT 'paperclip-feedback-v1' NOT NULL,
	"payload_digest" text,
	"payload_snapshot" jsonb,
	"target_summary" jsonb NOT NULL,
	"redaction_summary" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempted_at" timestamp with time zone,
	"exported_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"vote" text NOT NULL,
	"reason" text,
	"shared_with_labs" boolean DEFAULT false NOT NULL,
	"shared_at" timestamp with time zone,
	"consent_version" text,
	"redaction_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_feedback_vote_id_feedback_votes_id_fk" FOREIGN KEY ("feedback_vote_id") REFERENCES "public"."feedback_votes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_exports" ADD CONSTRAINT "feedback_exports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_exports_feedback_vote_idx" ON "feedback_exports" USING btree ("feedback_vote_id");--> statement-breakpoint
CREATE INDEX "feedback_exports_company_created_idx" ON "feedback_exports" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_exports_company_status_idx" ON "feedback_exports" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_exports_company_issue_idx" ON "feedback_exports" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_exports_company_project_idx" ON "feedback_exports" USING btree ("company_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_exports_company_author_idx" ON "feedback_exports" USING btree ("company_id","author_user_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_votes_company_issue_idx" ON "feedback_votes" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "feedback_votes_issue_target_idx" ON "feedback_votes" USING btree ("issue_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "feedback_votes_author_idx" ON "feedback_votes" USING btree ("author_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_votes_company_target_author_idx" ON "feedback_votes" USING btree ("company_id","target_type","target_id","author_user_id");