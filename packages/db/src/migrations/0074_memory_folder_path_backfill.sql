-- Phase 6: Backfill folderPath for memory_items created before this migration.
--
-- Rule:
--   layer = 'identity' AND department_id IS NULL  -> 'Company'
--   layer = 'working' AND department_id IS NOT NULL -> '<deptSlug>/Working'
--   department_id IS NOT NULL -> '<deptSlug>/<categoryFolder>'
--   else -> ''
--
-- deptSlug is derived from the project name using the same normalization as
-- deriveProjectUrlKey: lowercase, replace non-alphanumeric runs with '-', trim dashes.

UPDATE memory_items mi
SET folder_path = CASE
  WHEN mi.layer = 'identity' AND mi.department_id IS NULL THEN 'Company'
  WHEN mi.layer = 'working' AND mi.department_id IS NOT NULL THEN
    (SELECT trim(both '-' from regexp_replace(lower(p.name), '[^a-z0-9]+', '-', 'g'))
       FROM projects p WHERE p.id = mi.department_id) || '/Working'
  WHEN mi.department_id IS NOT NULL THEN
    (SELECT trim(both '-' from regexp_replace(lower(p.name), '[^a-z0-9]+', '-', 'g'))
       FROM projects p WHERE p.id = mi.department_id)
    || '/'
    || CASE mi.category
         WHEN 'decision'   THEN 'Decisions'
         WHEN 'reference'  THEN 'References'
         WHEN 'context'    THEN 'References'
         WHEN 'insight'    THEN 'References'
         WHEN 'preference' THEN 'References'
         WHEN 'procedure'  THEN 'Playbooks'
         WHEN 'policy'     THEN 'Policies'
         ELSE 'References'
       END
  ELSE ''
END
WHERE mi.folder_path = '';
--> statement-breakpoint
