CREATE TABLE IF NOT EXISTS "marketplace_reconciliation_operations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"state" text DEFAULT 'claimed' NOT NULL,
	"deployment_sha" text NOT NULL,
	"target_count" integer DEFAULT 0 NOT NULL,
	"target_company_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
	"catalog" jsonb,
	"active_slot" integer DEFAULT 1 NOT NULL,
	"lease_owner_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_reconciliation_operations_state_check" CHECK ("marketplace_reconciliation_operations"."state" in (
        'claimed',
        'running',
        'success',
        'partial',
        'failed_before_mutation',
        'outcome_unknown_after_mutation'
      )),
	CONSTRAINT "marketplace_reconciliation_operations_active_slot_check" CHECK ("marketplace_reconciliation_operations"."active_slot" = 1),
	CONSTRAINT "marketplace_reconciliation_operations_lease_check" CHECK ((
        ("marketplace_reconciliation_operations"."state" in ('claimed', 'running')
          and "marketplace_reconciliation_operations"."lease_owner_id" is not null
          and "marketplace_reconciliation_operations"."lease_expires_at" is not null)
        or
        ("marketplace_reconciliation_operations"."state" not in ('claimed', 'running')
          and "marketplace_reconciliation_operations"."lease_owner_id" is null
          and "marketplace_reconciliation_operations"."lease_expires_at" is null)
      ))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_reconciliation_operations_state_updated_idx" ON "marketplace_reconciliation_operations" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_reconciliation_operations_one_active_idx" ON "marketplace_reconciliation_operations" USING btree ("active_slot") WHERE "marketplace_reconciliation_operations"."state" in ('claimed', 'running');
