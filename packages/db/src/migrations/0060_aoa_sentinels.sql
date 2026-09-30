-- Migrate Paperclip -> AoA in-row sentinels.
-- Idempotent: every UPDATE has a WHERE that drops it to a no-op on rerun.

-- 1. project_workspaces.cwd: replace literal sentinel string.
UPDATE project_workspaces
SET cwd = '/__aoa_repo_only__'
WHERE cwd = '/__paperclip_repo_only__';
--> statement-breakpoint
-- 2. agent_wakeup_requests.payload (jsonb): rename top-level key
--    _paperclipWakeContext -> _aoaWakeContext, preserving the value
--    and any sibling keys.
--    The AND NOT clause guards against the edge case where a row has
--    BOTH keys (e.g. concurrent dual-write under partial-outage); we
--    never overwrite a freshly-written _aoaWakeContext value.
UPDATE agent_wakeup_requests
SET payload = (payload - '_paperclipWakeContext')
              || jsonb_build_object('_aoaWakeContext', payload -> '_paperclipWakeContext')
WHERE payload ? '_paperclipWakeContext'
  AND NOT (payload ? '_aoaWakeContext');

-- 3. agent_wakeup_requests.payload: clean up rows that ended up with
--    BOTH keys -- drop the legacy key, keep the freshly-written AoA one.
UPDATE agent_wakeup_requests
SET payload = payload - '_paperclipWakeContext'
WHERE payload ? '_paperclipWakeContext'
  AND payload ? '_aoaWakeContext';
