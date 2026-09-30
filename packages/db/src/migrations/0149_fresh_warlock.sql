DROP INDEX "provider_quota_windows_company_window_unique_idx";--> statement-breakpoint
-- A-H12 pre-index dedup: the old btree treated NULL as DISTINCT, so the
-- model-less upsert in quota-windows.ts never matched existing NULL-model rows
-- and accumulated duplicate (company_id, provider, model=NULL, window_kind)
-- rows. The NULLS NOT DISTINCT constraint below would FAIL on that dirty data,
-- so collapse each duplicate group to its newest row first. Newest = highest
-- last_updated_at (NULLs last), tie-broken by ctid. row_number()=1 is kept;
-- the rest are deleted. NULL-grouping in PARTITION BY treats NULL models as a
-- single group (SQL GROUP BY/window semantics), which is exactly what we want.
DELETE FROM "provider_quota_windows" a USING (
  SELECT ctid, row_number() OVER (
    PARTITION BY company_id, provider, model, window_kind
    ORDER BY last_updated_at DESC NULLS LAST, ctid DESC
  ) AS rn
  FROM "provider_quota_windows"
) b
WHERE a.ctid = b.ctid AND b.rn > 1;--> statement-breakpoint
ALTER TABLE "provider_quota_windows" ADD CONSTRAINT "provider_quota_windows_company_window_unique_idx" UNIQUE NULLS NOT DISTINCT("company_id","provider","model","window_kind");