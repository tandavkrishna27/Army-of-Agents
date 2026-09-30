CREATE TABLE IF NOT EXISTS "budget_capacity_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"operation_kind" text NOT NULL,
	"operation_id" text NOT NULL,
	"agent_id" uuid,
	"project_id" uuid,
	"maximum_cost_cents" integer NOT NULL,
	"settled_cost_cents" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"stop_requested_at" timestamp with time zone,
	"stop_reason" text,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_capacity_reservations_amount_check" CHECK ("budget_capacity_reservations"."maximum_cost_cents" > 0 AND "budget_capacity_reservations"."settled_cost_cents" >= 0),
	CONSTRAINT "budget_capacity_reservations_state_check" CHECK ("budget_capacity_reservations"."state" IN ('held','unknown','settled','released'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_capacity_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"charge_id" text NOT NULL,
	"cost_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_capacity_settlements_cost_check" CHECK ("budget_capacity_settlements"."cost_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "resolution_scope" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_capacity_reservations" ADD CONSTRAINT "budget_capacity_reservations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_capacity_reservations" ADD CONSTRAINT "budget_capacity_reservations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_capacity_reservations" ADD CONSTRAINT "budget_capacity_reservations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_capacity_settlements" ADD CONSTRAINT "budget_capacity_settlements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_capacity_settlements" ADD CONSTRAINT "budget_capacity_settlements_reservation_id_budget_capacity_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."budget_capacity_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_capacity_reservations_operation_uq" ON "budget_capacity_reservations" USING btree ("company_id","operation_kind","operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_capacity_reservations_company_state_window_idx" ON "budget_capacity_reservations" USING btree ("company_id","state","window_start","window_end");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_capacity_settlements_charge_uq" ON "budget_capacity_settlements" USING btree ("company_id","charge_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_capacity_settlements_reservation_idx" ON "budget_capacity_settlements" USING btree ("reservation_id");--> statement-breakpoint
ALTER TABLE "company_secrets" ADD CONSTRAINT "company_secrets_resolution_scope_check" CHECK ("company_secrets"."resolution_scope" IN ('general','voice_media'));