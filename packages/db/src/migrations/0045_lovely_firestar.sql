CREATE TABLE "budget_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"threshold_type" text NOT NULL,
	"amount_limit_cents" integer NOT NULL,
	"amount_observed_cents" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"approval_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"metric" text DEFAULT 'cost_cents' NOT NULL,
	"window_kind" text DEFAULT 'calendar_month_utc' NOT NULL,
	"amount_cents" integer NOT NULL,
	"warn_percent" integer DEFAULT 80 NOT NULL,
	"hard_stop_enabled" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_policy_id_budget_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_incidents" ADD CONSTRAINT "budget_incidents_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_incidents_open_unique_idx" ON "budget_incidents" USING btree ("policy_id","window_start","threshold_type") WHERE status <> 'dismissed';--> statement-breakpoint
CREATE INDEX "budget_incidents_company_status_idx" ON "budget_incidents" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_policies_scope_unique_idx" ON "budget_policies" USING btree ("company_id","scope_type","scope_id","metric","window_kind");--> statement-breakpoint
CREATE INDEX "budget_policies_company_active_idx" ON "budget_policies" USING btree ("company_id","is_active");