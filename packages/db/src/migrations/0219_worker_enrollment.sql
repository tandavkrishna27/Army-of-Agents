CREATE TABLE IF NOT EXISTS "worker_enrollment_code_routes" (
	"locator_hash" text PRIMARY KEY NOT NULL,
	"candidate_organization_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_enrollment_code_routes_locator_hash_check" CHECK (locator_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worker_enrollment_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"execution_target_id" uuid NOT NULL,
	"target_authority_key" text NOT NULL,
	"locator_hash" text NOT NULL,
	"secret_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"semantic_idempotency_key" text,
	"semantic_digest" text,
	"device_thumbprint" text,
	"semantic_result" jsonb,
	"created_by_principal_kind" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_enrollment_codes_locator_uq" UNIQUE("locator_hash"),
	CONSTRAINT "worker_enrollment_codes_scope_check" CHECK ((
        scope = 'platform' AND organization_id IS NULL AND owner_user_id IS NULL AND target_authority_key = 'platform'
      ) OR (
        scope = 'organization' AND organization_id IS NOT NULL AND owner_user_id IS NULL AND
        (target_authority_key = 'platform' OR target_authority_key = 'organization:' || organization_id::text)
      ) OR (
        scope = 'owner' AND organization_id IS NOT NULL AND owner_user_id IS NOT NULL AND
        target_authority_key = 'owner:' || organization_id::text || ':' || owner_user_id
      )),
	CONSTRAINT "worker_enrollment_codes_digest_check" CHECK (locator_hash ~ '^[0-9a-f]{64}$' AND secret_hash ~ '^[0-9a-f]{64}$' AND
        (semantic_digest IS NULL OR semantic_digest ~ '^[0-9a-f]{64}$') AND
        (device_thumbprint IS NULL OR device_thumbprint ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "worker_enrollment_codes_result_atomic_check" CHECK ((
        consumed_at IS NULL AND semantic_idempotency_key IS NULL AND semantic_digest IS NULL AND
        device_thumbprint IS NULL AND semantic_result IS NULL
      ) OR (
        consumed_at IS NOT NULL AND semantic_idempotency_key IS NOT NULL AND semantic_digest IS NOT NULL AND
        device_thumbprint IS NOT NULL AND semantic_result IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worker_proof_replays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"device_thumbprint" text NOT NULL,
	"proof_id" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_proof_replays_device_proof_uq" UNIQUE("device_thumbprint","proof_id"),
	CONSTRAINT "worker_proof_replays_thumbprint_check" CHECK (device_thumbprint ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "execution_targets" DROP CONSTRAINT IF EXISTS "execution_targets_owner_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "workers" ALTER COLUMN "owner_user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "execution_targets" ADD COLUMN IF NOT EXISTS "scope" text;--> statement-breakpoint
ALTER TABLE "execution_targets" ADD COLUMN IF NOT EXISTS "target_authority_key" text;--> statement-breakpoint
ALTER TABLE "execution_targets" ADD COLUMN IF NOT EXISTS "device_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "execution_target_id" uuid;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "target_authority_key" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "device_public_key" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "device_thumbprint" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "device_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "profile_hash" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;--> statement-breakpoint
-- JOB-002 data-only backfill (AGENTS Rule #6 narrow exception). Pre-E3 worker
-- rows never carried device authority, so they are quarantined as revoked and
-- bound to a disabled registry target. No active device authority is fabricated.
UPDATE "execution_targets"
SET
	"scope" = CASE WHEN "organization_id" IS NULL THEN 'platform' WHEN "owner_user_id" IS NULL THEN 'organization' ELSE 'owner' END,
	"target_authority_key" = CASE
		WHEN "organization_id" IS NULL THEN 'platform'
		WHEN "owner_user_id" IS NULL THEN 'organization:' || "organization_id"::text
		ELSE 'owner:' || "organization_id"::text || ':' || "owner_user_id"
	END
WHERE "scope" IS NULL OR "target_authority_key" IS NULL;--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM "workers" WHERE "execution_target_id" IS NULL AND "scope" = 'owner' AND "owner_user_id" IS NULL) THEN
		RAISE EXCEPTION 'JOB-002 cannot safely bind a legacy owner worker without owner_user_id';
	END IF;
END $$;--> statement-breakpoint
INSERT INTO "execution_targets" (
	"id", "organization_id", "owner_user_id", "slug", "kind", "trust_class",
	"status", "capabilities", "config", "scope", "target_authority_key", "device_generation"
)
SELECT
	w."id", w."organization_id", w."owner_user_id",
	'legacy-worker-' || replace(w."id"::text, '-', ''),
	CASE WHEN w."scope" = 'owner' THEN 'desktop' ELSE 'dedicated_worker' END,
	CASE WHEN w."scope" = 'platform' THEN 'local_trusted' ELSE 'dedicated_tenant' END,
	'disabled', '{}'::jsonb, '{"migration":"JOB-002","authority":"none"}'::jsonb,
	w."scope",
	CASE
		WHEN w."scope" = 'platform' THEN 'platform'
		WHEN w."scope" = 'organization' THEN 'organization:' || w."organization_id"::text
		ELSE 'owner:' || w."organization_id"::text || ':' || w."owner_user_id"
	END,
	1
FROM "workers" w
WHERE w."execution_target_id" IS NULL
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "workers" w
SET
	"execution_target_id" = w."id",
	"target_authority_key" = CASE
		WHEN w."scope" = 'platform' THEN 'platform'
		WHEN w."scope" = 'organization' THEN 'organization:' || w."organization_id"::text
		ELSE 'owner:' || w."organization_id"::text || ':' || w."owner_user_id"
	END,
	"status" = 'revoked',
	"revoked_at" = COALESCE(w."revoked_at", now())
WHERE w."execution_target_id" IS NULL;--> statement-breakpoint
-- C14 hand-appended guards: drizzle-kit cannot make ADD CONSTRAINT replay-safe.
DO $$ BEGIN ALTER TABLE "execution_targets" ADD CONSTRAINT "execution_targets_authority_id_uq" UNIQUE("target_authority_key","id"); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worker_enrollment_code_routes" ADD CONSTRAINT "worker_enrollment_code_routes_candidate_organization_id_organizations_id_fk" FOREIGN KEY ("candidate_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worker_enrollment_codes" ADD CONSTRAINT "worker_enrollment_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worker_enrollment_codes" ADD CONSTRAINT "worker_enrollment_codes_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worker_enrollment_codes" ADD CONSTRAINT "worker_enrollment_codes_target_authority_fk" FOREIGN KEY ("target_authority_key","execution_target_id") REFERENCES "public"."execution_targets"("target_authority_key","id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "worker_proof_replays" ADD CONSTRAINT "worker_proof_replays_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_enrollment_code_routes_expiry_idx" ON "worker_enrollment_code_routes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_enrollment_codes_expiry_idx" ON "worker_enrollment_codes" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_enrollment_codes_replay_idx" ON "worker_enrollment_codes" USING btree ("organization_id","semantic_idempotency_key","semantic_digest");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_proof_replays_expiry_idx" ON "worker_proof_replays" USING btree ("expires_at");--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "execution_targets" ADD CONSTRAINT "execution_targets_owner_user_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workers" ADD CONSTRAINT "workers_target_authority_fk" FOREIGN KEY ("target_authority_key","execution_target_id") REFERENCES "public"."execution_targets"("target_authority_key","id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workers" ADD CONSTRAINT "workers_owner_user_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_execution_target_idx" ON "workers" USING btree ("execution_target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workers_platform_target_uq" ON "workers" USING btree ("execution_target_id") WHERE "workers"."scope" = 'platform';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workers_organization_target_uq" ON "workers" USING btree ("organization_id","execution_target_id") WHERE "workers"."scope" = 'organization';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workers_owner_target_uq" ON "workers" USING btree ("organization_id","execution_target_id","owner_user_id") WHERE "workers"."scope" = 'owner';--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "execution_targets" ADD CONSTRAINT "execution_targets_authority_scope_check" CHECK ((
        scope = 'platform' AND organization_id IS NULL AND owner_user_id IS NULL AND target_authority_key = 'platform'
      ) OR (
        scope = 'organization' AND organization_id IS NOT NULL AND owner_user_id IS NULL AND
        target_authority_key = 'organization:' || organization_id::text
      ) OR (
        scope = 'owner' AND organization_id IS NOT NULL AND owner_user_id IS NOT NULL AND
        target_authority_key = 'owner:' || organization_id::text || ':' || owner_user_id
      )); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workers" ADD CONSTRAINT "workers_scope_owner_check" CHECK ((scope = 'owner' AND owner_user_id IS NOT NULL) OR (scope IN ('platform', 'organization') AND owner_user_id IS NULL)); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workers" ADD CONSTRAINT "workers_target_scope_check" CHECK ((
        scope = 'platform' AND target_authority_key = 'platform'
      ) OR (
        scope = 'organization' AND (
          target_authority_key = 'platform' OR target_authority_key = 'organization:' || organization_id::text
        )
      ) OR (
        scope = 'owner' AND target_authority_key = 'owner:' || organization_id::text || ':' || owner_user_id
      )); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workers" ADD CONSTRAINT "workers_device_identity_check" CHECK (status = 'revoked' OR (
        device_public_key IS NOT NULL AND device_thumbprint IS NOT NULL AND profile_hash IS NOT NULL AND enrolled_at IS NOT NULL
      )); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
