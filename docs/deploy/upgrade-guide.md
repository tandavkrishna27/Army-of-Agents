---
title: "Upgrading from Paperclip"
summary: "Migration steps from a Paperclip-era install to AoA"
---

Marketplace managed-root selection and rollback are covered in
[Marketplace recovery](/guides/board-operator/marketplace-recovery).

If you've been running this project under the legacy "Paperclip" name (or any version &le; 1.0.0-rc.5), this guide covers exactly what changes when you upgrade to the AoA-rebranded release. Most things are automatic — read through the sections below to know what, if anything, you need to touch.

## What's automatic (no action required)

The following migrations happen silently on first boot. You do not need to run any scripts or change any config files for these.

**Home directory fallback.** The CLI checks for `~/.aoa/` at startup. If that directory does not exist but `~/.paperclip/` does, it reads from `~/.paperclip/` transparently for one release cycle (`cli/src/config/home.ts`). Your existing instance data, embedded Postgres, logs, and secrets are all picked up without copying anything.

**Environment variable mirroring.** Both `server/src/env-compat.ts` and `cli/src/config/env-compat.ts` run at module import and copy every `PAPERCLIP_<KEY>` env var to `AOA_<KEY>` unless the `AOA_` version is already set. Any shell profile or `.env` file using `PAPERCLIP_*` variables keeps working at runtime with no changes.

**localStorage migration.** On first UI load, `ui/src/lib/storage-migrations.ts` moves all `paperclip:*` and `paperclip.*` keys to their `aoa:*` equivalents — theme preference, sidebar state, selected company, project order, issue drafts, and more. The migration is idempotent; it runs on every boot but is a no-op once the old keys are gone.

**DB sentinel rewrite.** Migration `0060_aoa_sentinels.sql` runs as part of the normal `db:migrate` step and is idempotent. It rewrites two in-row sentinels:
- `project_workspaces.cwd`: `/__paperclip_repo_only__` → `/__aoa_repo_only__`
- `agent_wakeup_requests.payload` (jsonb): `_paperclipWakeContext` key → `_aoaWakeContext` key

If you roll back code after this migration has run, the server already has dual-read for both key names, so older rows remain usable.

**Log prefix change.** Adapter log lines change from `[paperclip]` to `[aoa]`. This is cosmetic, but if you have log aggregation rules (Datadog, Loki, etc.) filtering on the `[paperclip]` prefix, update those filters.

## What requires user action

**Docker data mount.** Current Compose mounts the `aoa-data` volume at `/aoa`
and sets `AOA_HOME=/aoa`. The image keeps `/paperclip` only as a compatibility
symlink to `/aoa`. A legacy deployment that mounted real data directly at
`/paperclip` must move or restore that data into the `/aoa` volume before
starting the current image; the entrypoint refuses two divergent roots.

You have two options:

| Option | How |
|--------|-----|
| Rename the host directory | `mv ./data/docker-paperclip ./data/docker-aoa` |
| Keep the old name | Set `AOA_DATA_DIR=./data/docker-paperclip` before `docker compose up` |

**Docker Compose database volumes.** The default multi-service Compose stack now
uses `pgvector/pgvector:pg18`, an `aoa-postgres` volume, and the Postgres 18
storage layout at `/var/lib/postgresql`. Older simple Compose installs used a
different volume name and Postgres 17 layout. Do not mount an old Postgres 17
data directory directly into the new stack. Back up with `pg_dump` or an
equivalent database backup from the old stack, then restore into the new
database.

**Shell profile env vars.** `PAPERCLIP_HOME=/foo` continues to work at runtime via env-compat mirroring, but plan to rename it to `AOA_HOME` at your next convenience — the mirror will be removed in a future major.

**CLI command.** In a source checkout, `pnpm aoa` is canonical and
`pnpm paperclipai` remains a repository-local compatibility alias. The npm
packages named `aoa` and `paperclipai` belong to other projects; do not use
either through `npx` for MeteoriteLabs AoA. A future scoped CLI release will
publish its exact, smoke-tested install command separately.

## What stays the same forever

These identifiers are wire-compat and will not change. See [Wire Compatibility Reference](../architecture/wire-compat.md) for the full contract.

- `paperclipai` CLI bin alias
- `X-Paperclip-Run-Id` HTTP header
- `_paperclipWakeContext` legacy DB key (dual-read supported)
- `paperclip_session_key` and `paperclip_stream_transport` OpenClaw wire fields
- `paperclip-feedback-envelope-v2` schema version string
- `paperclipPlugin` manifest key and plugin globals
- `@paperclipai/*` npm package scope (upstream Paperclip packages; AoA cannot rename these)

## Step-by-step upgrade

1. **Pull the new release.**
   ```bash
   git pull
   ```

2. **Stop the running server.**
   ```bash
   # local dev
   # Ctrl-C the pnpm dev process, or:
   pkill -f "pnpm dev"
   ```

3. **Install updated dependencies.**
   ```bash
   pnpm install
   ```

