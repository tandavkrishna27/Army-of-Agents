CREATE TABLE IF NOT EXISTS "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"parent_project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"template_origin" text,
	"template_version" text,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_coordinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"key" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"markdown" text NOT NULL,
	"source_type" text DEFAULT 'local_path' NOT NULL,
	"source_locator" text,
	"source_ref" text,
	"trust_level" text DEFAULT 'markdown_only' NOT NULL,
	"compatibility" text DEFAULT 'compatible' NOT NULL,
	"file_inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"status" text DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "enable_teams" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_parent_project_id_projects_id_fk" FOREIGN KEY ("parent_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_coordinations" ADD CONSTRAINT "team_coordinations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_coordinations" ADD CONSTRAINT "team_coordinations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teams_company_idx" ON "teams" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teams_parent_project_idx" ON "teams" USING btree ("parent_project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teams_company_slug_uq" ON "teams" USING btree ("company_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_members_team_agent_uq" ON "team_members" USING btree ("team_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_members_team_idx" ON "team_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_members_agent_idx" ON "team_members" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_coordinations_company_key_uq" ON "team_coordinations" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_coordinations_team_idx" ON "team_coordinations" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_coordinations_team_status_idx" ON "team_coordinations" USING btree ("team_id","status");