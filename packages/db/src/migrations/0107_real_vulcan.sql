CREATE UNIQUE INDEX IF NOT EXISTS "agents_aoa_name_per_company_idx" ON "agents" USING btree ("company_id","name") WHERE "agents"."kind" = 'aoa';
