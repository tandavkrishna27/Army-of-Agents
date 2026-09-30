---
title: Database
summary: Embedded Postgres vs Docker Postgres vs hosted
---

AoA uses PostgreSQL via Drizzle ORM. There are three ways to run the database. The "embedded" mode bundles a real Postgres binary via [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres) — **not** WASM-based PGlite. Drop-in compatibility with regular Postgres clients, dump tools, and migrations.

## 1. Embedded PostgreSQL (Default)

Zero config. If you don't set `DATABASE_URL`, the server starts an embedded PostgreSQL instance automatically.

```sh
pnpm dev
```

On first start, the server:

1. Creates `~/.aoa/instances/default/db/` for storage (legacy `~/.paperclip/` is still used as a fallback if it exists and `~/.aoa/` does not, see `cli/src/config/home.ts`)
2. Ensures the `paperclip` database exists (database NAME inside Postgres is wire-compat with the embedded cluster bootstrap, separate from the AoA brand)
3. Runs migrations automatically
4. Starts serving requests

Data persists across restarts. To reset: `rm -rf ~/.aoa/instances/default/db`.

The Docker quickstart also uses embedded PostgreSQL by default.

## 2. Docker Compose PostgreSQL

The default Docker Compose stack runs AoA with a durable PostgreSQL database that includes pgvector:

```sh
docker compose up --build -d
```

Inside the stack, the server gets `DATABASE_URL=postgres://paperclip:paperclip@db:5432/paperclip` automatically. The database is not published on `localhost:5432` by default; it is only reachable by services on the Compose network.

Open a psql shell with:

```sh
docker compose --profile tools run --rm psql
```

If you want to run the Node server on the host while using the Compose database, add a local override that publishes Postgres:

```yaml
services:
  db:
    ports:
      - "5432:5432"
```

Then set the connection string for the host process.

> **The server does NOT auto-load a repo-root `.env`.** It only reads `.env` from the AoA config directory — the directory containing the active `config.json` (default `~/.aoa/instances/default/`, or the nearest `.aoa/config.json` found by walking up from the working directory; see `server/src/paths.ts` and `server/src/config.ts`). Copying `.env.example` to the repo root has no effect. Either set `DATABASE_URL` inline / export it in your shell, or place the `.env` in the config directory.

```sh
# Either export it for the session:
export DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
# …or write it into the AoA config dir's .env (NOT the repo root):
#   ~/.aoa/instances/default/.env
```

For a disposable local development database only, you can push the current
schema directly:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

