-- C14 hand-appended idempotency guard; drizzle-kit cannot emit replay-safe ADD CONSTRAINT.
DO $$ BEGIN ALTER TABLE "workers" ADD CONSTRAINT "workers_org_id_authority_target_uq" UNIQUE("organization_id","id","target_authority_key","execution_target_id"); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
