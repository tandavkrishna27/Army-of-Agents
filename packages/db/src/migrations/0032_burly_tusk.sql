CREATE TABLE "agent_projects" (
	"agent_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_projects_agent_id_project_id_pk" PRIMARY KEY("agent_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "agent_projects" ADD CONSTRAINT "agent_projects_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_projects" ADD CONSTRAINT "agent_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_projects" ADD CONSTRAINT "agent_projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_projects_agent_idx" ON "agent_projects" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_projects_project_idx" ON "agent_projects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "agent_projects_company_idx" ON "agent_projects" USING btree ("company_id");