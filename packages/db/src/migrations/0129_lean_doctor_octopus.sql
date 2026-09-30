-- Task 1.1 (Crew Work-as-Tasks): board index for crew_thread queries scoped by company.
-- IF NOT EXISTS follows the C14 idempotency rule
-- (see packages/db/src/__tests__/migration-idempotency.test.ts).
CREATE INDEX IF NOT EXISTS "issues_company_origin_kind_idx" ON "issues" USING btree ("company_id","origin_kind");