Do not use `drizzle-kit push` for an existing or production database. It skips
the migration journal, data backfills, and migration safety gates. Use
`pnpm db:migrate` for upgrades.

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted provider like [Supabase](https://supabase.com/).

1. Create a project at [database.new](https://database.new)
2. Copy the connection string from Project Settings > Database
3. Set `DATABASE_URL` in your `.env`

Use the **direct connection** (port 5432) for migrations and the **pooled connection** (port 6543) for the application.

### Migrations in multi-replica cloud deployments

On boot the server auto-applies any pending migrations
(`applyPendingMigrations` in `packages/db/src/client.ts`). In a horizontally
scaled cloud deployment, **run migrations as a single init-job / one-shot
container that finishes before the application replicas start**, rather than
relying on every replica's boot-time auto-apply. Two replicas booting at once
can otherwise observe the same pending set and race non-idempotent DDL (an
`ADD COLUMN` / `ADD CONSTRAINT` without `IF NOT EXISTS`).

As defense-in-depth, `applyPendingMigrations` holds a **session-level
PostgreSQL advisory lock** (`pg_advisory_lock(hashtext('aoa:migrations'))`)
across the whole inspect-and-apply, so if two replicas do auto-apply
concurrently only one runs the migrator; the other waits, re-inspects under the
lock, and finds the schema already up to date. This is a safety net, **not** a
substitute for a single migration job.

The init job must set `AOA_DEPLOYMENT_MODE=cloud_auth`. Migration `0188` is a
one-way multi-tenant cutover for populated databases, so the shared migrator
refuses to apply it until a full database snapshot has been taken and `"0188"`
has been recorded in the canonical `instance_settings` row where
`singleton_key = 'default'`, under `general.migrationSnapshots`. Record and
verify the marker explicitly before starting the migration job:

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

The command must insert or update exactly one row and the verification result
must contain `"0188"`. If it does not, stop instead of applying migration
`0188`. Keep every application replica stopped from this marker operation until
the migration job completes, so no settings writer can race the cutover. If the
manual migrator cannot determine the deployment mode, it also fails closed for
that populated 0188 case instead of assuming a trusted local deployment.

Migration `0200` adds process-owner provenance for persisted local runtime
PIDs. Drain and stop every pre-`0200` application binary before starting the
new replicas: old binaries do not understand the owner column and can still
probe or signal foreign numeric PIDs. The nullable column is intentionally not
backfilled because legacy PID ownership cannot be inferred safely. In
`cloud_auth`, an ownerless legacy PID row blocks startup until an operator has
stopped the process on its original host and cleared the persisted PID. Trusted
single-owner modes preserve legacy/foreign rows but skip desired-service
auto-restart until those rows are remediated, preventing duplicate detached
commands and port conflicts.

The same migration changes adapter-managed runtime IDs from globally trusted
adapter values to company-namespaced hashes. As a one-time cutover it retires
all pre-`0200` `adapter_managed` runtime rows, marks their task outputs stopped,
and clears their preview URLs before deleting the old rows. Active adapters
publish fresh company-scoped rows on their next report. Expect a brief preview
refresh after deployment; old preview links intentionally stop working.

While any PID-bearing `local_process` row remains in the shared database,
every `cloud_auth` replica must have its own explicit, unique
`AOA_RUNTIME_PROCESS_OWNER_ID`; a replica with the variable unset refuses to
boot because it cannot safely distinguish its own prior process rows from a
foreign host's. Normal production cloud deployments should remediate these
rows and leave the unsandboxed execution override disabled.

### Offline remediation for migration 0200 runtime rows

Use the runtime-service IDs printed in the startup error. First stop the old
AoA binary and confirm on the original process host that each recorded PID and
its process group/tree are gone. Do **not** use the SQL below as a process-stop
mechanism: it only repairs tracking after OS-level termination has been
independently confirmed. Take a database backup, substitute the exact UUIDs,
and inspect the locked rows before updating them:

```sql
BEGIN;

SELECT id, provider, status, provider_ref, process_owner_id, started_at
FROM workspace_runtime_services
WHERE id IN ('00000000-0000-0000-0000-000000000000')
FOR UPDATE;

-- Continue only after every listed PID/process group is confirmed absent on
-- its original host. Otherwise ROLLBACK and remediate the OS process first.
UPDATE workspace_runtime_services
SET provider_ref = NULL,
    process_owner_id = NULL,
    status = 'stopped',
    health_status = 'unknown',
    stopped_at = now(),
    last_used_at = now(),
    updated_at = now()
WHERE id IN ('00000000-0000-0000-0000-000000000000')
  AND provider = 'local_process';

COMMIT;
```

Verify those rows now have `provider_ref IS NULL`, then start exactly one new
application replica first. In a rolling deployment, never overlap pre-0200
binaries with the new version.

If using connection pooling, disable prepared statements:

```ts
// packages/db/src/client.ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

## Switching Between Modes

| `DATABASE_URL` | Mode |
|----------------|------|
| Not set | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The Drizzle schema (`packages/db/src/schema/`) is the same regardless of mode.

### Marketplace recovery operation ledger

Fleet marketplace reconciliation uses the
`marketplace_reconciliation_operations` table as an instance-scoped,
restart-durable operation ledger. Its primary key prevents operation-ID reuse,
and its partial unique index plus owner-scoped lease prevents two application
replicas from running different fleet reconciliations concurrently. Company
`activity_log` rows remain audit detail; they are not the operation lock or
terminal-state authority.

## Backups

AoA includes a built-in backup utility in `packages/db/src/backup-lib.ts`. It exports `runDatabaseBackup` and `runDatabaseRestore`.

### Scope

Backups include **all non-system schemas** — `public`, `drizzle`, and any other user-created schemas. This means the Drizzle migration journal (`drizzle.__drizzle_migrations`) is always included, so restored databases reflect the correct migration state and never enter a "pending migrations" limbo.

System schemas (`pg_catalog`, `information_schema`, `pg_toast*`, `pg_temp_*`) are excluded.

### Backup engine

`runDatabaseBackup` selects an engine automatically (`backupEngine: "auto"`):

- **pg_dump** — used when no `excludeTables` / `nullifyColumns` transforms are configured. Produces a gzip-compressed SQL file.
- **JavaScript** — fallback when pg_dump is unavailable or when transforms are required. Uses `COPY … FROM stdin` for bulk tables (requires psql on restore) or `INSERT` statements when `backupEngine: "javascript"` is explicitly set.

### Retention policies

Two modes:

| Mode | Config |
|------|--------|
| Count | `{ mode: "count", count: N }` — keep the N newest backup files |
| Tiered | `{ dailyDays, weeklyWeeks, monthlyMonths }` — rolling daily/weekly/monthly windows |

The default policy (`DEFAULT_BACKUP_RETENTION`) keeps 7 daily, 4 weekly, and 1 monthly backup.

### Restore

`runDatabaseRestore` tries `psql` first. If psql is unavailable and the backup file contains AoA statement breakpoints, it falls back to the JavaScript runner (statement-by-statement via the `postgres` client). Legacy backups without breakpoints require psql.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `AOA_PG_DUMP_PATH` | Override path to the `pg_dump` binary |
| `AOA_PSQL_PATH` | Override path to the `psql` binary |
