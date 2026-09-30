-- Phase 6.0 polish: seed memory_folders rows for companies and departments
-- that existed before Phase 6.0 shipped.
--
-- Idempotent: relies on the unique index memory_folders_unique_path_per_company
-- to silently skip rows that already exist (covers the case where a company or
-- department was created AFTER 6.0 shipped via the create-hook).
--
-- Safe to re-run: ON CONFLICT DO NOTHING short-circuits duplicate inserts.

-- ── 1. Company root folder for every existing company ────────────────────────
INSERT INTO memory_folders (company_id, department_id, path, display_name, icon, seed_key, sort_order)
SELECT c.id, NULL, 'Company', 'Company', '🏛️', 'company.root', 0
FROM companies c
ON CONFLICT (company_id, path) DO NOTHING;
--> statement-breakpoint

-- ── 2. Department-scoped seed folders ────────────────────────────────────────
-- For each department (projects with type='department'), insert the appropriate
-- seed-folder set based on its functionType. Path is derived as
-- `<deptSlug>/<seedFolder>` where deptSlug = trim(both '-' from
-- regexp_replace(lower(p.name), '[^a-z0-9]+', '-', 'g')) — same normalization
-- as deriveProjectUrlKey() in TS, and same approach 0074 uses. The projects
-- table has no stored url_key column; urlKey is computed at the service layer.

WITH dept_slugs AS (
  SELECT
    p.id,
    p.company_id,
    trim(both '-' from regexp_replace(lower(p.name), '[^a-z0-9]+', '-', 'g')) AS slug,
    p.function_type
  FROM projects p
  WHERE p.type = 'department'
),
seed_rows AS (
  -- software_development
  SELECT id, company_id, slug, 'Decisions' AS path, 'Decisions' AS display_name, NULL::text AS icon, 'software_development.decisions' AS seed_key FROM dept_slugs WHERE function_type = 'software_development'
  UNION ALL SELECT id, company_id, slug, 'Playbooks', 'Playbooks', NULL, 'software_development.playbooks' FROM dept_slugs WHERE function_type = 'software_development'
  UNION ALL SELECT id, company_id, slug, 'References', 'References', NULL, 'software_development.references' FROM dept_slugs WHERE function_type = 'software_development'
  UNION ALL SELECT id, company_id, slug, 'Architecture', 'Architecture', NULL, 'software_development.architecture' FROM dept_slugs WHERE function_type = 'software_development'
  UNION ALL SELECT id, company_id, slug, 'Files', 'Files', '📁', 'software_development.files' FROM dept_slugs WHERE function_type = 'software_development'
  -- marketing
  UNION ALL SELECT id, company_id, slug, 'Decisions', 'Decisions', NULL, 'marketing.decisions' FROM dept_slugs WHERE function_type = 'marketing'
  UNION ALL SELECT id, company_id, slug, 'Brand', 'Brand', NULL, 'marketing.brand' FROM dept_slugs WHERE function_type = 'marketing'
  UNION ALL SELECT id, company_id, slug, 'Campaigns', 'Campaigns', NULL, 'marketing.campaigns' FROM dept_slugs WHERE function_type = 'marketing'
  UNION ALL SELECT id, company_id, slug, 'References', 'References', NULL, 'marketing.references' FROM dept_slugs WHERE function_type = 'marketing'
  UNION ALL SELECT id, company_id, slug, 'Files', 'Files', '📁', 'marketing.files' FROM dept_slugs WHERE function_type = 'marketing'
  -- customer_support
  UNION ALL SELECT id, company_id, slug, 'Playbooks', 'Playbooks', NULL, 'customer_support.playbooks' FROM dept_slugs WHERE function_type = 'customer_support'
  UNION ALL SELECT id, company_id, slug, 'Macros', 'Macros', NULL, 'customer_support.macros' FROM dept_slugs WHERE function_type = 'customer_support'
  UNION ALL SELECT id, company_id, slug, 'References', 'References', NULL, 'customer_support.references' FROM dept_slugs WHERE function_type = 'customer_support'
  UNION ALL SELECT id, company_id, slug, 'Files', 'Files', '📁', 'customer_support.files' FROM dept_slugs WHERE function_type = 'customer_support'
  -- generic (everything else, including null functionType)
  UNION ALL SELECT id, company_id, slug, 'Decisions', 'Decisions', NULL, 'generic.decisions' FROM dept_slugs WHERE function_type IS NULL OR function_type NOT IN ('software_development', 'marketing', 'customer_support')
  UNION ALL SELECT id, company_id, slug, 'Policies', 'Policies', NULL, 'generic.policies' FROM dept_slugs WHERE function_type IS NULL OR function_type NOT IN ('software_development', 'marketing', 'customer_support')
  UNION ALL SELECT id, company_id, slug, 'References', 'References', NULL, 'generic.references' FROM dept_slugs WHERE function_type IS NULL OR function_type NOT IN ('software_development', 'marketing', 'customer_support')
  UNION ALL SELECT id, company_id, slug, 'Files', 'Files', '📁', 'generic.files' FROM dept_slugs WHERE function_type IS NULL OR function_type NOT IN ('software_development', 'marketing', 'customer_support')
)
INSERT INTO memory_folders (company_id, department_id, path, display_name, icon, seed_key, sort_order)
SELECT
  sr.company_id,
  sr.id AS department_id,
  sr.slug || '/' || sr.path AS path,
  sr.display_name,
  sr.icon,
  sr.seed_key,
  0
FROM seed_rows sr
WHERE sr.slug IS NOT NULL AND sr.slug <> ''
ON CONFLICT (company_id, path) DO NOTHING;
--> statement-breakpoint
