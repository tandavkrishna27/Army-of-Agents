DO $$ BEGIN
  ALTER TABLE "heartbeat_runs" ADD COLUMN "detected_outputs" jsonb;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;