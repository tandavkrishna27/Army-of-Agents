WITH ranked AS (
  SELECT
    ew.id,
    ROW_NUMBER() OVER (
      PARTITION BY ew.company_id, ew.source_issue_id
      ORDER BY
        CASE WHEN i.execution_workspace_id = ew.id THEN 0 ELSE 1 END,
        ew.last_used_at DESC,
        ew.created_at DESC,
        ew.id DESC
    ) AS rn
  FROM execution_workspaces ew
  LEFT JOIN issues i ON i.id = ew.source_issue_id
  WHERE ew.source_issue_id IS NOT NULL
    AND ew.status <> 'archived'
)
UPDATE execution_workspaces ew
SET status = 'archived',
    cleanup_reason = COALESCE(ew.cleanup_reason, 'archived_duplicate_before_active_task_workspace_unique_index'),
    closed_at = COALESCE(ew.closed_at, now()),
    updated_at = now()
FROM ranked
WHERE ew.id = ranked.id
  AND ranked.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_workspaces_active_task_workspace_uq" ON "execution_workspaces" USING btree ("company_id","source_issue_id") WHERE source_issue_id IS NOT NULL AND status <> 'archived';
