DO $$ BEGIN
  ALTER TABLE "debriefs" ADD COLUMN "goal_id" uuid REFERENCES "goals"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "briefs" ADD COLUMN "goal_id" uuid REFERENCES "goals"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "brief_items" ADD COLUMN "suggested_layer" text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "brief_items" ADD COLUMN "layer" text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "brief_items" ADD COLUMN "dedup_action" text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "brief_items" ADD COLUMN "selected_memory_id" uuid REFERENCES "memory_items"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "brief_items" ADD COLUMN "merged_content" text;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