4. **Run database migrations.**
   ```bash
   AOA_DEPLOYMENT_MODE=authenticated pnpm db:migrate
   ```
   If you have `AOA_MIGRATION_AUTO_APPLY=true` set, migrations run automatically on server start — you can skip this step.

   Replace `authenticated` with the deployment's configured mode. Before
   applying migration `0188` to a populated `cloud_auth` database, take
   a full database snapshot and record `"0188"` in `general.migrationSnapshots`
   on the canonical `instance_settings` row where `singleton_key = 'default'`:

   ```sql
   INSERT INTO instance_settings (singleton_key, general)
   VALUES ('default', '{"migrationSnapshots":["0188"]}'::jsonb)
   ON CONFLICT (singleton_key) DO UPDATE
   SET general = jsonb_set(
         instance_settings.general,
         '{migrationSnapshots}',
         (
           SELECT CASE
             WHEN cleaned.markers @> '["0188"]'::jsonb THEN cleaned.markers
             ELSE cleaned.markers || '["0188"]'::jsonb
           END
           FROM (
             SELECT COALESCE(jsonb_agg(candidate.marker), '[]'::jsonb) AS markers
             FROM jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(instance_settings.general->'migrationSnapshots') = 'array'
                   THEN instance_settings.general->'migrationSnapshots'
                 ELSE '[]'::jsonb
               END
             ) AS candidate(marker)
             WHERE jsonb_typeof(candidate.marker) = 'string'
           ) AS cleaned
         ),
         true
       ),
       updated_at = now();

   SELECT general->'migrationSnapshots' AS migration_snapshots
   FROM instance_settings
   WHERE singleton_key = 'default';
   ```

   The command must insert or update exactly one row and the verification
   result must contain `"0188"`; otherwise stop. Keep every application replica
   stopped from this marker operation until the migration job completes, so no
   settings writer can race the cutover. The same gate is enforced by
   server auto-apply and `pnpm db:migrate`. A manual migration with no explicit
   deployment mode fails closed for this one-way cutover rather than assuming
   local trusted mode.

5. **Restart the server.**
   ```bash
   # local dev
   pnpm dev

   # production
   pnpm aoa run
   ```

6. **(Docker only)** If you had a custom host bind path, set `AOA_DATA_DIR` first, then pull and restart:
   ```bash
   export AOA_DATA_DIR=./data/docker-paperclip   # only if keeping old path
   docker compose pull
   docker compose up -d
   ```

7. **Verify.** The health endpoint should return `200 OK`:
   ```bash
   curl http://localhost:3100/api/health
   ```

## Rollback

If you need to return to a Paperclip-era version:

**Code rollback:**
```bash
git checkout <previous-tag>
pnpm install
```

**Database:** `0060_aoa_sentinels.sql` is data-only and idempotent. Rolling back the code is safe because the server already has dual-read for both `_paperclipWakeContext` and `_aoaWakeContext` keys. The main risk is a version that writes only the new `_aoaWakeContext` key being rolled back to code that only reads `_paperclipWakeContext`. Avoid rolling back across the migration boundary unless absolutely necessary.

## Common upgrade-time errors

**"Theme reset to dark on second reload."**
The FOUC bootstrap script in `ui/index.html` migrates `paperclip.theme` → `aoa.theme` on the first page load. The second reload reads only `aoa.theme`. If you unexpectedly land in dark mode, check:
```js
localStorage.getItem("aoa.theme")
```
Set it to `"light"` if it's missing or wrong.

**"Existing OpenClaw clients can't connect."**
The `paperclip_session_key` and `paperclip_stream_transport` wire fields are intentionally kept as `paperclip_*` per the Phase 6 wire-compat deferral. No action required — this is expected behavior.

**"Plugin won't load."**
Check the plugin manifest. The original `paperclipPlugin` key is still supported. If the plugin was updated to use the new `aoaPlugin` alias, ensure you're running a version of AoA that recognizes it (both are supported). If in doubt, revert the manifest to `paperclipPlugin`.

## Log filter migration

Commit `97eeddc` renamed every AoA-emitted log prefix from `[paperclip]` to `[aoa]`. If you have log aggregation rules, alerting queries, or tail/grep scripts that filter on `[paperclip]`, they are now silently dead — they will match nothing in logs produced by v1.0.0 and later.

An audit script (`scripts/find-dead-paperclip-filters.mjs`) was run against the full codebase at the time of the v1.0.0 release and returned **no operator-side filter consumers** in shipping code. The only codebase occurrence of `[paperclip]` as a parsed string is in `ui/src/components/workspace/transcript/normalize-transcript.ts`, which matches the *upstream Claude CLI binary's* stderr output — not an AoA-emitted prefix — and is intentionally preserved.

### What to update on the operator side

If you run any of the following, update them before or immediately after upgrading:

| Consumer type | Old filter | New filter | Notes |
|---|---|---|---|
| Shell tail / grep | `grep '\[paperclip\]'` | `grep '\[aoa\]'` | Or dual-match for one release: `grep -E '\[(aoa\|paperclip)\]'` |
| Datadog log query | `@message:[paperclip]` | `@message:[aoa]` | Update in Logs → Saved Views and any Monitor queries |
| Loki / Grafana | `\|= "[paperclip]"` | `\|= "[aoa]"` | Check LogQL in dashboards and alert rules |
| Splunk | `"[paperclip]"` | `"[aoa]"` | Search, saved searches, and alerts |
| k8s log-router (Fluentd / Vector) | `grep_pattern: '\[paperclip\]'` | `grep_pattern: '\[aoa\]'` | Check DaemonSet ConfigMaps |
| CloudWatch Insights | `filter @message like /\[paperclip\]/` | `filter @message like /\[aoa\]/` | Update metric filters and log group dashboards |

### Dual-match for zero-downtime rollouts

If you are running a rolling upgrade (some nodes on the old version, some on the new), use a dual-match filter for one release cycle to avoid gaps:

```sh
# Shell
grep -E '\[(aoa|paperclip)\]' /var/log/aoa/server.log

# Loki
{app="aoa"} |~ `\[(aoa|paperclip)\]`
```

Remove the `paperclip` branch once all nodes are upgraded.

### Exception: normalize-transcript.ts upstream CLI filter

The filter `[paperclip] skipping saved session resume` in the workspace transcript normalizer matches stderr from the upstream Claude CLI binary (which still emits that prefix). Do **not** update that string — it will break session-resume suppression for users on older CLI versions. Track the upstream CLI changelog to know when the CLI itself renames its prefix.
